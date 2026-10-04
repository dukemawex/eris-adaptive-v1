/**
 * Confirm modelled single-leg sizes with exact on-chain quotes. The model chooses the size; the
 * quote decides whether it is still worth sending, and whether a smaller size is better.
 */
import type { Params, RegimeProfile } from "./config.js";
import type { Features } from "./features.js";
import type { Opportunity } from "./opportunity.js";
import type { Quoter } from "./quotes.js";
import { conservativeFair, slippageFor } from "./arbitrage.js";
import { inventoryPenalty } from "./risk.js";

export async function refineSingle(
  o: Opportunity,
  f: Features,
  params: Params,
  profile: RegimeProfile,
  quoter: Quoter,
): Promise<Opportunity | null> {
  if (o.type !== "single" || !o.amountInRaw || !o.side) return o;
  const [protocol, base] = o.locks[0].split(":") as ["uniswap" | "balancer" | "curve", string];
  const bf = f.bases[base];
  if (!bf) return o;
  const side = o.side;
  const fairC = conservativeFair(side, bf.fair, bf.forecast);
  const decIn = side === "buy" ? 6 : bf.decimals;
  const decOut = side === "buy" ? bf.decimals : 6;

  let best: { raw: bigint; amountIn: number; out: number; net: number; gross: number; notional: number } | null = null;
  for (const mult of [1, 0.6]) {
    const raw = mult === 1 ? o.amountInRaw : (o.amountInRaw * 6n) / 10n;
    if (raw <= 0n) continue;
    const outRaw = await quoter(protocol, base, side, raw);
    if (outRaw === null) {
      if (mult === 1) return { ...o, confidence: Math.min(o.confidence, 0.5) }; // no quote: model only
      continue;
    }
    const amountIn = Number(raw) / 10 ** decIn;
    const out = Number(outRaw) / 10 ** decOut;
    const gross = side === "buy" ? out * fairC - amountIn : out - amountIn * fairC;
    const notional = side === "buy" ? amountIn : amountIn * fairC;
    const safety = (notional * profile.safetyBps) / 1e4;
    const net = gross - o.gasUsd - safety;
    if (!best || net > best.net) best = { raw, amountIn, out, net, gross, notional };
    if (mult === 1 && net <= 0) continue; // a losing full size may still have a winning smaller one
  }
  if (!best || best.net < params.risk.minNetProfitUsd) return null;
  const returnBps = (best.net / best.notional) * 1e4;
  if (returnBps < params.risk.minReturnBps) return null;
  const deltaBase = side === "buy" ? best.out : -best.amountIn;
  const pen = inventoryPenalty(bf.deviationUsd, deltaBase * bf.fair, params);
  const action = { ...o.actions[0], amountIn: best.raw.toString(), slippageBps: slippageFor(profile, returnBps) };
  return {
    ...o,
    amountInRaw: best.raw,
    capitalUsd: best.notional,
    grossProfitUsd: best.gross,
    netProfitUsd: best.net,
    returnBps,
    confidence: 1,
    riskPenaltyUsd: pen,
    riskAdjustedUsd: best.net - pen,
    inventoryImpactUsd: { [base]: deltaBase * bf.fair },
    actions: [action],
    expectedDelta: side === "buy" ? { USDC: -best.amountIn, [base]: best.out } : { USDC: best.out, [base]: -best.amountIn },
  };
}
