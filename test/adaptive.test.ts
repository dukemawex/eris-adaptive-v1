// eris-adaptive-v1 strategy tests. Run from the simulator root after scripts/sync.sh:
//   node --import tsx --test test/eris-adaptive-v1/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PARAMS, mergeParams, loadParams, type Params } from "../../example/agents/eris-adaptive-v1/config.js";
import { computeFeatures, uniswapDepth, applyForecast } from "../../example/agents/eris-adaptive-v1/features.js";
import { classify } from "../../example/agents/eris-adaptive-v1/regime.js";
import { optimalBuy, optimalSell, sellOut, buyOut, impactBps } from "../../example/agents/eris-adaptive-v1/amm.js";
import { singleLegCandidates, pairCandidates, toRaw, type ScanContext } from "../../example/agents/eris-adaptive-v1/arbitrage.js";
import { evaluateAaveLiquidation, aaveLiquidationOpportunities, liquityLiquidationOpportunity, victimsFromEnv } from "../../example/agents/eris-adaptive-v1/liquidation.js";
import { rank, select, score } from "../../example/agents/eris-adaptive-v1/ranker.js";
import { chooseBid, inventoryPenalty, spendableUsdc, deviationAllowed } from "../../example/agents/eris-adaptive-v1/risk.js";
import { decideWith } from "../../example/agents/eris-adaptive-v1/agent.js";
import { freshState } from "../../example/agents/eris-adaptive-v1/state.js";
import type { Opportunity } from "../../example/agents/eris-adaptive-v1/opportunity.js";
import { fakeCtx, makeObs, type FixtureOpts } from "./fixtures.js";

const P: Params = DEFAULT_PARAMS;

/** Features after `warm` identical calm blocks then the given block. */
function featuresAfter(last: FixtureOpts, warm = 6, base: FixtureOpts = {}) {
  const st = freshState("run-test", 1);
  for (let r = 1; r <= warm; r++) computeFeatures(makeObs({ ...base, round: r }), st, P);
  const f = computeFeatures(makeObs({ ...base, ...last, round: warm + 1 }), st, P);
  return { st, f };
}

function scan(f: ReturnType<typeof featuresAfter>["f"], regime: "CALM" | "SHOCK" = "CALM", spendable?: number): ScanContext {
  const profile = P.profiles[regime];
  applyForecast(f, profile.momentumWeight);
  return { f, params: P, regime, profile, spendableUsdc: spendable ?? f.usdc, bidWei: 250_000_000n, blocked: new Set() };
}

// ---------------------------------------------------------------- AMM model
test("uniswap depth from liquidity reproduces the seeded 1,000 WETH / 3M USDC pool", () => {
  const d = uniswapDepth(Number("54772255750516611"), 3000, 18)!;
  assert.ok(Math.abs(d.x - 1000) < 0.01, `x=${d.x}`);
  assert.ok(Math.abs(d.y - 3_000_000) < 50, `y=${d.y}`);
});

test("analytic optimum maximises profit vs fair on the model", () => {
  const d = { x: 1000, y: 1000 * 2950, observed: true }; // pool 1.7% below a 3000 fair
  const u = optimalBuy(d, 30, 3000);
  const profit = (amt: number) => buyOut(d, 30, amt) * 3000 - amt;
  assert.ok(u > 0);
  assert.ok(profit(u) >= profit(u * 0.9) && profit(u) >= profit(u * 1.1));
  const q = optimalSell({ x: 1000, y: 1000 * 3050, observed: true }, 30, 3000);
  const sp = (amt: number) => sellOut({ x: 1000, y: 3_050_000, observed: true }, 30, amt) - amt * 3000;
  assert.ok(q > 0 && sp(q) >= sp(q * 0.9) && sp(q) >= sp(q * 1.1));
  assert.ok(impactBps(d, "sell", 10) > impactBps(d, "sell", 1));
});

// ---------------------------------------------------------------- arbitrage detection
test("detects a buy when a venue trades well below fair, net of fee/impact/gas", () => {
  const { f } = featuresAfter({ uni: 2940 }); // 2% cheap
  const { opps } = singleLegCandidates(scan(f));
  const o = opps.find((x) => x.id === "single:uniswap:WETH:buy");
  assert.ok(o, "expected a uniswap buy");
  assert.ok(o!.netProfitUsd > 0);
  assert.equal(o!.actions[0].type, "swap");
  assert.equal(o!.actions[0].tokenIn, "USDC");
  assert.ok(o!.netProfitUsd < o!.grossProfitUsd, "net must deduct gas and safety");
});

test("detects a sell on a rich venue and attaches base for WBTC", () => {
  const { f } = featuresAfter({ uniWbtc: 61500 }); // 2.5% rich
  const { opps } = singleLegCandidates(scan(f));
  const o = opps.find((x) => x.id === "single:uniswap:WBTC:sell");
  assert.ok(o);
  assert.equal(o!.actions[0].tokenIn, "WBTC");
  assert.equal(o!.actions[0].base, "WBTC");
});

test("no trade when the gap is inside the fee band", () => {
  const { f } = featuresAfter({ uni: 2993 }); // ~23bps cheap, fee 30bps
  const { opps, rejected } = singleLegCandidates(scan(f));
  assert.equal(opps.filter((o) => o.locks[0] === "uniswap:WETH").length, 0);
  assert.ok(rejected.some((r) => r.key === "uniswap:WETH" && r.reason === "inside fee band"));
});

test("no trade when the gap barely clears the fee but impact+gas+safety eat it", () => {
  const { f } = featuresAfter({ uni: 2989.5 }); // ~35bps cheap: 5bps over fee, safety 4bps
  const { opps } = singleLegCandidates(scan(f));
  assert.equal(opps.filter((o) => o.locks[0] === "uniswap:WETH").length, 0);
});

// ---------------------------------------------------------------- sizing
test("position size is bounded and grows with the edge, never the whole balance", () => {
  const small = singleLegCandidates(scan(featuresAfter({ uni: 2970 }).f)).opps.find((o) => o.id.startsWith("single:uniswap:WETH"))!;
  const big = singleLegCandidates(scan(featuresAfter({ uni: 2900 }).f)).opps.find((o) => o.id.startsWith("single:uniswap:WETH"))!;
  assert.ok(small && big);
  assert.ok(big.capitalUsd > small.capitalUsd, `${big.capitalUsd} > ${small.capitalUsd}`);
  assert.ok(big.capitalUsd <= 25000 * P.risk.maxTradeFraction + 1e-6);
  assert.ok(small.capitalUsd < 25000);
});

test("thin books (liquidity pulled) shrink the size", () => {
  const deep = singleLegCandidates(scan(featuresAfter({ uni: 2940 }).f)).opps.find((o) => o.id.startsWith("single:uniswap:WETH"))!;
  const thin = singleLegCandidates(scan(featuresAfter({ uni: 2940, liquidityScale: 0.4 }).f)).opps.find((o) =>
    o.id.startsWith("single:uniswap:WETH"),
  )!;
  assert.ok(thin.capitalUsd < deep.capitalUsd);
});

test("toRaw floors to token precision", () => {
  assert.equal(toRaw(1.5, 6), 1_500_000n);
  assert.equal(toRaw(0.123456789, 18), 123456789000000000n);
  assert.equal(toRaw(-1, 6), 0n);
  assert.equal(toRaw(Number.NaN, 6), 0n);
});

// ---------------------------------------------------------------- inventory risk
test("inventory penalty rewards trades that reduce deviation", () => {
  assert.ok(inventoryPenalty(10_000, -5_000, P) < 0);
  assert.ok(inventoryPenalty(10_000, 5_000, P) > 0);
  assert.ok(deviationAllowed(40_000, -5_000, 30_000), "reducing an over-cap position is allowed");
  assert.ok(!deviationAllowed(25_000, 10_000, 30_000));
});

test("inventory cap blocks a buy that would push WETH exposure over the limit", () => {
  const p = mergeParams(P, { risk: { maxDeviationUsd: 1000 } });
  const st = freshState("r", 1);
  for (let r = 1; r <= 6; r++) computeFeatures(makeObs({ round: r }), st, p);
  const f = computeFeatures(makeObs({ round: 7, uni: 2900 }), st, p);
  const profile = p.profiles.CALM;
  applyForecast(f, profile.momentumWeight);
  const sc: ScanContext = { f, params: p, regime: "CALM", profile, spendableUsdc: f.usdc, bidWei: 250_000_000n, blocked: new Set() };
  const o = singleLegCandidates(sc).opps.find((x) => x.id === "single:uniswap:WETH:buy");
  if (o) assert.ok(Math.abs(o.inventoryImpactUsd.WETH) <= 1000 + 1e-6);
});

// ---------------------------------------------------------------- regime
test("regime: UNKNOWN without history, CALM in a quiet market", () => {
  const st = freshState("r", 1);
  const f1 = computeFeatures(makeObs({ round: 1 }), st, P);
  assert.equal(classify(f1, st, P, false).regime, "UNKNOWN");
  const { st: st2, f } = featuresAfter({});
  assert.equal(classify(f, st2, P, false).regime, "CALM");
});

test("regime: SHOCK on a large fair move, held for a while after", () => {
  const { st, f } = featuresAfter({ fair: 2850, uni: 3000, bal: 3000, curve: 3000 });
  assert.equal(classify(f, st, P, false).regime, "SHOCK");
  const f2 = computeFeatures(makeObs({ round: 8, fair: 2850, uni: 2850, bal: 2850, curve: 2850 }), st, P);
  assert.equal(classify(f2, st, P, false).regime, "SHOCK", "held");
});

test("regime: DEPEG when a market-quoted stable is off par", () => {
  const { st, f } = featuresAfter({ daiPrice: 0.97 });
  assert.equal(classify(f, st, P, false).regime, "DEPEG");
});

test("regime: DISLOCATION when a venue is far outside its fee band", () => {
  const { st, f } = featuresAfter({ bal: 2940 });
  assert.equal(classify(f, st, P, false).regime, "DISLOCATION");
});

test("regime: LIQUIDATION takes priority", () => {
  const { st, f } = featuresAfter({ fair: 2850 });
  assert.equal(classify(f, st, P, true).regime, "LIQUIDATION");
});

// ---------------------------------------------------------------- liquidation
test("Aave liquidation economics: close factor, bonus, USDC limit", () => {
  const half = evaluateAaveLiquidation({ address: "0x1", collateralUsd: 13000, debtUsd: 11250, hf: 0.97 }, 25000, P)!;
  assert.ok(Math.abs(half.coverUsd - 11250 * 0.5 * 0.999) < 1e-6);
  assert.ok(Math.abs(half.grossUsd / half.coverUsd - 0.05 * 0.9) < 1e-9);
  const full = evaluateAaveLiquidation({ address: "0x1", collateralUsd: 13000, debtUsd: 11250, hf: 0.9 }, 25000, P)!;
  assert.ok(full.coverUsd > half.coverUsd);
  const capped = evaluateAaveLiquidation({ address: "0x1", collateralUsd: 13000, debtUsd: 11250, hf: 0.9 }, 2000, P)!;
  assert.ok(capped.coverUsd <= 2000);
  assert.equal(evaluateAaveLiquidation({ address: "0x1", collateralUsd: 13000, debtUsd: 11250, hf: 1.02 }, 25000, P), null);
  assert.equal(evaluateAaveLiquidation({ address: "0x1", collateralUsd: 13000, debtUsd: 0, hf: 0.5 }, 25000, P), null);
});

test("Aave liquidation opportunity encodes liquidationCall and bids aggressively", () => {
  const { f } = featuresAfter({});
  const v = "0x00000000000000000000000000000000000000bb";
  const opps = aaveLiquidationOpportunities(f, [{ address: v, collateralUsd: 13000, debtUsd: 11250, hf: 0.96 }], P, {});
  assert.equal(opps.length, 1);
  const tx = opps[0].actions[0].tx as { data: string };
  assert.equal(opps[0].actions[0].type, "rawTx");
  assert.ok(tx.data.startsWith("0x00a718a9"), "liquidationCall selector");
  assert.equal(opps[0].bidWei, 5_000_000_000n);
  assert.ok(opps[0].netProfitUsd > 200);
  // not re-sent on the very next block
  const again = aaveLiquidationOpportunities(f, [{ address: v, collateralUsd: 13000, debtUsd: 11250, hf: 0.96 }], P, { [v]: f.round });
  assert.equal(again.length, 0);
});

test("Liquity: riskiest trove below MCR yields a liquidate action; above does not", () => {
  const { f } = featuresAfter({});
  const below = liquityLiquidationOpportunity(makeObs({ liquityRiskiestIcr: 1.05 }), f, P, -1000);
  assert.ok(below && below.actions[0].type === "liquityLiquidate");
  assert.equal(liquityLiquidationOpportunity(makeObs({ liquityRiskiestIcr: 1.2 }), f, P, -1000), null);
});

test("victims env parsing ignores garbage", () => {
  assert.deepEqual(victimsFromEnv({ ERIS_LIQUIDATION_VICTIMS: " 0x00000000000000000000000000000000000000aa,bad, " }), [
    "0x00000000000000000000000000000000000000aa",
  ]);
  assert.deepEqual(victimsFromEnv({}), []);
});

// ---------------------------------------------------------------- ranking
function opp(id: string, net: number, gross: number, pen = 0, locks = [id], usdc = -100): Opportunity {
  return {
    id, type: "single", protocols: [], assets: [], locks, capitalUsd: 100, grossProfitUsd: gross, feesUsd: 0, slippageUsd: 0,
    gasUsd: 0, safetyUsd: 0, netProfitUsd: net, returnBps: net, confidence: 1, riskPenaltyUsd: pen,
    inventoryImpactUsd: {}, riskAdjustedUsd: net - pen, bidWei: 0n, actions: [], expectedDelta: { USDC: usdc }, label: id,
  };
}

test("ranking uses risk-adjusted EV, not gross profit", () => {
  const ranked = rank([opp("a", 10, 100, 9), opp("b", 5, 6)]);
  assert.equal(ranked[0].id, "b");
  assert.ok(score(ranked[0]) > score(ranked[1]));
});

test("selection skips conflicting pools and respects the USDC budget", () => {
  const { f } = featuresAfter({});
  const ranked = rank([opp("x", 9, 9, 0, ["uniswap:WETH"]), opp("y", 8, 8, 0, ["uniswap:WETH"]), opp("z", 7, 7, 0, ["curve:WETH"], -1e9)]);
  const { selected, skipped } = select(ranked, f, P, P.profiles.CALM, f.usdc, 3);
  assert.deepEqual(selected.map((o) => o.id), ["x"]);
  assert.ok(skipped.some((s) => s.id === "y" && /conflict/.test(s.reason)));
  assert.ok(skipped.some((s) => s.id === "z" && /USDC/.test(s.reason)));
});

// ---------------------------------------------------------------- reserves / bids
test("capital reserve: spendable USDC excludes the liquidation reserve", () => {
  const { f } = featuresAfter({});
  assert.equal(spendableUsdc(f, 12000), 13000);
  assert.equal(spendableUsdc(f, 40000), 0);
});

test("reserve enforced end-to-end: buys never dip into USDC held for a near-HF-1 victim", async () => {
  const st = freshState("run-test", 1);
  const ctx = fakeCtx();
  const victim = { address: "0x00000000000000000000000000000000000000cc", collateralUsd: 15000, debtUsd: 11250, hf: 1.05 };
  for (let r = 1; r <= 6; r++)
    await decideWith(makeObs({ round: r }), ctx, P, st, { victims: [victim.address], readVictimAccounts: async () => [victim] });
  const d = await decideWith(makeObs({ round: 7, uni: 2800, bal: 2800, curve: 2800, usdc: 15000 }), ctx, P, st, {
    victims: [victim.address],
    readVictimAccounts: async () => [victim],
  });
  const spent = d.selected.reduce((s, o) => s + Math.max(0, -(o.expectedDelta.USDC ?? 0)), 0);
  assert.ok(spent <= 15000 - 11250 + 1e-6, `spent ${spent}`);
});

test("bids: floor beats environment flow, capped by profit and the runtime max", () => {
  const { f } = featuresAfter({});
  assert.equal(chooseBid(f, P, 0, 0, 3000), 250_000_000n);
  const { f: f2 } = featuresAfter({ competitorFeeWei: "1000000000" });
  assert.equal(chooseBid(f2, P, 1000, 220_000, 3000), 1_250_000_000n);
  assert.equal(chooseBid(f2, P, 0.01, 220_000, 3000), 100_000_000n, "tiny profit -> default fee");
  assert.equal(chooseBid(f2, P, 1e9, 220_000, 3000, true), 5_000_000_000n);
});

// ---------------------------------------------------------------- pairs
test("pair candidates are inventory-neutral two-leg bundles", () => {
  const { f } = featuresAfter({ uni: 2930, bal: 3070 });
  const { opps } = pairCandidates(scan(f));
  const o = opps.find((x) => x.id === "pair:uniswap:WETH>balancer:WETH");
  assert.ok(o);
  assert.equal(o!.actions.length, 2);
  assert.ok(Math.abs(o!.inventoryImpactUsd.WETH) < 0.01 * o!.capitalUsd);
});

// ---------------------------------------------------------------- robustness
test("malformed observations never throw and never trade", async () => {
  const st = freshState("x", 1);
  const ctx = fakeCtx();
  const broken: unknown[] = [
    { ...makeObs({ round: 1 }), fairPriceUsdcPerWeth: Number.NaN, fairPricesUsd: undefined },
    { ...makeObs({ round: 2 }), protocols: {} },
    { ...makeObs({ round: 3 }), balances: undefined },
    { ...makeObs({ round: 4 }), protocols: { uniswap: { pool: { priceUsdcPerWeth: "nope", liquidity: "x" } } } },
    { round: 5 },
  ];
  for (const o of broken) {
    const d = await decideWith(o as never, ctx, P, st, {});
    assert.equal(d.returned, null);
    assert.equal(d.submitted.length, 0);
  }
});

test("no sends on the final block", async () => {
  const st = freshState("x", 1);
  const ctx = fakeCtx();
  for (let r = 1; r <= 6; r++) await decideWith(makeObs({ round: r }), ctx, P, st, {});
  const d = await decideWith(makeObs({ round: 7, uni: 2800, blocksRemaining: 0 }), ctx, P, st, {});
  assert.equal(d.returned, null);
});

test("deterministic: the same observation sequence gives the same actions", async () => {
  const seq: FixtureOpts[] = [{}, {}, {}, {}, {}, { uni: 2950 }, { uni: 2960, bal: 3060 }, { fair: 2900 }, { fair: 2800, uni: 2950 }];
  const runOnce = async () => {
    const st = freshState("det", 1);
    const ctx = fakeCtx();
    const out: unknown[] = [];
    for (let i = 0; i < seq.length; i++) out.push((await decideWith(makeObs({ ...seq[i], round: i + 1, runId: "det" }), ctx, P, st, {})).returned);
    return JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  };
  assert.equal(await runOnce(), await runOnce());
});

test("params: env override merges known keys only", () => {
  const p = loadParams({ ERIS_ADAPTIVE_PARAMS: JSON.stringify({ risk: { minNetProfitUsd: 9, bogus: 1 }, nope: {} }) });
  assert.equal(p.risk.minNetProfitUsd, 9);
  assert.equal(p.risk.maxTradeFraction, DEFAULT_PARAMS.risk.maxTradeFraction);
  assert.ok(!("bogus" in p.risk) && !("nope" in p));
  assert.equal(loadParams({ ERIS_ADAPTIVE_PARAMS: "{not json" }), DEFAULT_PARAMS);
});

// ---------------------------------------------------------------- terminal valuation (E1)
import { terminalFactor, applyValuation } from "../../example/agents/eris-adaptive-v1/features.js";
import { markFor } from "../../example/agents/eris-adaptive-v1/arbitrage.js";

test("terminal factor: 1 at the bell, persistence far from it", () => {
  assert.equal(terminalFactor(0.2, 0.02, 0), 1);
  assert.ok(Math.abs(terminalFactor(0.2, 0.02, 1e6) - 0.2) < 1e-12);
  assert.ok(terminalFactor(0.2, 0.02, 50) > terminalFactor(0.2, 0.02, 100));
  assert.equal(terminalFactor(1, 0.02, 300), 1);
});

test("terminal valuation off: marks equal the conservative fair", () => {
  const { f } = featuresAfter({ fair: 2950 }, 6);
  applyValuation(f, 0.2, P);
  assert.equal(f.bases.WETH.terminal, f.bases.WETH.fair);
});

test("terminal valuation on: a fair below its anchor marks WETH up toward the anchor", () => {
  const p = mergeParams(P, { valuation: { terminal: true } });
  const st = freshState("v", 1);
  for (let r = 1; r <= 6; r++) computeFeatures(makeObs({ round: r, fair: 3000 }), st, p);
  const f = computeFeatures(makeObs({ round: 7, fair: 2950, blocksRemaining: 300 }), st, p);
  applyForecast(f, 0);
  applyValuation(f, 0.2, p);
  const b = f.bases.WETH;
  assert.equal(b.anchor, 3000);
  assert.ok(b.terminal > b.fair && b.terminal < 3000);
  assert.ok(markFor("buy", b, p) > b.fair, "buy mark includes haircut reversion");
});

test("regime: TREND on a slow sustained drift", () => {
  const st = freshState("t", 1);
  let f = computeFeatures(makeObs({ round: 1 }), st, P);
  for (let r = 1; r <= 14; r++) {
    const fair = 3000 * (1 + 0.0018 * r);
    f = computeFeatures(makeObs({ round: r, fair, uni: fair, bal: fair, curve: fair }), st, P);
  }
  assert.equal(classify(f, st, P, false).regime, "TREND");
});

test("E2 bids: system fees above the cap are not rivals; big edges bid their ceiling", () => {
  const p = mergeParams(P, { exec: { ignoreSystemFees: true, aggressiveProfitUsd: 25 } });
  const { f } = featuresAfter({ competitorFeeWei: "6000000000" }); // the oracle's 6 gwei
  assert.equal(chooseBid(f, p, 5, 220_000, 3000), 250_000_000n, "small edge: floor");
  assert.equal(chooseBid(f, P, 5, 220_000, 3000) > 250_000_000n, true, "V1 chased the oracle");
  const big = chooseBid(f, p, 100, 220_000, 3000);
  assert.ok(big > 1_000_000_000n && big <= 5_000_000_000n, `big ${big}`);
});
