/**
 * AMM pricing model used to size trades before (optionally) confirming them with an on-chain quote.
 *
 * Every venue is modelled as a constant-product pool with the fee taken on the input:
 *   - Uniswap V3: exact for the full-range liquidity the venues are seeded with (virtual reserves
 *     from the observed in-range liquidity and price).
 *   - Balancer 50/50 weighted: exact constant product, depth estimated (not in the observation).
 *   - Curve twocrypto: concentrates liquidity near its price_scale, so constant product over-states
 *     its impact — a conservative approximation.
 */
import type { Depth } from "./features.js";

export type Side = "sell" | "buy"; // sell = base -> USDC, buy = USDC -> base

/** USDC out for selling `q` base. */
export function sellOut(d: Depth, feeBps: number, q: number): number {
  if (!(q > 0) || !(d.x > 0) || !(d.y > 0)) return 0;
  const qf = q * (1 - feeBps / 1e4);
  return (d.y * qf) / (d.x + qf);
}

/** Base out for spending `u` USDC. */
export function buyOut(d: Depth, feeBps: number, u: number): number {
  if (!(u > 0) || !(d.x > 0) || !(d.y > 0)) return 0;
  const uf = u * (1 - feeBps / 1e4);
  return (d.x * uf) / (d.y + uf);
}

/** Base amount that maximises (USDC out - q x fair) when selling into a pool priced above fair. */
export function optimalSell(d: Depth, feeBps: number, fair: number): number {
  const g = 1 - feeBps / 1e4;
  if (!(fair > 0) || !(d.x > 0)) return 0;
  const q = (Math.sqrt((d.x * d.y * g) / fair) - d.x) / g;
  return q > 0 ? q : 0;
}

/** USDC amount that maximises (base out x fair - u) when buying from a pool priced below fair. */
export function optimalBuy(d: Depth, feeBps: number, fair: number): number {
  const g = 1 - feeBps / 1e4;
  if (!(fair > 0) || !(d.y > 0)) return 0;
  const u = (Math.sqrt(fair * d.x * d.y * g) - d.y) / g;
  return u > 0 ? u : 0;
}

/** Average execution shortfall vs mid in bps (fee excluded) for a trade of `amountIn`. */
export function impactBps(d: Depth, side: Side, amountIn: number): number {
  if (!(amountIn > 0) || !(d.x > 0) || !(d.y > 0)) return 0;
  const mid = d.y / d.x;
  if (side === "sell") {
    const exec = sellOut(d, 0, amountIn) / amountIn;
    return (1 - exec / mid) * 1e4;
  }
  const exec = amountIn / buyOut(d, 0, amountIn); // USDC per base paid
  return (exec / mid - 1) * 1e4;
}

/** Re-centre a depth model on an observed mid while keeping its liquidity (sqrt(x*y)). */
export function recenter(d: Depth, mid: number): Depth {
  const k = Math.sqrt(d.x * d.y);
  if (!(k > 0) || !(mid > 0)) return d;
  return { x: k / Math.sqrt(mid), y: k * Math.sqrt(mid), observed: d.observed };
}
