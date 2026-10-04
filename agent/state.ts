/**
 * Rolling per-run memory. The runtime keeps the strategy's worker alive between normal blocks, so
 * module state persists; it is rebuilt from scratch whenever the run id changes or the worker is
 * reloaded (after a timeout or a revision), which only costs a few blocks of warm-up.
 */
import type { Regime } from "./config.js";

export type PendingTrade = {
  /** Round the decision was made on. */
  round: number;
  /** Expected balance deltas in human units, keyed by token symbol (USDC, WETH, WBTC). */
  expectedDelta: Record<string, number>;
  expectedProfitUsd: number;
  /** Balances (human units) seen when the decision was made. */
  balancesBefore: Record<string, number>;
  /** Fair prices on the decision block. */
  fairBefore: Record<string, number>;
  label: string;
};

export type AgentState = {
  runId: string;
  firstRound: number;
  lastRound: number;
  /** Holdings on the first observation: the do-nothing reference the inventory deviation is measured from. */
  startHoldings: Record<string, number>;
  fairHist: Record<string, number[]>;
  /** EWMA variance of one-block log returns, short and long half-life. */
  varShort: Record<string, number>;
  varLong: Record<string, number>;
  gapHist: Record<string, number[]>;
  /** Uniswap in-range liquidity on the first observation, per base (for the depth ratio). */
  uniL0: Record<string, number>;
  regime: Regime;
  regimeSince: number;
  shockUntil: number;
  /** pool key -> first round it may be traded again. */
  cooldownUntil: Record<string, number>;
  pending: PendingTrade[];
  lastLogRound: number;
  /** Victims (lowercase address) whose liquidation was sent on a round, to avoid duplicate sends. */
  liquidationSentAt: Record<string, number>;
  liquitySentAt: number;
  /** Running totals for the run summary log. */
  stats: {
    decisions: number;
    actions: number;
    expectedProfitUsd: number;
    realizedProfitUsd: number;
    realizedSamples: number;
    liquidations: number;
    rejected: Record<string, number>;
  };
};

export const HISTORY_LEN = 64;

export function freshState(runId: string, round: number): AgentState {
  return {
    runId,
    firstRound: round,
    lastRound: round - 1,
    startHoldings: {},
    fairHist: {},
    varShort: {},
    varLong: {},
    gapHist: {},
    uniL0: {},
    regime: "UNKNOWN",
    regimeSince: round,
    shockUntil: -1,
    cooldownUntil: {},
    pending: [],
    lastLogRound: -1_000_000,
    liquidationSentAt: {},
    liquitySentAt: -1_000_000,
    stats: {
      decisions: 0,
      actions: 0,
      expectedProfitUsd: 0,
      realizedProfitUsd: 0,
      realizedSamples: 0,
      liquidations: 0,
      rejected: {},
    },
  };
}

export function pushBounded(arr: number[], v: number, cap = HISTORY_LEN): void {
  arr.push(v);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

/** EWMA update with a half-life in blocks. */
export function ewma(prev: number | undefined, x: number, halfLife: number): number {
  if (prev === undefined || !Number.isFinite(prev)) return x;
  const a = 1 - Math.pow(0.5, 1 / Math.max(1e-9, halfLife));
  return prev + a * (x - prev);
}

export function bump(rec: Record<string, number>, key: string, by = 1): void {
  rec[key] = (rec[key] ?? 0) + by;
}
