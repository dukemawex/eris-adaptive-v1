/**
 * Liquidation engine.
 *
 * Aave v3: the environment hands every agent the addresses of its staged borrowers in
 * ERIS_LIQUIDATION_VICTIMS (core/src/realtime/agentEnv.ts; empty when none were staged). Their
 * health is read with getUserAccountData (a plain view call), and an account below HF 1 is
 * liquidated with `liquidationCall` sent as a rawTx through the runtime, repaying USDC debt for WETH
 * collateral plus the 5% bonus (both per core/src/stressVictims.ts and the deployed reserve config).
 * Close factor: 50% of the debt above HF 0.95, 100% at or below (Aave v3 LiquidationLogic).
 *
 * Liquity: the observation itself carries the riskiest Trove; below MCR it can be liquidated with
 * the dedicated `liquityLiquidate` action, which pays the caller the gas compensation (200 eUSD +
 * 0.5% of the collateral).
 */
import { encodeFunctionData, parseAbi, type Address, type PublicClient } from "viem";
import { AAVE } from "@eris/sdk/constants.js";
import { tokenInfo } from "@eris/sdk/markets.js";
import type { AgentObservation } from "@eris/sdk/types.js";
import type { Params } from "./config.js";
import type { Features } from "./features.js";
import type { Opportunity } from "./opportunity.js";
import { chooseBid, gasUsd, inventoryPenalty } from "./risk.js";
import { toRaw } from "./arbitrage.js";

const accountAbi = parseAbi([
  "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
]);
const liquidationAbi = parseAbi([
  "function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken)",
]);

export type VictimAccount = {
  address: string;
  collateralUsd: number;
  debtUsd: number;
  hf: number;
};

export function victimsFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  return (env.ERIS_LIQUIDATION_VICTIMS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s));
}

export async function readVictims(client: PublicClient, victims: string[]): Promise<VictimAccount[]> {
  const out = await Promise.all(
    victims.map(async (address) => {
      try {
        const acc = (await client.readContract({
          address: AAVE.Pool as Address,
          abi: accountAbi,
          functionName: "getUserAccountData",
          args: [address as Address],
        })) as readonly bigint[];
        const hfRaw = acc[5];
        return {
          address,
          collateralUsd: Number(acc[0]) / 1e8,
          debtUsd: Number(acc[1]) / 1e8,
          hf: hfRaw > 10n ** 30n ? Number.POSITIVE_INFINITY : Number(hfRaw) / 1e18,
        } satisfies VictimAccount;
      } catch {
        return null;
      }
    }),
  );
  return out.filter((v): v is VictimAccount => v !== null);
}

/** Expected economics of liquidating `v` with at most `usdcAvailable` (pure). */
export function evaluateAaveLiquidation(
  v: VictimAccount,
  usdcAvailable: number,
  params: Params,
): { coverUsd: number; collateralUsd: number; grossUsd: number } | null {
  if (!(v.debtUsd > 0) || !(v.hf < 1) || !(usdcAvailable > 0)) return null;
  const p = params.liquidation;
  const bonus = p.aaveBonusBps / 1e4;
  const closeFactor = v.hf <= p.fullCloseHf ? 1 : 0.5;
  const maxByDebt = v.debtUsd * closeFactor;
  const maxByCollateral = v.collateralUsd / (1 + bonus);
  const coverUsd = Math.min(maxByDebt, maxByCollateral, usdcAvailable) * 0.999;
  if (!(coverUsd > 0)) return null;
  const collateralUsd = coverUsd * (1 + bonus * (1 - p.aaveProtocolFeeOfBonus));
  return { coverUsd, collateralUsd, grossUsd: collateralUsd - coverUsd };
}

export function aaveLiquidationOpportunities(
  f: Features,
  victims: VictimAccount[],
  params: Params,
  sentAt: Record<string, number>,
): Opportunity[] {
  const opps: Opportunity[] = [];
  const weth = f.bases[params.liquidation.collateralAsset];
  const ethUsd = f.bases.WETH?.fair ?? 0;
  if (!weth) return opps;
  let usdcLeft = f.usdc - 1; // a dollar of dust headroom
  for (const v of victims) {
    const key = v.address.toLowerCase();
    if ((sentAt[key] ?? -1e9) >= f.round - 1) continue; // our previous send has not been observed yet
    const ev = evaluateAaveLiquidation(v, usdcLeft, params);
    if (!ev) continue;
    const bid = chooseBid(f, params, ev.grossUsd, params.exec.gasAaveLiquidation, ethUsd, true);
    const gas = gasUsd(params.exec.gasAaveLiquidation, bid, ethUsd);
    const net = ev.grossUsd - gas;
    if (net < params.liquidation.minProfitUsd) continue;
    const debtToCover = toRaw(ev.coverUsd, 6);
    const deltaBase = ev.collateralUsd / weth.fair;
    const pen = inventoryPenalty(weth.deviationUsd, deltaBase * weth.fair, params);
    usdcLeft -= ev.coverUsd;
    opps.push({
      id: `aave:${key}`,
      type: "aaveLiquidation",
      protocols: ["aave"],
      assets: [params.liquidation.collateralAsset, params.liquidation.debtAsset],
      locks: [`aave:${key}`],
      capitalUsd: ev.coverUsd,
      grossProfitUsd: ev.grossUsd,
      feesUsd: 0,
      slippageUsd: 0,
      gasUsd: gas,
      safetyUsd: 0,
      netProfitUsd: net,
      returnBps: (net / ev.coverUsd) * 1e4,
      confidence: 0.8,
      riskPenaltyUsd: pen,
      inventoryImpactUsd: { [params.liquidation.collateralAsset]: ev.collateralUsd },
      riskAdjustedUsd: net - Math.max(0, pen),
      bidWei: bid,
      actions: [
        {
          type: "rawTx",
          tx: {
            to: AAVE.Pool,
            data: encodeFunctionData({
              abi: liquidationAbi,
              functionName: "liquidationCall",
              args: [
                tokenInfo(params.liquidation.collateralAsset).address as Address,
                tokenInfo(params.liquidation.debtAsset).address as Address,
                v.address as Address,
                debtToCover,
                false,
              ],
            }),
          },
        },
      ],
      expectedDelta: { USDC: -ev.coverUsd, [params.liquidation.collateralAsset]: deltaBase },
      label: `liquidate ${v.address.slice(0, 10)} hf ${v.hf.toFixed(3)} cover $${ev.coverUsd.toFixed(0)}`,
    });
  }
  return opps;
}

export function liquityLiquidationOpportunity(
  obs: AgentObservation,
  f: Features,
  params: Params,
  lastSent: number,
): Opportunity | null {
  if (!params.liquidation.liquityEnabled) return null;
  const lq = (obs.protocols as any)?.liquity;
  const riskiest = lq?.riskiestTrove;
  const mcr = Number(lq?.mcr);
  const icr = Number(riskiest?.icr);
  if (!riskiest || !(mcr > 0) || !(icr > 0) || !(icr < mcr)) return null;
  if (lastSent >= f.round - 1) return null;
  const ethUsd = f.bases.WETH?.fair ?? 0;
  const eusdPrice = Number(lq?.marketPriceUsdc) > 0 ? Number(lq.marketPriceUsdc) : 1;
  const netDebt = Number(riskiest.netDebtEusdWei ?? "0") / 1e18;
  const compEusd = Number(lq?.gasCompensationEusdWei ?? "200000000000000000000") / 1e18;
  // 0.5% of collateral, collateral ~= icr x total debt (in USD at the reference price).
  const gross = compEusd * eusdPrice + 0.005 * icr * (netDebt + compEusd);
  const bid = chooseBid(f, params, gross, params.exec.gasLiquityLiquidation, ethUsd, true);
  const gas = gasUsd(params.exec.gasLiquityLiquidation, bid, ethUsd);
  const net = gross - gas;
  if (net < params.liquidation.minProfitUsd) return null;
  return {
    id: "liquity:liquidate",
    type: "liquityLiquidation",
    protocols: ["liquity"],
    assets: ["ETH", "EUSD"],
    locks: ["liquity:liquidate"],
    capitalUsd: 0,
    grossProfitUsd: gross,
    feesUsd: 0,
    slippageUsd: 0,
    gasUsd: gas,
    safetyUsd: 0,
    netProfitUsd: net,
    returnBps: 0,
    confidence: 0.7,
    riskPenaltyUsd: 0,
    inventoryImpactUsd: {},
    riskAdjustedUsd: net,
    bidWei: bid,
    actions: [{ type: "liquityLiquidate", maxTroves: 3 }],
    expectedDelta: {},
    label: `liquity liquidate riskiest icr ${icr.toFixed(3)} < mcr ${mcr}`,
  };
}
