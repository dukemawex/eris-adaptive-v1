/**
 * eris-adaptive-v1 — deterministic, regime-adaptive cross-protocol agent.
 *
 * Every block:  features -> liquidation scan -> regime -> opportunity scan (single legs vs fair,
 * two-venue pairs, Aave/Liquity liquidations) -> size -> confirm with exact quotes -> rank by
 * risk-adjusted EV -> select a non-conflicting set inside the risk limits -> send.
 *
 * No LLM is consulted here. prompt.md exists because the rules require a revision policy; it tells
 * the reviser to leave this code alone unless the evidence is specific.
 */
import type { AgentObservation } from "@eris/sdk/types.js";
import type { AgentContext } from "@eris/sdk/agent.js";
import { loadParams, type Params, type Regime } from "./config.js";
import { applyForecast, applyValuation, computeFeatures, type Features } from "./features.js";
import { classify } from "./regime.js";
import { pairCandidates, singleLegCandidates } from "./arbitrage.js";
import {
  aaveLiquidationOpportunities,
  liquityLiquidationOpportunity,
  readVictims,
  victimsFromEnv,
  type VictimAccount,
} from "./liquidation.js";
import { rank, score, select } from "./ranker.js";
import { refineSingle } from "./refine.js";
import { onchainQuoter, type Quoter } from "./quotes.js";
import { chooseBid, gasStarved, spendableUsdc } from "./risk.js";
import { bump, freshState, type AgentState } from "./state.js";
import type { Opportunity, Rejection } from "./opportunity.js";

const PARAMS: Params = loadParams();
const VICTIMS = victimsFromEnv();
let STATE: AgentState | null = null;

type Ctx = Pick<AgentContext, "log" | "submit"> & { publicClient?: AgentContext["publicClient"] };

export type Decision = {
  regime: Regime;
  submitted: Record<string, unknown>[];
  returned: Record<string, unknown> | null;
  selected: Opportunity[];
  candidates: Opportunity[];
  rejected: Rejection[];
};

function stateFor(obs: AgentObservation): AgentState {
  const runId = String(obs.runId ?? "");
  const round = Number(obs.round ?? 0);
  if (!STATE || STATE.runId !== runId || round < STATE.lastRound - 5) STATE = freshState(runId, round);
  return STATE;
}

/** Test hook: forget the rolling state. */
export function resetState(): void {
  STATE = null;
}

function balancesHuman(f: Features): Record<string, number> {
  const out: Record<string, number> = { USDC: f.usdc };
  for (const b of Object.values(f.bases)) out[b.base] = b.balance;
  return out;
}

/** Compare last decision's expected balance changes with what actually landed. */
function settlePending(st: AgentState, f: Features): Record<string, unknown> | null {
  if (st.pending.length === 0) return null;
  const before = st.pending[0].balancesBefore;
  const now = balancesHuman(f);
  let realized = 0;
  for (const [asset, b] of Object.entries(before)) {
    const d = (now[asset] ?? 0) - b;
    realized += asset === "USDC" ? d : d * (f.bases[asset]?.fair ?? 0);
  }
  const expected = st.pending.reduce((s, p) => s + p.expectedProfitUsd, 0);
  const labels = st.pending.map((p) => p.label);
  // Value change of the traded deltas at the new fair, minus what the unchanged inventory did.
  st.pending = [];
  st.stats.realizedProfitUsd += realized;
  st.stats.realizedSamples++;
  return { expectedUsd: round2(expected), realizedUsd: round2(realized), trades: labels };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function summarizeRejections(rejected: Rejection[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rejected) bump(out, r.reason);
  return out;
}

function brief(o: Opportunity) {
  return {
    id: o.id,
    net: round2(o.netProfitUsd),
    ra: round2(o.riskAdjustedUsd),
    gross: round2(o.grossProfitUsd),
    gas: round2(o.gasUsd),
    capital: Math.round(o.capitalUsd),
    retBps: Math.round(o.returnBps * 10) / 10,
    conf: o.confidence,
  };
}

/**
 * The whole decision as a function of (observation, context, params, state) so tests can drive it
 * without the runtime. `decide` below is the runtime entry point.
 */
export async function decideWith(
  obs: AgentObservation,
  ctx: Ctx,
  params: Params,
  st: AgentState,
  opts: {
    victims?: string[];
    quoter?: Quoter | null;
    readVictimAccounts?: (v: string[]) => Promise<VictimAccount[]>;
    /** Top priority fee bid by another participant in the last block (null when unknown). */
    participantMaxFee?: () => Promise<bigint | null>;
  } = {},
): Promise<Decision> {
  st.stats.decisions++;
  const f = computeFeatures(obs, st, params);
  if (params.exec.readParticipantFees && opts.participantMaxFee) {
    try {
      const fee = await opts.participantMaxFee();
      if (fee !== null) f.maxCompetitorFeeWei = fee;
    } catch {
      /* keep the observation's figure */
    }
  }
  const realized = settlePending(st, f);
  const out: Decision = { regime: "UNKNOWN", submitted: [], returned: null, selected: [], candidates: [], rejected: [] };

  // ---- liquidation scan (also feeds the regime) ----------------------------------------------
  const victimAddrs = opts.victims ?? [];
  let victims: VictimAccount[] = [];
  if (params.liquidation.enabled && victimAddrs.length > 0 && opts.readVictimAccounts) {
    try {
      victims = await opts.readVictimAccounts(victimAddrs);
    } catch {
      victims = [];
    }
  }
  const lq = (obs.protocols as any)?.liquity;
  const liquityLiquidatable =
    Number(lq?.riskiestTrove?.icr) > 0 && Number(lq?.mcr) > 0 && Number(lq.riskiestTrove.icr) < Number(lq.mcr);
  const aaveLiquidatable = victims.some((v) => v.debtUsd > 0 && v.hf < 1);

  const reading = classify(f, st, params, aaveLiquidatable || liquityLiquidatable);
  out.regime = reading.regime;
  if (reading.regime !== st.regime) {
    ctx.log({
      round: f.round,
      reason: `regime ${st.regime} -> ${reading.regime}: ${reading.reasons.join("; ")}`,
      signals: {
        shockMoveBps: round2(reading.shockMoveBps),
        volRatio: round2(reading.volRatio),
        maxNetGapBps: round2(reading.maxNetGapBps),
        maxDepegBps: round2(reading.maxDepegBps),
      },
    });
    st.regime = reading.regime;
    st.regimeSince = f.round;
  }
  if (!f.valid) {
    bump(st.stats.rejected, "invalid observation");
    return out;
  }
  const profile = params.profiles[reading.regime];
  applyForecast(f, profile.momentumWeight);
  if (reading.regime === "SHOCK" || reading.regime === "TREND") st.eventSeen = true;
  const persistence = st.eventSeen
    ? Math.max(profile.persistence, params.valuation.postEventPersistence)
    : profile.persistence;
  applyValuation(f, persistence, params);

  // ---- hard stops -----------------------------------------------------------------------------
  if (f.blocksRemaining !== null && f.blocksRemaining <= params.exec.stopAtBlocksRemaining) {
    if (f.blocksRemaining === 0) logSummary(ctx, st, f, "epoch end");
    return out;
  }
  if (gasStarved(f, params)) {
    bump(st.stats.rejected, "gas reserve");
    return out;
  }

  // ---- capital reserve for liquidations ------------------------------------------------------
  const watched = victims.filter((v) => v.debtUsd > 0 && v.hf < 1.25);
  const reserve = Math.min(params.risk.liquidationReserveUsd, watched.reduce((s, v) => s + v.debtUsd, 0));
  const spendable = spendableUsdc(f, reserve);

  // ---- opportunities ---------------------------------------------------------------------------
  const ethUsd = f.bases.WETH?.fair ?? 0;
  const baseBid = chooseBid(f, params, 0, 0, ethUsd);
  const blocked = new Set(Object.entries(st.cooldownUntil).filter(([, r]) => f.round < r).map(([k]) => k));
  const sc = { f, params, regime: reading.regime, profile, spendableUsdc: spendable, bidWei: baseBid, blocked };
  const singles = singleLegCandidates(sc);
  const pairs = pairCandidates(sc);
  out.rejected.push(...singles.rejected, ...pairs.rejected);
  let candidates = rank([...singles.opps, ...pairs.opps]);

  // Confirm the best few single legs with exact quotes.
  if (opts.quoter && params.exec.onchainQuotes) {
    const refined: Opportunity[] = [];
    let n = 0;
    for (const o of candidates) {
      if (o.type === "single" && n < params.exec.maxActionsPerBlock + 2) {
        n++;
        const r = await refineSingle(o, f, params, profile, opts.quoter);
        if (r) refined.push(r);
        else out.rejected.push({ key: o.locks[0], reason: "exact quote below threshold" });
      } else refined.push(o);
    }
    candidates = rank(refined);
  }

  const liqs = aaveLiquidationOpportunities(f, victims, params, st.liquidationSentAt);
  const lqOpp = liquityLiquidationOpportunity(obs, f, params, st.liquitySentAt);
  if (lqOpp) liqs.push(lqOpp);
  candidates = rank([...liqs, ...candidates]);
  out.candidates = candidates;

  const { selected, skipped } = select(candidates, f, params, profile, spendable, params.exec.maxActionsPerBlock + liqs.length);
  out.selected = selected;
  for (const s of skipped) out.rejected.push({ key: s.id, reason: s.reason });
  for (const r of out.rejected) bump(st.stats.rejected, r.reason);

  // ---- send -----------------------------------------------------------------------------------
  const swapLeaves: Record<string, unknown>[] = [];
  let swapBid = 0n;
  for (const o of selected) {
    if (o.type === "aaveLiquidation" || o.type === "liquityLiquidation") {
      const action = { ...o.actions[0], maxPriorityFeePerGasWei: o.bidWei.toString() };
      ctx.submit(action);
      out.submitted.push(action);
      st.stats.liquidations++;
      if (o.type === "aaveLiquidation") st.liquidationSentAt[o.locks[0].slice(5)] = f.round;
      else st.liquitySentAt = f.round;
    } else {
      const gasUnits = params.exec.gasSwap * o.actions.length;
      const bid = chooseBid(f, params, o.netProfitUsd + o.gasUsd, gasUnits, ethUsd);
      if (bid > swapBid) swapBid = bid;
      swapLeaves.push(...o.actions);
      for (const l of o.locks) st.cooldownUntil[l] = f.round + params.exec.poolCooldownBlocks + 1;
    }
  }
  if (swapLeaves.length === 1) out.returned = { ...swapLeaves[0], maxPriorityFeePerGasWei: swapBid.toString() };
  else if (swapLeaves.length > 1)
    out.returned = { type: "bundle", actions: swapLeaves, maxPriorityFeePerGasWei: swapBid.toString() };

  if (selected.length > 0) {
    const expectedDelta: Record<string, number> = {};
    for (const o of selected)
      for (const [k, v] of Object.entries(o.expectedDelta)) expectedDelta[k] = (expectedDelta[k] ?? 0) + v;
    const expectedProfitUsd = selected.reduce((s, o) => s + o.netProfitUsd, 0);
    st.pending.push({
      round: f.round,
      expectedDelta,
      expectedProfitUsd,
      balancesBefore: balancesHuman(f),
      fairBefore: Object.fromEntries(Object.values(f.bases).map((b) => [b.base, b.fair])),
      label: selected.map((o) => o.id).join("+"),
    });
    st.stats.actions += selected.length;
    st.stats.expectedProfitUsd += expectedProfitUsd;
    ctx.log({
      round: f.round,
      reason: `trade: ${selected.map((o) => o.label).join(" | ")}`,
      action: out.returned ?? out.submitted[0],
      expectedPnlUsdc: round2(expectedProfitUsd),
      state: {
      regime: reading.regime,
      selected: selected.map(brief),
      candidates: candidates.slice(0, params.log.topCandidates).map(brief),
      rejected: summarizeRejections(out.rejected),
      balances: { usdc: round2(f.usdc), ...Object.fromEntries(Object.values(f.bases).map((b) => [b.base, round2(b.balance)])) },
      deviationUsd: Object.fromEntries(Object.values(f.bases).map((b) => [b.base, Math.round(b.deviationUsd)])),
      lastRealized: realized,
      reserveUsd: Math.round(reserve),
      victims: victims.map((v) => ({ a: v.address.slice(0, 10), hf: round2(v.hf), debt: Math.round(v.debtUsd) })),
      },
    });
  } else if (realized || f.round - st.lastLogRound >= params.log.heartbeatBlocks) {
    logSummary(ctx, st, f, "heartbeat", {
      lastRealized: realized,
      bestCandidate: candidates[0] ? brief(candidates[0]) : null,
      rejected: summarizeRejections(out.rejected),
      gaps: Object.fromEntries(f.venues.map((v) => [v.key, round2(v.gapBps)])),
      victims: victims.map((v) => ({ a: v.address.slice(0, 10), hf: round2(v.hf), debt: Math.round(v.debtUsd) })),
    });
  }
  return out;
}

function logSummary(ctx: Ctx, st: AgentState, f: Features, why: string, extra: Record<string, unknown> = {}): void {
  st.lastLogRound = f.round;
  ctx.log({
    round: f.round,
    reason: `${why} (${st.regime})`,
    state: {
    stats: {
      decisions: st.stats.decisions,
      actions: st.stats.actions,
      expectedUsd: round2(st.stats.expectedProfitUsd),
      realizedUsd: round2(st.stats.realizedProfitUsd),
      liquidations: st.stats.liquidations,
    },
    deviationUsd: Object.fromEntries(Object.values(f.bases).map((b) => [b.base, Math.round(b.deviationUsd)])),
    ...extra,
    },
  });
}

export async function decide(obs: AgentObservation, ctx: AgentContext): Promise<Record<string, unknown> | null> {
  const st = stateFor(obs);
  const budget = { left: PARAMS.exec.maxQuotesPerBlock };
  const client = ctx.publicClient;
  const d = await decideWith(obs, ctx, PARAMS, st, {
    victims: VICTIMS,
    quoter: client ? onchainQuoter(client, budget) : null,
    readVictimAccounts: client ? (v) => readVictims(client, v) : undefined,
    participantMaxFee: client
      ? () => participantMaxFee(client, obs, ctx.address, BigInt(obs.limits?.maxPriorityFeePerGasWei ?? "0"))
      : undefined,
  });
  return d.returned;
}

/**
 * Highest priority fee another participant bid in the observed block: mined history only, our own
 * transactions and the environment's system transactions (bid above the participant cap) excluded.
 */
async function participantMaxFee(
  client: NonNullable<AgentContext["publicClient"]>,
  obs: AgentObservation,
  self: string,
  cap: bigint,
): Promise<bigint | null> {
  const block = await client.getBlock({ blockNumber: BigInt(obs.blockNumber), includeTransactions: true });
  let best = 0n;
  for (const tx of block.transactions) {
    if (typeof tx === "string") continue;
    if (tx.from.toLowerCase() === String(self).toLowerCase()) continue;
    const fee = tx.maxPriorityFeePerGas ?? 0n;
    if (cap > 0n && fee > cap) continue;
    if (fee > best) best = fee;
  }
  return best;
}

export { score };
