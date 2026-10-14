/**
 * Feature engine: turns one observation plus the rolling state into the numbers every other module
 * reads. Only fields the runtime hands every agent are used (obs.* and nothing else); a missing or
 * malformed field degrades to "unknown" rather than throwing.
 */
import type { AgentObservation } from "@eris/sdk/types.js";
import type { Params } from "./config.js";
import { ewma, pushBounded, type AgentState } from "./state.js";

export type Protocol = "uniswap" | "balancer" | "curve";
export const SWAP_TYPE: Record<Protocol, string> = {
  uniswap: "swap",
  balancer: "balancerSwap",
  curve: "curveSwap",
};

/** Constant-product depth model in human units: base reserve x, USDC reserve y. */
export type Depth = { x: number; y: number; observed: boolean };

export type VenueFeature = {
  key: string; // "<protocol>:<base>"
  protocol: Protocol;
  base: string;
  mid: number; // USDC per base
  feeBps: number; // per-side cost on top of mid
  sellPrice?: number; // executable small-size sell (balancer/curve)
  buyPrice?: number; // executable small-size buy (balancer/curve)
  /** (fair / mid - 1) in bps: positive = the pool is cheap (buy base there). */
  gapBps: number;
  /** |gap| minus the venue fee, bps (positive = an edge exists before impact). */
  netGapBps: number;
  /** Change in gapBps since the previous block. */
  gapVelocityBps: number;
  depth: Depth;
};

export type BaseFeature = {
  base: string;
  decimals: number;
  fair: number;
  /** One-block-ahead extrapolation of the fair (the observed fair is one block stale). */
  forecast: number;
  /** Estimated level the fair reverts to. */
  anchor: number;
  /** Expected fair at the epoch's last block (= fair unless terminal valuation is on). */
  terminal: number;
  /** Fair return over the trend window, bps. */
  trendBps: number;
  ret1Bps: number;
  retWindowBps: number;
  volShortBps: number;
  volLongBps: number;
  balance: number; // human units
  balanceRaw: bigint;
  /** (balance - opening balance) x fair, USDC. */
  deviationUsd: number;
  depthFactor: number;
};

export type StableFeature = { symbol: string; price: number; quoted: boolean; devBps: number };

export type Features = {
  round: number;
  blocksRemaining: number | null;
  historyLen: number;
  bases: Record<string, BaseFeature>;
  venues: VenueFeature[];
  usdc: number;
  usdcRaw: bigint;
  eth: number;
  stables: StableFeature[];
  aaveHf: number | null;
  maxCompetitorFeeWei: bigint;
  defaultFeeWei: bigint;
  maxFeeWei: bigint;
  /** The observation states the participant priority-fee cap (limits.maxPriorityFeePerGasWei). */
  feeCapObserved: boolean;
  valid: boolean;
  invalidReason?: string;
};

const QUOTE = "USDC";

function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function big(v: unknown): bigint {
  try {
    if (typeof v === "string" && /^[0-9]+$/.test(v)) return BigInt(v);
    if (typeof v === "bigint") return v;
  } catch {
    /* fallthrough */
  }
  return 0n;
}

export function toHuman(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/** Uniswap V3 in-range liquidity -> constant-product virtual reserves (human units). */
export function uniswapDepth(liquidity: number, price: number, baseDecimals: number): Depth | null {
  if (!(liquidity > 0) || !(price > 0)) return null;
  const rawPrice = price * 10 ** (6 - baseDecimals); // USDC raw per base raw
  const sqrtP = Math.sqrt(rawPrice);
  const xRaw = liquidity / sqrtP;
  const yRaw = liquidity * sqrtP;
  return { x: xRaw / 10 ** baseDecimals, y: yRaw / 1e6, observed: true };
}

type VenueQuote = {
  price: number;
  sellPrice?: number;
  buyPrice?: number;
  halfSpread?: number;
  fee?: number;
  liquidity?: number;
};

function venueQuote(obs: AgentObservation, base: string, protocol: Protocol): VenueQuote | undefined {
  const p = (obs.protocols ?? {}) as Record<string, any>;
  if (protocol === "uniswap") {
    const pool = base === "WETH" ? p.uniswap?.pool : p.uniswap?.markets?.[`${base}/${QUOTE}`];
    if (!pool) return undefined;
    const price = num(pool.priceUsdcPerWeth);
    if (price === undefined) return undefined;
    return { price, fee: num(pool.fee), liquidity: num(pool.liquidity) };
  }
  const amm = p[protocol];
  const slice = base === "WETH" ? amm : amm?.markets?.[`${base}/${QUOTE}`];
  if (!slice) return undefined;
  const price = num(slice.priceUsdcPerWeth);
  if (price === undefined) return undefined;
  return {
    price,
    sellPrice: num(slice.sellPriceUsdcPerWeth),
    buyPrice: num(slice.buyPriceUsdcPerWeth),
    halfSpread: num(slice.effectiveHalfSpreadBps),
  };
}

function baseBalanceRaw(obs: AgentObservation, base: string): bigint {
  if (base === "WETH") return big(obs.balances?.wethWei);
  return big(obs.baseBalances?.[base]);
}

/**
 * Update the rolling state with this observation and derive the features. Pure apart from the
 * mutation of `st` (which is the point: the state is the history).
 */
export function computeFeatures(obs: AgentObservation, st: AgentState, params: Params): Features {
  const round = num(obs.round) ?? 0;
  const fairs: Record<string, number> = {};
  const raw = (obs.fairPricesUsd ?? { WETH: obs.fairPriceUsdcPerWeth }) as Record<string, unknown>;
  for (const [b, v] of Object.entries(raw ?? {})) {
    const n = num(v);
    if (n !== undefined && n > 0) fairs[b] = n;
  }
  const empty: Features = {
    round,
    blocksRemaining: num(obs.blocksRemaining) ?? null,
    historyLen: 0,
    bases: {},
    venues: [],
    usdc: 0,
    usdcRaw: 0n,
    eth: 0,
    stables: [],
    aaveHf: null,
    maxCompetitorFeeWei: 0n,
    defaultFeeWei: 100_000_000n,
    maxFeeWei: 100_000_000n,
    feeCapObserved: false,
    valid: false,
  };
  if (Object.keys(fairs).length === 0) return { ...empty, invalidReason: "no fair price" };
  if (!obs.balances) return { ...empty, invalidReason: "no balances" };

  const newBlock = round > st.lastRound;
  const bases: Record<string, BaseFeature> = {};
  const order = Object.keys(fairs).sort((a, b) => (a === "WETH" ? -1 : b === "WETH" ? 1 : a < b ? -1 : 1));
  for (const base of order) {
    const fair = fairs[base];
    const hist = (st.fairHist[base] ??= []);
    if (newBlock) {
      const prev = hist[hist.length - 1];
      if (prev !== undefined && prev > 0) {
        const r = Math.log(fair / prev);
        st.varShort[base] = ewma(st.varShort[base], r * r, params.regime.volHalfLifeShort);
        st.varLong[base] = ewma(st.varLong[base], r * r, params.regime.volHalfLifeLong);
      }
      pushBounded(hist, fair);
    }
    const prev1 = hist.length >= 2 ? hist[hist.length - 2] : fair;
    const w = params.regime.shockWindow;
    const prevW = hist.length > w ? hist[hist.length - 1 - w] : hist[0];
    const ret1 = prev1 > 0 ? fair / prev1 - 1 : 0;
    const tw = params.regime.trendWindow;
    const prevT = hist.length > tw ? hist[hist.length - 1 - tw] : hist[0];
    if (st.anchor[base] === undefined) st.anchor[base] = fair;
    else if (newBlock && params.valuation.anchorHalfLife > 0)
      st.anchor[base] = ewma(st.anchor[base], fair, params.valuation.anchorHalfLife);
    const decimals = num(obs.baseDecimals?.[base]) ?? (base === "WBTC" ? 8 : 18);
    const balRaw = baseBalanceRaw(obs, base);
    const balance = toHuman(balRaw, decimals);
    if (st.startHoldings[base] === undefined) st.startHoldings[base] = balance;
    bases[base] = {
      base,
      decimals,
      fair,
      forecast: fair,
      anchor: st.anchor[base],
      terminal: fair,
      trendBps: prevT > 0 ? (fair / prevT - 1) * 1e4 : 0,
      ret1Bps: ret1 * 1e4,
      retWindowBps: prevW > 0 ? (fair / prevW - 1) * 1e4 : 0,
      volShortBps: Math.sqrt(st.varShort[base] ?? 0) * 1e4,
      volLongBps: Math.sqrt(st.varLong[base] ?? 0) * 1e4,
      balance,
      balanceRaw: balRaw,
      deviationUsd: (balance - st.startHoldings[base]) * fair,
      depthFactor: 1,
    };
  }

  // Venues. Uniswap depth is observed (in-range liquidity); Balancer/Curve depth is not in the
  // observation, so it is modelled as the nominal starting depth scaled by Uniswap's depth ratio.
  const venues: VenueFeature[] = [];
  for (const base of order) {
    const bf = bases[base];
    const uq = venueQuote(obs, base, "uniswap");
    if (uq?.liquidity && uq.liquidity > 0) {
      if (st.uniL0[base] === undefined) st.uniL0[base] = uq.liquidity;
      bf.depthFactor = Math.max(0.05, Math.min(2, uq.liquidity / st.uniL0[base]));
    }
    for (const protocol of ["uniswap", "balancer", "curve"] as const) {
      const q = protocol === "uniswap" ? uq : venueQuote(obs, base, protocol);
      if (!q || !(q.price > 0)) continue;
      const twoSided =
        protocol !== "uniswap" &&
        q.halfSpread !== undefined &&
        q.halfSpread >= 0 &&
        q.sellPrice !== undefined &&
        q.buyPrice !== undefined;
      const feeBps =
        protocol === "uniswap"
          ? q.fee && q.fee > 0
            ? q.fee / 100
            : 30
          : twoSided
            ? q.halfSpread!
            : 45;
      const mid = protocol === "uniswap" || twoSided ? q.price : q.price / (1 - feeBps / 1e4);
      let depth: Depth | null = null;
      if (protocol === "uniswap" && q.liquidity) depth = uniswapDepth(q.liquidity, mid, bf.decimals);
      if (!depth) {
        const nominal = params.risk.nominalDepthBase[base] ?? 0;
        const x = nominal * bf.depthFactor * params.risk.unobservedDepthHaircut;
        depth = { x, y: x * mid, observed: false };
      }
      const gapBps = (bf.fair / mid - 1) * 1e4;
      const key = `${protocol}:${base}`;
      const gh = (st.gapHist[key] ??= []);
      const prevGap = gh.length > 0 ? gh[gh.length - 1] : gapBps;
      if (newBlock) pushBounded(gh, gapBps, 16);
      venues.push({
        key,
        protocol,
        base,
        mid,
        feeBps,
        sellPrice: twoSided ? q.sellPrice : undefined,
        buyPrice: twoSided ? q.buyPrice : undefined,
        gapBps,
        netGapBps: Math.abs(gapBps) - feeBps,
        gapVelocityBps: gapBps - prevGap,
        depth,
      });
    }
  }

  const stables: StableFeature[] = [];
  for (const [symbol, s] of Object.entries((obs.balances.stables ?? {}) as Record<string, any>)) {
    if (symbol === "USDC") continue;
    const price = num(s?.priceUsdc);
    if (price === undefined) continue;
    const quoted = s?.marketQuoted === true;
    stables.push({ symbol, price, quoted, devBps: quoted ? (price - 1) * 1e4 : 0 });
  }

  const hfRaw = (obs.protocols as any)?.aave?.healthFactor;
  const hf = typeof hfRaw === "string" && /^[0-9]+$/.test(hfRaw) ? Number(BigInt(hfRaw)) / 1e18 : null;
  const comp = obs.competition as any;
  const usdcRaw = big(obs.balances.usdcUnits);
  if (newBlock) st.lastRound = round;
  return {
    round,
    blocksRemaining: num(obs.blocksRemaining) ?? null,
    historyLen: Math.max(0, ...Object.values(st.fairHist).map((h) => h.length)),
    bases,
    venues,
    usdc: toHuman(usdcRaw, 6),
    usdcRaw,
    eth: toHuman(big(obs.balances.ethWei), 18),
    stables,
    aaveHf: hf !== null && hf < 1e12 ? hf : null,
    maxCompetitorFeeWei: big(comp?.maxCompetitorPriorityFeeWei),
    defaultFeeWei: big(obs.limits?.defaultPriorityFeePerGasWei) || 100_000_000n,
    maxFeeWei: big(obs.limits?.maxPriorityFeePerGasWei) || 100_000_000n,
    feeCapObserved: big(obs.limits?.maxPriorityFeePerGasWei) > 0n,
    valid: true,
  };
}

/** Set each base's forecast fair from its last one-block return and the regime's momentum weight. */
export function applyForecast(f: Features, momentumWeight: number): void {
  for (const b of Object.values(f.bases)) b.forecast = b.fair * (1 + momentumWeight * (b.ret1Bps / 1e4));
}

/**
 * Expected fair at the epoch's final block. The public reference price is an OU walk around an
 * anchor (sdk/src/rng.ts nextFairPrice), with stress overlays that partly heal and drift episodes
 * that sometimes re-anchor. So E[F_T] = A + (F - A) * phi, phi = p + (1 - p) * exp(-kappa * R):
 * `p` is the share of the current deviation assumed permanent (regime-dependent), R the blocks left.
 */
export function terminalFactor(persistence: number, kappa: number, blocksLeft: number): number {
  const p = Math.max(0, Math.min(1, persistence));
  return p + (1 - p) * Math.exp(-Math.max(0, kappa) * Math.max(0, blocksLeft));
}

export function applyValuation(f: Features, persistence: number, params: Params): void {
  const R = f.blocksRemaining ?? params.valuation.defaultHorizon;
  const phi = params.valuation.terminal ? terminalFactor(persistence, params.valuation.kappa, R) : 1;
  for (const b of Object.values(f.bases)) b.terminal = b.anchor + (b.fair - b.anchor) * phi;
}
