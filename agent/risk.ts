/**
 * Risk engine: capital reserves, inventory limits/penalties, bids and gas cost. Pure functions.
 */
import type { Params, RegimeProfile } from "./config.js";
import type { Features } from "./features.js";

/** Quadratic penalty for moving a base's inventory deviation from `before` to `before + delta` (USDC). */
export function inventoryPenalty(beforeUsd: number, deltaUsd: number, params: Params): number {
  const after = beforeUsd + deltaUsd;
  const k = params.risk.inventoryPenaltyBps / 1e4;
  return (k * (after * after - beforeUsd * beforeUsd)) / Math.max(1, params.risk.deviationScaleUsd);
}

/** Largest |deviation| (USDC) a trade may leave, unless the trade reduces |deviation|. */
export function deviationCap(params: Params, profile: RegimeProfile): number {
  return params.risk.maxDeviationUsd * profile.deviationCapMult;
}

export function deviationAllowed(beforeUsd: number, deltaUsd: number, cap: number): boolean {
  const after = beforeUsd + deltaUsd;
  return Math.abs(after) <= cap || Math.abs(after) < Math.abs(beforeUsd);
}

/** USDC the arbitrage engine may spend, after the liquidation reserve. */
export function spendableUsdc(f: Features, reserveUsd: number): number {
  return Math.max(0, f.usdc - Math.max(0, reserveUsd));
}

export function gasUsd(gasUnits: number, bidWei: bigint, ethUsd: number): number {
  return (gasUnits * Number(bidWei) * ethUsd) / 1e18;
}

/**
 * Priority fee: at least the floor that lands ahead of the environment's flow, raised to beat the
 * top competitor bid seen last block, but never more than `bidProfitFraction` of the expected
 * profit, and always inside [default, max] (the runtime rejects a bid over the cap).
 */
export function chooseBid(
  f: Features,
  params: Params,
  expectedProfitUsd: number,
  gasUnits: number,
  ethUsd: number,
  aggressive = false,
): bigint {
  const floor = BigInt(params.exec.minBidWei);
  const lo = f.defaultFeeWei;
  const hi = f.maxFeeWei >= lo ? f.maxFeeWei : lo;
  let bid = floor > lo ? floor : lo;
  let compRaw = f.maxCompetitorFeeWei;
  // The environment's oracle/keeper transactions bid above the participant cap; they are not rivals.
  if (params.exec.ignoreSystemFees && compRaw > hi) compRaw = 0n;
  const comp = BigInt(Math.floor(Number(compRaw) * params.exec.competitorBidMult));
  if (comp > bid) bid = comp;
  if (aggressive) bid = hi;
  // Profit ceiling (wei per gas).
  if (ethUsd > 0 && gasUnits > 0 && expectedProfitUsd > 0) {
    const ceilWei = BigInt(
      Math.floor(((expectedProfitUsd * params.exec.bidProfitFraction) / ethUsd / gasUnits) * 1e18),
    );
    if (expectedProfitUsd >= params.exec.aggressiveProfitUsd && ceilWei > bid) bid = ceilWei;
    if (bid > ceilWei) bid = ceilWei;
  }
  if (bid < lo) bid = lo;
  if (bid > hi) bid = hi;
  return bid;
}

/** True when the wallet holds too little native ETH to keep sending safely. */
export function gasStarved(f: Features, params: Params): boolean {
  return f.eth < params.risk.gasReserveEth;
}
