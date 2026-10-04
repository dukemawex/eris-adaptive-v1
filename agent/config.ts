/**
 * eris-adaptive-v1 — strategy parameters.
 *
 * Every tunable number the strategy uses lives here; the logic modules take a `Params` object and
 * hold no magic constants of their own. A run can override any field without a code change through
 * the roster env `ERIS_ADAPTIVE_PARAMS` (a JSON object, merged one level deep), which is how the
 * experiments in results/experiments.md were run.
 */

export type Regime =
  | "CALM"
  | "DISLOCATION"
  | "SHOCK"
  | "DEPEG"
  | "LIQUIDATION"
  | "UNKNOWN";

export const REGIMES: readonly Regime[] = [
  "CALM",
  "DISLOCATION",
  "SHOCK",
  "DEPEG",
  "LIQUIDATION",
  "UNKNOWN",
];

export type RegimeProfile = {
  /** Extra edge (bps of notional) every trade must clear on top of fees, impact and gas. */
  safetyBps: number;
  /** Weight on the last one-block fair return when extrapolating the (one-block-stale) fair. */
  momentumWeight: number;
  /** slippageBps put on the action: protects against movement between send and inclusion. */
  slippageBps: number;
  /** Largest modelled price impact (bps vs mid) a single trade may take. */
  maxImpactBps: number;
  /** Multiplier on the per-base inventory deviation cap. */
  deviationCapMult: number;
};

export type Params = {
  // ---- regime detector -------------------------------------------------------------------------
  regime: {
    /** Blocks of fair history needed before anything but UNKNOWN is reported. */
    minHistory: number;
    /** |fair return| over `shockWindow` blocks (bps) that marks a SHOCK. */
    shockReturnBps: number;
    shockWindow: number;
    /** Short/long realised-vol ratio that marks a SHOCK even without a large cumulative move. */
    shockVolRatio: number;
    /** Floor on per-block vol (bps) for the ratio test, so a dead-calm market cannot trip it. */
    volFloorBps: number;
    /** Blocks a SHOCK classification is held after its trigger clears (crash windows are 10-30 blocks). */
    shockHoldBlocks: number;
    /** A market-quoted stable this far from $1 (bps) marks DEPEG. */
    depegBps: number;
    /** A venue whose gap to fair exceeds its fee by this many bps marks DISLOCATION. */
    dislocationBps: number;
    /** EWMA half-lives (blocks) for short / long realised vol. */
    volHalfLifeShort: number;
    volHalfLifeLong: number;
  };
  profiles: Record<Regime, RegimeProfile>;

  // ---- execution / gas -------------------------------------------------------------------------
  exec: {
    /** Floor bid (wei/gas). The environment's informed flow bids default + 50..100 mwei (<= 0.2 gwei). */
    minBidWei: string;
    /** Never bid more than this fraction of an opportunity's expected profit on gas. */
    bidProfitFraction: number;
    /** Bid this multiple of the top competitor fee seen in the last block, when affordable. */
    competitorBidMult: number;
    /** Gas units assumed per swap leg / Aave liquidation / Liquity liquidation (for cost only). */
    gasSwap: number;
    gasAaveLiquidation: number;
    gasLiquityLiquidation: number;
    /** Maximum distinct pools traded in one block. */
    maxActionsPerBlock: number;
    /** Blocks to skip a pool after trading it (our tx lands one block later). */
    poolCooldownBlocks: number;
    /** Verify chosen sizes with an on-chain quote (eth_call) before sending. */
    onchainQuotes: boolean;
    /** Upper bound on eth_call quotes per decision. */
    maxQuotesPerBlock: number;
    /** Do not send anything once blocksRemaining is at or below this (a tx sent at 0 lands after the bell). */
    stopAtBlocksRemaining: number;
  };

  // ---- sizing / risk ---------------------------------------------------------------------------
  risk: {
    /** Absolute floor on expected net profit per action (USDC). */
    minNetProfitUsd: number;
    /** Floor on expected net profit / notional (bps). */
    minReturnBps: number;
    /** Fractions of the spendable balance tried as trade sizes, besides the analytic optimum. */
    sizeFractions: number[];
    /** Multiples of the analytic optimum tried as sizes. */
    optimumMultiples: number[];
    /** Hard cap on one trade as a fraction of the input token balance. */
    maxTradeFraction: number;
    /** Hard cap on one trade's notional (USDC). */
    maxTradeUsd: number;
    /** Worst-case loss per action (USDC) = notional x slippageBps; larger trades are shrunk. */
    maxLossPerActionUsd: number;
    /** Per-base inventory deviation (USDC at fair, vs. the opening holding) that cannot be exceeded. */
    maxDeviationUsd: number;
    /** Quadratic inventory penalty: bps of (dev_after^2 - dev_before^2) / deviationScaleUsd. */
    inventoryPenaltyBps: number;
    deviationScaleUsd: number;
    /** USDC kept back from arbitrage while a liquidation target exists (USDC). */
    liquidationReserveUsd: number;
    /** Native ETH below which the agent stops sending (the runtime refills gas from WETH). */
    gasReserveEth: number;
    /** Nominal starting depth of the Balancer/Curve pools in base units, scaled by the observed
     *  Uniswap depth ratio (a liquidityPull thins every venue on the same window). */
    nominalDepthBase: Record<string, number>;
    /** Haircut on modelled depth for venues whose depth is not observed (Balancer/Curve). */
    unobservedDepthHaircut: number;
  };

  // ---- liquidations ----------------------------------------------------------------------------
  liquidation: {
    enabled: boolean;
    /** Aave liquidation bonus on the collateral (bps); WETH = 5% in the deployed market. */
    aaveBonusBps: number;
    /** Share of the bonus Aave sends to the treasury (assumed, conservative). */
    aaveProtocolFeeOfBonus: number;
    /** HF at/below which the full debt is liquidatable (Aave v3 CLOSE_FACTOR_HF_THRESHOLD). */
    fullCloseHf: number;
    minProfitUsd: number;
    /** Collateral / debt asset of the environment's victims (core/src/stressVictims.ts). */
    collateralAsset: string;
    debtAsset: string;
    /** Try liquityLiquidate when the riskiest Trove's ICR is below MCR. */
    liquityEnabled: boolean;
  };

  // ---- logging ---------------------------------------------------------------------------------
  log: {
    heartbeatBlocks: number;
    topCandidates: number;
  };
};

export const DEFAULT_PARAMS: Params = {
  regime: {
    minHistory: 4,
    shockReturnBps: 150,
    shockWindow: 3,
    shockVolRatio: 3,
    volFloorBps: 4,
    shockHoldBlocks: 12,
    depegBps: 100,
    dislocationBps: 25,
    volHalfLifeShort: 3,
    volHalfLifeLong: 40,
  },
  profiles: {
    CALM: { safetyBps: 4, momentumWeight: 0.25, slippageBps: 40, maxImpactBps: 120, deviationCapMult: 1 },
    DISLOCATION: { safetyBps: 4, momentumWeight: 0.25, slippageBps: 50, maxImpactBps: 150, deviationCapMult: 1 },
    SHOCK: { safetyBps: 20, momentumWeight: 1.0, slippageBps: 120, maxImpactBps: 400, deviationCapMult: 1.25 },
    DEPEG: { safetyBps: 8, momentumWeight: 0.25, slippageBps: 50, maxImpactBps: 120, deviationCapMult: 1 },
    LIQUIDATION: { safetyBps: 15, momentumWeight: 1.0, slippageBps: 100, maxImpactBps: 300, deviationCapMult: 1.25 },
    UNKNOWN: { safetyBps: 15, momentumWeight: 0.5, slippageBps: 60, maxImpactBps: 100, deviationCapMult: 0.5 },
  },
  exec: {
    minBidWei: "250000000", // 0.25 gwei: ahead of the environment's flow (<= 0.2 gwei)
    bidProfitFraction: 0.2,
    competitorBidMult: 1.25,
    gasSwap: 220_000,
    gasAaveLiquidation: 450_000,
    gasLiquityLiquidation: 700_000,
    maxActionsPerBlock: 3,
    poolCooldownBlocks: 1,
    onchainQuotes: true,
    maxQuotesPerBlock: 12,
    stopAtBlocksRemaining: 0,
  },
  risk: {
    minNetProfitUsd: 1.5,
    minReturnBps: 2,
    sizeFractions: [0.01, 0.025, 0.05, 0.1, 0.2, 0.35],
    optimumMultiples: [0.35, 0.6, 0.85],
    maxTradeFraction: 0.5,
    maxTradeUsd: 40_000,
    maxLossPerActionUsd: 250,
    maxDeviationUsd: 30_000,
    inventoryPenaltyBps: 15,
    deviationScaleUsd: 10_000,
    liquidationReserveUsd: 12_000,
    gasReserveEth: 0.02,
    nominalDepthBase: { WETH: 1000, WBTC: 50 },
    unobservedDepthHaircut: 0.8,
  },
  liquidation: {
    enabled: true,
    aaveBonusBps: 500,
    aaveProtocolFeeOfBonus: 0.1,
    fullCloseHf: 0.95,
    minProfitUsd: 5,
    collateralAsset: "WETH",
    debtAsset: "USDC",
    liquityEnabled: true,
  },
  log: {
    heartbeatBlocks: 30,
    topCandidates: 3,
  },
};

type Json = Record<string, unknown>;

function isPlainObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge `override` onto `base` (objects merged, everything else replaced). */
export function mergeParams<T>(base: T, override: unknown): T {
  if (!isPlainObject(override) || !isPlainObject(base)) return base;
  const out: Json = { ...(base as Json) };
  for (const [k, v] of Object.entries(override)) {
    if (!(k in out)) continue; // unknown keys are ignored, never invented
    out[k] = isPlainObject(out[k]) && isPlainObject(v) ? mergeParams(out[k], v) : v;
  }
  return out as T;
}

/** Parameters for this process: defaults overlaid with ERIS_ADAPTIVE_PARAMS when it parses. */
export function loadParams(env: Record<string, string | undefined> = process.env): Params {
  const raw = env.ERIS_ADAPTIVE_PARAMS;
  if (!raw) return DEFAULT_PARAMS;
  try {
    return mergeParams(DEFAULT_PARAMS, JSON.parse(raw));
  } catch {
    return DEFAULT_PARAMS;
  }
}
