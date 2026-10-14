/**
 * The one shape every opportunity is reduced to before ranking, whatever produced it.
 */
export type OpportunityType = "single" | "pair" | "aaveLiquidation" | "liquityLiquidation";

export type Opportunity = {
  id: string;
  type: OpportunityType;
  protocols: string[];
  assets: string[];
  /** Pools (or accounts) the opportunity consumes; two opportunities sharing one conflict. */
  locks: string[];
  /** USDC notional committed. */
  capitalUsd: number;
  /** Value gained at the (conservative) fair before fees, impact, gas and safety. */
  grossProfitUsd: number;
  feesUsd: number;
  slippageUsd: number;
  gasUsd: number;
  safetyUsd: number;
  netProfitUsd: number;
  /** netProfit / capital, bps. */
  returnBps: number;
  /** 0..1: how much of the model the estimate rests on (1 = confirmed by an exact on-chain quote). */
  confidence: number;
  /** Inventory penalty (USDC) charged by the risk engine. */
  riskPenaltyUsd: number;
  /** Change in per-base inventory deviation, USDC at fair. */
  inventoryImpactUsd: Record<string, number>;
  /** What the ranker sorts on. */
  riskAdjustedUsd: number;
  /** Priority fee to bid (wei per gas). */
  bidWei: bigint;
  /** Wire-format leaf actions (one per transaction). */
  actions: Record<string, unknown>[];
  /** Expected balance changes in human units (USDC / base symbols). */
  expectedDelta: Record<string, number>;
  /** Raw amount in of the first leg, for re-quoting. */
  amountInRaw?: bigint;
  side?: "buy" | "sell";
  label: string;
};

export type Rejection = { key: string; reason: string };
