// Synthetic observations in the runtime's wire shape (sdk/src/types.ts AgentObservation).
import type { AgentObservation } from "@eris/sdk/types.js";

export type FixtureOpts = {
  round?: number;
  runId?: string;
  fair?: number;
  fairWbtc?: number;
  uni?: number; // uniswap WETH mid
  bal?: number; // balancer WETH mid
  curve?: number; // curve WETH mid
  uniWbtc?: number;
  liquidityScale?: number; // 1 = the seeded 1,000 WETH / 3M USDC full range
  usdc?: number;
  weth?: number;
  wbtc?: number;
  eth?: number;
  daiPrice?: number;
  blocksRemaining?: number;
  liquityRiskiestIcr?: number;
  competitorFeeWei?: string;
};

/** Uniswap in-range liquidity for a full-range pool of `x` base / `x*price` USDC. */
export function uniLiquidity(xBase: number, price: number, baseDecimals = 18): string {
  const xRaw = xBase * 10 ** baseDecimals;
  const yRaw = xBase * price * 1e6;
  return BigInt(Math.floor(Math.sqrt(xRaw * yRaw))).toString();
}

function twoSided(mid: number, halfSpreadBps = 30) {
  return {
    priceUsdcPerWeth: mid,
    sellPriceUsdcPerWeth: mid * (1 - halfSpreadBps / 1e4),
    buyPriceUsdcPerWeth: mid * (1 + halfSpreadBps / 1e4),
    effectiveHalfSpreadBps: halfSpreadBps,
  };
}

export function makeObs(o: FixtureOpts = {}): AgentObservation {
  const fair = o.fair ?? 3000;
  const fairWbtc = o.fairWbtc ?? 60000;
  const uni = o.uni ?? fair;
  const bal = o.bal ?? fair;
  const curve = o.curve ?? fair;
  const uniWbtc = o.uniWbtc ?? fairWbtc;
  const scale = o.liquidityScale ?? 1;
  const usdc = o.usdc ?? 25000;
  const weth = o.weth ?? 8;
  const wbtc = o.wbtc ?? 0.4;
  const obs: Record<string, unknown> = {
    kind: "observation",
    runId: o.runId ?? "run-test",
    round: o.round ?? 100,
    blockNumber: String(o.round ?? 100),
    agentAddress: "0x0000000000000000000000000000000000000001",
    fairPriceUsdcPerWeth: fair,
    oraclePrices: { wethUsd: fair, usdcUsd: 1 },
    fairPricesUsd: { WETH: fair, WBTC: fairWbtc },
    baseBalances: { WBTC: String(Math.round(wbtc * 1e8)) },
    baseDecimals: { WETH: 18, WBTC: 8 },
    blocksRemaining: o.blocksRemaining ?? 200,
    balances: {
      ethWei: BigInt(Math.round((o.eth ?? 1) * 1e6)) * 10n ** 12n + "",
      wethWei: BigInt(Math.round(weth * 1e6)) * 10n ** 12n + "",
      usdcUnits: String(Math.round(usdc * 1e6)),
      stables: {
        USDC: { token: "0x01", decimals: 6, balance: String(Math.round(usdc * 1e6)), priceUsdc: 1, marketQuoted: false },
        DAI: { token: "0x02", decimals: 18, balance: "0", priceUsdc: o.daiPrice ?? 1, marketQuoted: o.daiPrice !== undefined },
      },
    },
    inventory: { valueUsdc: usdc + weth * fair, weth, usdc, eth: o.eth ?? 1 },
    history: [],
    limits: { defaultPriorityFeePerGasWei: "100000000", maxPriorityFeePerGasWei: "5000000000", defaultSlippageBps: 50 },
    protocols: {
      uniswap: {
        pool: { pair: "WETH/USDC", fee: 3000, priceUsdcPerWeth: uni, tick: 0, tickSpacing: 60, liquidity: uniLiquidity(1000 * scale, uni) },
        positions: [],
        markets: {
          "WBTC/USDC": { pair: "WBTC/USDC", fee: 3000, priceUsdcPerWeth: uniWbtc, tick: 0, tickSpacing: 60, liquidity: uniLiquidity(50 * scale, uniWbtc, 8) },
        },
      },
      balancer: { ...twoSided(bal, 30), markets: { "WBTC/USDC": twoSided(fairWbtc, 30) } },
      curve: { ...twoSided(curve, 35), markets: { "WBTC/USDC": twoSided(fairWbtc, 35) } },
      ...(o.liquityRiskiestIcr !== undefined
        ? {
            liquity: {
              mcr: 1.1,
              ccr: 1.5,
              recoveryMode: false,
              marketPriceUsdc: 0.98,
              gasCompensationEusdWei: "200000000000000000000",
              riskiestTrove: { owner: "0x00000000000000000000000000000000000000aa", icr: o.liquityRiskiestIcr, netDebtEusdWei: "20000000000000000000000" },
            },
          }
        : {}),
    },
    competition: {
      maxCompetitorPriorityFeeWei: o.competitorFeeWei ?? "0",
      maxBlockPriorityFeeWei: "0",
      lastTxIndex: null,
      recentRevertRate: 0,
      recentSampleSize: 0,
    },
  };
  return obs as unknown as AgentObservation;
}

export type Logged = { logs: unknown[]; submits: Record<string, unknown>[] };

export function fakeCtx(): Logged & { log(e: unknown): void; submit(a: Record<string, unknown>): void } {
  const logs: unknown[] = [];
  const submits: Record<string, unknown>[] = [];
  return {
    logs,
    submits,
    log: (e: unknown) => void logs.push(e),
    submit: (a: Record<string, unknown>) => void submits.push(a),
  };
}
