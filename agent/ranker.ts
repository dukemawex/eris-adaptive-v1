/**
 * Opportunity ranker: orders by risk-adjusted expected value (net profit minus the inventory
 * penalty, scaled by confidence) and greedily picks a non-conflicting set that fits the wallet.
 * Gross profit is never the sort key.
 */
import type { Params, RegimeProfile } from "./config.js";
import type { Features } from "./features.js";
import type { Opportunity } from "./opportunity.js";
import { deviationAllowed, deviationCap } from "./risk.js";

export function score(o: Opportunity): number {
  return o.riskAdjustedUsd * o.confidence;
}

export function rank(opps: Opportunity[]): Opportunity[] {
  // Stable, deterministic: ties broken by id.
  return [...opps].sort((a, b) => score(b) - score(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type Selection = { selected: Opportunity[]; skipped: { id: string; reason: string }[] };

export function select(
  ranked: Opportunity[],
  f: Features,
  params: Params,
  profile: RegimeProfile,
  spendableUsdc: number,
  maxActions: number,
): Selection {
  const selected: Opportunity[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const locks = new Set<string>();
  let usdcLeft = spendableUsdc;
  const baseLeft: Record<string, number> = {};
  const dev: Record<string, number> = {};
  for (const [b, bf] of Object.entries(f.bases)) {
    baseLeft[b] = bf.balance;
    dev[b] = bf.deviationUsd;
  }
  const cap = deviationCap(params, profile);
  for (const o of ranked) {
    if (selected.length >= maxActions) break;
    if (!(score(o) > 0)) {
      skipped.push({ id: o.id, reason: "non-positive score" });
      continue;
    }
    if (o.locks.some((l) => locks.has(l))) {
      skipped.push({ id: o.id, reason: "conflicts with a better opportunity" });
      continue;
    }
    const isLiquidation = o.type === "aaveLiquidation" || o.type === "liquityLiquidation";
    const usdcNeed = Math.max(0, -(o.expectedDelta.USDC ?? 0));
    // Liquidations may draw on the reserve that exists for them; arbitrage may not.
    const usdcBudget = isLiquidation ? f.usdc - (spendableUsdc - usdcLeft) : usdcLeft;
    if (usdcNeed > usdcBudget + 1e-9) {
      skipped.push({ id: o.id, reason: "USDC budget" });
      continue;
    }
    let ok = true;
    for (const [asset, d] of Object.entries(o.expectedDelta)) {
      if (asset === "USDC" || !(asset in baseLeft)) continue;
      if (d < 0 && -d > baseLeft[asset] + 1e-12) ok = false;
      if (!isLiquidation && !deviationAllowed(dev[asset], d * f.bases[asset].fair, cap)) ok = false;
    }
    if (!ok) {
      skipped.push({ id: o.id, reason: "inventory budget" });
      continue;
    }
    selected.push(o);
    for (const l of o.locks) locks.add(l);
    usdcLeft -= usdcNeed;
    for (const [asset, d] of Object.entries(o.expectedDelta)) {
      if (asset === "USDC" || !(asset in baseLeft)) continue;
      if (d < 0) baseLeft[asset] += d;
      dev[asset] += d * f.bases[asset].fair;
    }
  }
  return { selected, skipped };
}
