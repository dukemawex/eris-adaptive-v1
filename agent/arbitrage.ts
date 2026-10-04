/**
 * Cross-venue arbitrage scanner and sizer.
 *
 * Scoring marks WETH/WBTC at the reference (fair) price and USDC at $1, so a fill below fair on the
 * buy side, or above fair on the sell side, is scored profit the moment it lands. Cross-venue
 * arbitrage therefore decomposes into one leg per venue measured against fair ("single"), plus an
 * inventory-neutral two-venue bundle ("pair") for when a single leg would push inventory too far.
 *
 * Nothing executes on a quoted price difference alone: every candidate is sized over a grid and
 * must clear fees, modelled price impact, gas and the regime's safety margin, net.
 */
import { buyOut, impactBps, optimalBuy, optimalSell, sellOut, type Side } from "./amm.js";
import type { Params, Regime, RegimeProfile } from "./config.js";
import { SWAP_TYPE, type Features, type VenueFeature } from "./features.js";
import type { Opportunity, Rejection } from "./opportunity.js";
import { deviationAllowed, deviationCap, gasUsd, inventoryPenalty } from "./risk.js";

export type ScanContext = {
  f: Features;
  params: Params;
  regime: Regime;
  profile: RegimeProfile;
  /** USDC the scanner may spend (after reserves). */
  spendableUsdc: number;
  /** Bid assumed for gas costing (wei/gas). */
  bidWei: bigint;
  /** Pools that may not be traded this block (cooldown). */
  blocked: Set<string>;
};

export function toRaw(human: number, decimals: number): bigint {
  if (!(human > 0) || !Number.isFinite(human)) return 0n;
  // floor at the token's precision; go through a fixed string to avoid float->bigint overflow.
  const scaled = Math.floor(human * 10 ** Math.min(decimals, 12));
  return BigInt(scaled) * 10n ** BigInt(Math.max(0, decimals - 12));
}

function withBase(base: string, a: Record<string, unknown>): Record<string, unknown> {
  return base === "WETH" ? a : { ...a, base };
}

export function slippageFor(profile: RegimeProfile, returnBps: number): number {
  return Math.max(10, Math.min(profile.slippageBps, Math.floor(returnBps)));
}

type Eval = {
  amountIn: number;
  out: number;
  gross: number;
  notional: number;
  impact: number;
  deltaBase: number;
};

/** Evaluate one single-leg trade of `amountIn` (USDC for buy, base for sell) on the model. */
export function evalSingle(v: VenueFeature, side: Side, amountIn: number, fairC: number): Eval {
  if (side === "buy") {
    const out = buyOut(v.depth, v.feeBps, amountIn);
    return {
      amountIn,
      out,
      gross: out * fairC - amountIn,
      notional: amountIn,
      impact: impactBps(v.depth, "buy", amountIn),
      deltaBase: out,
    };
  }
  const out = sellOut(v.depth, v.feeBps, amountIn);
  return {
    amountIn,
    out,
    gross: out - amountIn * fairC,
    notional: amountIn * fairC,
    impact: impactBps(v.depth, "sell", amountIn),
    deltaBase: -amountIn,
  };
}

/**
 * The mark a trade is valued at. Conservative between the stale fair and its one-block
 * extrapolation (whichever pays us less), plus the haircut expected reversion toward the anchor
 * when terminal valuation is on (terminal = fair otherwise, so the reversion term is zero).
 */
export function conservativeFair(
  side: Side,
  fair: number,
  forecast: number,
  terminal: number = fair,
  haircut = 0,
): number {
  const base = side === "buy" ? Math.min(fair, forecast) : Math.max(fair, forecast);
  return base + (terminal - fair) * (1 - haircut);
}

export function markFor(side: Side, b: { fair: number; forecast: number; terminal: number }, params: Params): number {
  return conservativeFair(side, b.fair, b.forecast, b.terminal, params.valuation.haircut);
}

export function singleLegCandidates(sc: ScanContext): { opps: Opportunity[]; rejected: Rejection[] } {
  const { f, params, profile } = sc;
  const opps: Opportunity[] = [];
  const rejected: Rejection[] = [];
  const ethUsd = f.bases.WETH?.fair ?? 0;
  const cap = deviationCap(params, profile);
  const gas = gasUsd(params.exec.gasSwap, sc.bidWei, ethUsd);

  for (const v of f.venues) {
    const bf = f.bases[v.base];
    if (!bf) continue;
    if (sc.blocked.has(v.key)) {
      rejected.push({ key: v.key, reason: "cooldown" });
      continue;
    }
    const side: Side = markFor("buy", bf, params) > v.mid ? "buy" : "sell";
    const fairC = markFor(side, bf, params);
    const edgeBps = (side === "buy" ? fairC / v.mid - 1 : 1 - fairC / v.mid) * 1e4 - v.feeBps;
    if (!(edgeBps > profile.safetyBps)) {
      rejected.push({ key: v.key, reason: "inside fee band" });
      continue;
    }
    const price = v.mid;
    const available = side === "buy" ? sc.spendableUsdc : bf.balance;
    if (!(available > 0)) {
      rejected.push({ key: v.key, reason: side === "buy" ? "no spendable USDC" : `no ${v.base}` });
      continue;
    }
    const unitUsd = side === "buy" ? 1 : price; // USDC per input unit
    const capIn = Math.min(
      available * params.risk.maxTradeFraction,
      params.risk.maxTradeUsd / unitUsd,
      params.risk.maxLossPerActionUsd / (Math.max(10, profile.slippageBps) / 1e4) / unitUsd,
    );
    const opt = side === "buy" ? optimalBuy(v.depth, v.feeBps, fairC) : optimalSell(v.depth, v.feeBps, fairC);
    const sizes = new Set<number>();
    for (const m of params.risk.optimumMultiples) if (opt > 0) sizes.add(Math.min(opt * m, capIn));
    for (const fr of params.risk.sizeFractions) sizes.add(Math.min(available * fr, capIn));

    let best: (Eval & { net: number; pen: number; ra: number; safety: number }) | null = null;
    let lastReason = "no size clears costs";
    for (const amount of [...sizes].sort((a, b) => a - b)) {
      if (!(amount > 0)) continue;
      const e = evalSingle(v, side, amount, fairC);
      if (e.impact > profile.maxImpactBps) {
        lastReason = "impact over limit";
        continue;
      }
      const deltaUsd = e.deltaBase * bf.fair;
      if (!deviationAllowed(bf.deviationUsd, deltaUsd, cap)) {
        lastReason = "inventory cap";
        continue;
      }
      const safety = (e.notional * profile.safetyBps) / 1e4;
      const net = e.gross - gas - safety;
      if (net < params.risk.minNetProfitUsd || (net / e.notional) * 1e4 < params.risk.minReturnBps) continue;
      const pen = inventoryPenalty(bf.deviationUsd, deltaUsd, params);
      const ra = net - pen;
      if (!best || ra > best.ra) best = { ...e, net, pen, ra, safety };
    }
    if (!best || best.ra <= 0) {
      rejected.push({ key: v.key, reason: best ? "inventory penalty" : lastReason });
      continue;
    }
    const decimalsIn = side === "buy" ? 6 : bf.decimals;
    const amountInRaw = toRaw(best.amountIn, decimalsIn);
    if (amountInRaw <= 0n) continue;
    const returnBps = (best.net / best.notional) * 1e4;
    opps.push({
      id: `single:${v.key}:${side}`,
      type: "single",
      protocols: [v.protocol],
      assets: [v.base, "USDC"],
      locks: [v.key],
      capitalUsd: best.notional,
      grossProfitUsd: best.gross,
      feesUsd: (best.notional * v.feeBps) / 1e4,
      slippageUsd: (best.notional * best.impact) / 1e4,
      gasUsd: gas,
      safetyUsd: best.safety,
      netProfitUsd: best.net,
      returnBps,
      confidence: v.depth.observed ? 0.9 : 0.6,
      riskPenaltyUsd: best.pen,
      inventoryImpactUsd: { [v.base]: best.deltaBase * bf.fair },
      riskAdjustedUsd: best.ra,
      bidWei: sc.bidWei,
      actions: [
        withBase(v.base, {
          type: SWAP_TYPE[v.protocol],
          tokenIn: side === "buy" ? "USDC" : v.base,
          amountIn: amountInRaw.toString(),
          slippageBps: slippageFor(profile, returnBps),
        }),
      ],
      expectedDelta:
        side === "buy"
          ? { USDC: -best.amountIn, [v.base]: best.out }
          : { USDC: best.out, [v.base]: -best.amountIn },
      amountInRaw,
      side,
      label: `${side} ${v.base} on ${v.protocol} gap ${v.gapBps.toFixed(1)}bps`,
    });
  }
  return { opps, rejected };
}

/**
 * Inventory-neutral two-venue bundles: buy base on the cheapest venue, sell the same amount on the
 * richest. Fair-independent; evaluated on every ordered venue pair of each base.
 */
export function pairCandidates(sc: ScanContext): { opps: Opportunity[]; rejected: Rejection[] } {
  const { f, params, profile } = sc;
  const opps: Opportunity[] = [];
  const rejected: Rejection[] = [];
  const ethUsd = f.bases.WETH?.fair ?? 0;
  const gas = 2 * gasUsd(params.exec.gasSwap, sc.bidWei, ethUsd);
  const byBase = new Map<string, VenueFeature[]>();
  for (const v of f.venues) {
    const list = byBase.get(v.base) ?? [];
    list.push(v);
    byBase.set(v.base, list);
  }
  for (const [base, venues] of byBase) {
    const bf = f.bases[base];
    if (!bf) continue;
    for (const a of venues) {
      for (const b of venues) {
        if (a === b || !(b.mid > a.mid)) continue;
        const key = `${a.key}>${b.key}`;
        if (sc.blocked.has(a.key) || sc.blocked.has(b.key)) {
          rejected.push({ key, reason: "cooldown" });
          continue;
        }
        const spreadBps = (b.mid / a.mid - 1) * 1e4 - a.feeBps - b.feeBps;
        if (!(spreadBps > profile.safetyBps)) continue; // the common case; not worth a log line
        const depth = Math.min(a.depth.x, b.depth.x);
        let best: { q: number; u: number; out: number; net: number; notional: number; safety: number } | null = null;
        for (const frac of [0.0005, 0.001, 0.002, 0.004, 0.008, 0.016, 0.03]) {
          const q = depth * frac;
          if (!(q > 0) || q >= a.depth.x) continue;
          // USDC needed on venue a to receive q base.
          const uf = (a.depth.y * q) / (a.depth.x - q);
          const u = uf / (1 - a.feeBps / 1e4);
          if (u > sc.spendableUsdc * params.risk.maxTradeFraction || u > params.risk.maxTradeUsd) continue;
          if (impactBps(a.depth, "buy", u) > profile.maxImpactBps) continue;
          const qSell = q * 0.999;
          if (impactBps(b.depth, "sell", qSell) > profile.maxImpactBps) continue;
          const out = sellOut(b.depth, b.feeBps, qSell);
          const notional = u;
          const safety = (notional * profile.safetyBps) / 1e4;
          const net = out + 0.001 * q * bf.fair - u - gas - safety;
          if (!best || net > best.net) best = { q, u, out, net, notional, safety };
        }
        if (!best || best.net < params.risk.minNetProfitUsd) {
          rejected.push({ key, reason: "pair does not clear costs" });
          continue;
        }
        const returnBps = (best.net / best.notional) * 1e4;
        const uRaw = toRaw(best.u, 6);
        const qRaw = toRaw(best.q * 0.999, bf.decimals);
        if (uRaw <= 0n || qRaw <= 0n) continue;
        const slip = slippageFor(profile, returnBps / 2);
        opps.push({
          id: `pair:${key}`,
          type: "pair",
          protocols: [a.protocol, b.protocol],
          assets: [base, "USDC"],
          locks: [a.key, b.key],
          capitalUsd: best.notional,
          grossProfitUsd: best.out - best.u + 0.001 * best.q * bf.fair,
          feesUsd: (best.notional * (a.feeBps + b.feeBps)) / 1e4,
          slippageUsd: 0,
          gasUsd: gas,
          safetyUsd: best.safety,
          netProfitUsd: best.net,
          returnBps,
          confidence: a.depth.observed && b.depth.observed ? 0.85 : 0.55,
          riskPenaltyUsd: 0,
          inventoryImpactUsd: { [base]: 0.001 * best.q * bf.fair },
          riskAdjustedUsd: best.net,
          bidWei: sc.bidWei,
          actions: [
            withBase(base, { type: SWAP_TYPE[a.protocol], tokenIn: "USDC", amountIn: uRaw.toString(), slippageBps: slip }),
            withBase(base, { type: SWAP_TYPE[b.protocol], tokenIn: base, amountIn: qRaw.toString(), slippageBps: slip }),
          ],
          expectedDelta: { USDC: best.out - best.u, [base]: best.q * 0.001 },
          label: `pair ${base} ${a.protocol}->${b.protocol} spread ${spreadBps.toFixed(1)}bps`,
        });
      }
    }
  }
  return { opps, rejected };
}

export { buyOut, sellOut };
