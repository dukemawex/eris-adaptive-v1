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
- Audit against the simulator's own labels (blocks.csv `role`, never visible to agents): see the
  measurements; the first 18 baseline runs had 54,512 mined above-cap transactions, all `system`, none
  from participants, and no `system` transaction at or below the cap.

Verdict: legitimate; the approach is kept.

**Measurements.** Pending (runs queued after baseline and V1).

**Decision.** Pending.

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

**Measurements.** Pending (runs queued after E2).

**Decision.** Pending. E2+E3 is run only if both E2 and E3 independently pass the promotion rule.
