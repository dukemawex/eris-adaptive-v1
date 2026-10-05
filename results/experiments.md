# Experiments

Each entry: hypothesis → exact change → measurements → decision. **The champion stays V1** until a
challenger wins on measured results. Promotion rule (all three required, on the 60 public scenarios,
12 regimes × seeds 101–505, paired against V1 on the same scenarios):

1. aggregate improves: total P and median P both higher than V1's;
2. the worst case does not materially worsen: worst-scenario P and every regime's worst scenario
   no more than max($100, 10% of V1's absolute value) below V1's;
3. robustness holds: no more scenarios with negative P than V1, reverted transactions not higher.

Arms are measured in isolation (the do-nothing benchmark plus one agent per run, `rosters/`), one
fresh anvil per scenario from the state dump. Tables come from `scripts/compare.py`.

The vuln-pool path is deferred until the core arbitrage / risk / bidding agent is robust across
scenarios; nothing here is tuned to the public `vuln` scenario.

## Arms

| arm | roster | agent dir | params |
|---|---|---|---|
| baseline | `eris-baseline.yaml` | `my-arb-py` (official starter, frozen) | – |
| V1 (champion) | `eris-v1.yaml` | `eris-adaptive-v1i` | defaults |
| E2 | `eris-e2.yaml` | `eris-adaptive-e2` | `exec.ignoreSystemFees`, `exec.readParticipantFees` |
| E3 | `eris-e3.yaml` | `eris-adaptive-e3` | `exec.scanGas: "sent"` |

`eris-adaptive-v1i` is the instrumented V1: with default flags it sends exactly what the committed V1
(`9cfff86`) sends (equivalence check: 20 synthetic 60-block sequences at competitor fees 0, 0.15, 1
and 6 gwei, every `returned` / `submitted` identical); it additionally logs cumulative candidate and
rejection counts at epoch end. E1 (terminal valuation) is not part of this batch.

## Baseline vs V1 (60 public scenarios, measured 2026-10-04)

| arm | total P | median | mean | worst | negative | stdev | reverts | gas USD | tx |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline (my-arb-py) | 49,545 | 467 | 826 | −1,407 | 19 | 1,567 | 61 | 728 | 20,709 |
| V1 | 182,764 | 2,076 | 3,046 | −689 | 2 | 2,882 | 1 | 12,350 | 8,252 |

V1 is higher in 57 of 60 paired scenarios (lower: calm#404, cex-drift#101, cex-drift#505). Worst per
regime (baseline → V1): calm −1,030 → 90, cdp-incident −1,009 → 1,719, cex-drift 2,779 → 2,514, crash
−1,371 → 1,623, depeg −136 → 708, depeg-persist −1,378 → 716, informed-flow 117 → 1,602, launch −890 →
−689, lending-incident −36 → 3,085, spike −1,407 → −45, vuln −241 → 345, whale 478 → 5,493. V1's two
negative scenarios are launch#404 (−689) and spike#404 (−45).

V1's gas spend is 6.8% of its P (17× the baseline's spend for 3.7× its P), the motivation for E2.
V1's rejection reasons, summed over blocks and venues: inside fee band 55,111; no size clears costs
39,324; cooldown 22,499; pair does not clear costs 15,970; inventory penalty 10,566; inventory cap
6,605; no spendable USDC 2,769. "No size clears costs" is where the scanner's gas assumption (E3) bites.
Runtime rejections: 0 in both arms.

## Run-to-run noise (V1 re-run, measured 2026-10-05)

The same agent on the same scenario does not give the same P: blocks are mined in real time (2 s), so
whether a transaction lands in the next block or the one after depends on wall-clock timing, and the
environment flow reacts to the prices our trades leave. V1 re-run unchanged (`rosters/eris-v1rep.yaml`)
on the 12 regimes at seed 101 plus informed-flow#202:

| scenario | V1 | V1 re-run | Δ |
|---|---:|---:|---:|
| calm#101 | 1,141 | 1,633 | +493 |
| cdp-incident#101 | 1,831 | 1,831 | 0 |
| cex-drift#101 | 3,625 | 3,699 | +74 |
| crash#101 | 1,623 | 1,679 | +56 |
| depeg#101 | 1,410 | 1,188 | −222 |
| depeg-persist#101 | 1,240 | 672 | −568 |
| informed-flow#101 | 3,199 | 2,140 | −1,059 |
| informed-flow#202 | 1,602 | −285 | −1,887 |
| launch#101 | 527 | 636 | +109 |
| lending-incident#101 | 6,061 | 6,364 | +303 |
| spike#101 | 4,037 | 5,351 | +1,314 |
| vuln#101 | 787 | 787 | 0 |
| whale#101 | 11,544 | 13,108 | +1,565 |

Median |Δ| 303, SD of Δ 859 USDC per scenario. Some scenarios reproduce exactly (cdp-incident#101,
vuln#101; E2's informed-flow#202 gave −86 twice), others swing by more than 1,000.

Consequence for the promotion rule: a single run per scenario resolves an arm's *aggregate* (60
scenarios, SD of the mean difference about 859/√60 ≈ 110) but not its per-scenario or per-regime worst
case: a −1,887 swing on one scenario is within V1's own noise. The rule is kept as written; where a
criterion fails on a single scenario, the decision says whether that scenario's gap is outside the
noise measured here, and such scenarios are re-run before the decision is final.

---

## E2: competitor-bid estimator excludes system transactions

**Hypothesis.** V1 chases the oracle. In the public regimes the environment's oracle/keeper
transactions are mined at 6 gwei, above the 5 gwei participant cap, and they are in nearly every
block, so `obs.competition.maxCompetitorPriorityFeeWei` is about 6 gwei; V1's bid is
`min(1.25 × that, cap, 20% of expected profit)`, i.e. it pays up to the cap (or 20% of profit) for
position it cannot win (system transactions are ordered first regardless) and does not need against
the real rivals (environment flow at ≤ 0.2 gwei). Excluding fees that cannot be a participant's should
cut gas spend with no loss of inclusion, raising P.

**Exact change** (`agent/risk.ts` `chooseBid`, `agent/agent.ts` `participantMaxFee`, flags in
`agent/config.ts`):

- `exec.ignoreSystemFees: true` — an observed competitor fee above `obs.limits.maxPriorityFeePerGasWei`
  is treated as 0, *only when the observation states the cap* (`features.feeCapObserved`); otherwise
  the 0.1 gwei fallback cap would be a guess and the filter stays off.
- `exec.readParticipantFees: true` — the competitor fee is re-read from the observed block through
  `ctx.publicClient.getBlock(..., includeTransactions)`: highest `maxPriorityFeePerGas` among
  transactions not from our address and not above the stated cap.
- The scanner keeps V1's gas assumption (`exec.scanGas: "v1"` computes it from the *unfiltered*
  observation figure), so E2 changes only what is sent. `aggressiveProfitUsd` stays off.

**Legitimacy (from the agent's observable information only).**

- Inputs: `obs.limits.maxPriorityFeePerGasWei` (the observation), the observed block's transactions
  via `ctx.publicClient` (documented as permitted read-only queries: competition-start.en.md §"What the
  observation does not carry"; the observation's own competitor figure is computed the same way,
  `example/agents/runtime/send.ts`), and our own address.
- The rule needs no address list, role label, scenario name or other simulator internal. It follows
  from the public fee rule: participant transactions with a priority fee over
  `limits.maxPriorityFeePerGasWei` are rejected at the RPC gateway and by the runtime
  (docs/spec/03-market.md §fee rule, docs/spec/05-agent-contract.md §5.5 item 3, competition-start
  "rejected before signing"). A mined fee above the cap therefore cannot be a participant's.
- Profile check: the public regimes run `economicGas: false` (cap 5 gwei, system transactions above
  it, docs/spec/02-runtime.md §2.2). Under `economicGas: true` the stated cap is 10^18 and the rule
  never fires, so it degrades to V1's behaviour rather than to a wrong estimate.
- Audit against the simulator's own labels (blocks.csv `role`, never visible to agents), over the 120
  baseline and V1 runs: 469,858 mined transactions above the cap. 468,740 are `system` (oracle /
  keeper); the other 1,118 are the `launch` regime's environment flow (`uninformed-flow`, owners
  `flow-launch*`, token-launch waves, all at 6 gwei). None is a competing agent's. No `system`
  transaction was mined at or below the cap. Correction to the first version of this note, which said
  every above-cap fee was a system transaction: the rule is "a fee above the cap is not a participant's
  and cannot be outbid", not "it is a system transaction". Since a participant cannot bid above the
  cap, chasing such a fee buys no position in either case.

Verdict: legitimate; the approach is kept.

**Measurements (first pass, 60 scenarios, one run each).**

| arm | total P | median | mean | worst | negative | stdev | reverts | runtime rejects | gas USD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| V1 | 182,764 | 2,076 | 3,046 | −689 | 2 | 2,882 | 1 | 0 | 12,350 |
| E2 | 185,557 | 2,141 | 3,093 | −352 | 3 | 2,811 | 2 | 2 | 832 |

Paired: E2 higher in 41, lower in 19; median diff +165, total +2,792. Gas saved 11,518 (≈ +192 per
scenario); the rest of the P difference (−8,726 total, about 1.3 standard errors at the measured
noise) is not distinguishable from run-to-run noise. Worst per regime (V1 → E2): calm 90 → 707,
cdp-incident 1,719 → 1,520, cex-drift 2,514 → 2,066, crash 1,623 → 1,148, depeg 708 → 839,
depeg-persist 716 → 1,067, informed-flow 1,602 → −86, launch −689 → −352, lending-incident 3,085 →
3,251, spike −45 → −122, vuln 345 → 983, whale 5,493 → 5,647.

Inclusion check (informed-flow#202, blocks.csv): V1 bid 5.0 gwei (median), E2 0.25 gwei; the highest
environment-flow bid was 0.199 gwei. In both arms no non-system transaction was ever ordered ahead of
ours, so E2 gave up no block position; its losses there are not an ordering effect.

Rule, first pass: (1) passes; (2) overall worst passes, but cdp-incident, cex-drift, crash and
informed-flow fall more than the tolerance; (3) fails narrowly (negative 3 vs 2, reverts 2 vs 1).

**Re-run protocol (fixed before the re-runs).** Flagged scenarios: the worst-per-regime scenario of
each arm in a failing regime, every negative scenario and every scenario with a revert:
cdp-incident#303, cex-drift#505, crash#101, informed-flow#202, launch#404, spike#404, whale#101. Each
is brought to two runs per arm (tags `v1rep` / `e2rep`); each arm's P on a flagged scenario becomes the
mean of its two runs, and criteria 2 and 3 are re-evaluated on those values (reverts as the mean per
run). Criterion 1 stays on the first pass. No further re-runs after this round.

**Re-runs (two runs per arm on each flagged scenario).**

| scenario | V1 runs | E2 runs | reverts V1 / E2 |
|---|---|---|---|
| cdp-incident#303 | 1,719 / 1,253 | 1,520 / 1,979 | 0,0 / 0,0 |
| cex-drift#505 | 2,514 / 1,904 | 2,066 / 2,066 | 0,0 / 0,0 |
| crash#101 | 1,623 / 1,679 | 1,148 / 1,855 | 0,0 / 0,0 |
| informed-flow#202 | 1,602 / −285 | −86 / −86 | 0,1 / 1,1 |
| launch#404 | −689 / −864 | −352 / −32 | 0,0 / 0,0 |
| spike#404 | −45 / −45 | −122 / 153 | 1,1 / 0,1 |
| whale#101 | 11,544 / 13,108 | 10,889 / 13,039 | 0,0 / 1,0 |

With flagged scenarios at the mean of their two runs: overall worst V1 −776, E2 −192; every regime's
worst within tolerance **except informed-flow** (V1 658, E2 −86; tolerance 100); negative scenarios 2 vs
2; reverts (mean per run) **1.5 vs 2.0**.

**Diagnosis.** In informed-flow#202, V1's re-run and both E2 runs made the identical 106 trades
(same blocks, ids and amounts) and mined the identical 152 transactions with identical statuses,
including the one revert; V1 scored −285, E2 −86, the +199 being gas (0.0718 → 0.0046 ETH). V1's
1,602 came from its first run taking a different path (95 trades). Across all runs, 17 of the 60
scenarios have a V1 run and an E2 run with an identical trade path; on every one E2 is ahead, by +158
to +236 (exactly the gas saved). E2 never trades differently from V1 given the same path; the
per-scenario failures above are path noise, and so are the reverts (the same reverts occur on the same
path in both arms).

**Decision: not promoted under the rule as written** (criterion 2 fails on informed-flow, criterion 3
fails on reverts 2.0 vs 1.5). V1 stays champion. The evidence that E2 is a strict improvement (lower
gas, unchanged ordering and trades) is strong; promoting it would mean changing the rule after seeing
the results, which is left to the owner, not done here. A rule that compares arms on matched paths,
or with more runs per scenario, would settle it on measurements.

---

## E3: scanner gas cost from the bid actually sent

**Finding (the "5 gwei scanner assumption").** The scanner costs every candidate at
`chooseBid(f, params, 0, 0)`: expected profit 0 means no profit ceiling, so the bid is
`min(cap, max(0.25 gwei floor, 1.25 × observed competitor fee))`. With the oracle at 6 gwei in the
observed block this is the 5 gwei cap: 220k gas × 5 gwei × $3,000 ≈ $3.30 per leg, $6.60 per pair.
The sender, however, attaches `chooseBid(f, params, net + gas, units)`, capped at 20% of the expected
profit, so a candidate with a $5 edge would actually pay ≤ $1 of gas. The scanner therefore rejects
edges whose real cost would have cleared, and over-states the cost of every edge it keeps.

**What gas / priority-fee information an agent can observe.**

| source | field | what it says |
|---|---|---|
| observation | `limits.defaultPriorityFeePerGasWei` | the runtime's default tip (0.1 gwei) |
| observation | `limits.maxPriorityFeePerGasWei` | the participant cap (5 gwei; 10^18 under economicGas) |
| observation | `competition.maxCompetitorPriorityFeeWei` | highest tip by anyone else in the last mined block (includes system txs) |
| observation | `competition.recentRevertRate`, `lastTxIndex` | own recent reverts, own last position |
| `ctx.publicClient` | `getBlock(n, includeTransactions)` | every mined tx's tip, sender, gas limit; receipts give `gasUsed` |
| chain | base fee | 0 (anvil `--base-fee 0`), so cost = gasUsed × tip |

Ordering is by tip (with `maxFeePerGas ≤ tip` enforced), system transactions are always first, so
the tip only orders us against other participants and environment flow. Nothing observable says
an opportunity must be paid at the cap; the cap is an upper bound, not a price.

**Hypothesis.** Costing each candidate at the bid the sender will actually attach (same estimator,
same profit ceiling) admits small edges V1 rejects and ranks kept edges by their true net, raising
total P; the sent bids themselves are unchanged.

**Exact change.** `exec.scanGas: "sent"`: for each size the scanner evaluates, gas =
`gasUsd(units, chooseBid(f, params, gross − safety, units))` (single leg: 1 × 220k gas; pair: 2 ×),
the same call and arguments the sender uses (`net + gas = gross − safety`). Bidding unchanged (V1's
estimator, unfiltered). Exact-quote refinement keeps the scan-time gas figure.

**Measurements (60 scenarios, one run each).**

| arm | total P | median | mean | worst | negative | stdev | reverts | runtime rejects | gas USD | tx | selected |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| V1 | 182,764 | 2,076 | 3,046 | −689 | 2 | 2,882 | 1 | 0 | 12,350 | 8,252 | 7,675 |
| E3 | 182,648 | 2,070 | 3,044 | −494 | 1 | 3,077 | 6 | 4 | 14,194 | 12,933 | 11,812 |

Paired: E3 higher in 33, lower in 27; median diff +57, total −116. Worst per regime (V1 → E3): calm
90 → 122, cdp-incident 1,719 → 1,179, cex-drift 2,514 → 3,258, crash 1,623 → 713, depeg 708 → 434,
depeg-persist 716 → 569, informed-flow 1,602 → 422, launch −689 → −494, lending-incident 3,085 →
3,136, spike −45 → 132, vuln 345 → 265, whale 5,493 → 6,266.

**What happened.** The scanner change did what it was meant to: "no size clears costs" fell from
39,324 to 30,581 and "pair does not clear costs" from 15,970 to 11,443, so E3 found and sent 54% more
opportunities. They did not add P. The agent's own epoch-end accounting shows why: E3 took 31% more
trades (8,708 vs 6,657 opportunities) but its summed *expected* profit is lower (188,678 vs 209,960).
Every trade puts its pool on cooldown for the next block and uses one of the three per-block slots;
"cooldown" rejections rose from 22,499 to 34,772. The extra small edges are taken first and crowd out
the larger edges that appear a block later on the same pool. Gas also rose ($14,194 vs $12,350), since
bidding stayed V1's.

**Decision: not promoted.** Criterion 1 fails on the first pass (total and median both below V1);
re-runs cannot change criterion 1 under the protocol. E2+E3 is not run (E3 did not pass on its own).

**Follow-up hypothesis (not tested).** The 5 gwei assumption was acting as an implicit minimum-edge
filter that protects pool capacity. A scanner cost that is right per trade needs an opportunity cost
for the cooldown and the per-block slot, e.g. a minimum net per pool-block, before smaller edges help.
