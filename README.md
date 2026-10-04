# eris-adaptive-v1

A deterministic, regime-adaptive cross-protocol agent for the
[Nyx Foundation Eris Agent Simulator](https://github.com/NyxFoundation/eris-agent-simulator)
(ASCON competition). No LLM sits in the block-by-block path; `prompt.md` is the revision policy the
rules require, and it tells the reviser to leave the strategy alone unless the evidence is specific.

Results and the measurement log live in [`results/`](results/):
[`baseline.md`](results/baseline.md) · [`eris-adaptive-v1.md`](results/eris-adaptive-v1.md) ·
[`experiments.md`](results/experiments.md).

## How the simulator scores (what the design follows)

- One epoch = 360 blocks. P = asset value at the last boundary − at the first, WETH/WBTC marked at
  the environment's reference (fair) price, USDC at $1. The ranking is a deviation score of P over
  the field, so a market-wide move cancels; only the difference from everyone else counts.
- Swaps' `minOut` is quoted at send time; `slippageBps` only protects the move between sending and
  inclusion. Price impact is the strategy's to model.
- The reference price is an OU walk around an anchor (`sdk/src/rng.ts`), observed one block late,
  with stress overlays (crash/spike gaps that partly heal) and drift episodes (that sometimes
  re-anchor).

## Architecture (`agent/`, TypeScript `decide()`)

| module | role |
|---|---|
| `config.ts` | every tunable (regime profiles, risk limits, sizing grid, bids, liquidation economics); `ERIS_ADAPTIVE_PARAMS` (JSON) overrides any field |
| `features.ts` | per-block features from the observation only: fair/forecast/anchor/terminal mark per base, realised vol (short/long EWMA), trend, per-venue mid, fee, gap and gap velocity, constant-product depth, balances, inventory deviation vs the opening holding, stables, own Aave HF, competitor fee |
| `regime.ts` | online CALM / DISLOCATION / SHOCK / TREND / DEPEG / LIQUIDATION / UNKNOWN classification |
| `amm.ts` | constant-product pricing, analytic optimal size against a mark, impact |
| `quotes.ts` | exact eth_call quotes (Uniswap QuoterV2, Balancer querySwap, Curve get_dy) |
| `arbitrage.ts` | single legs vs the (conservative) mark on every venue × base, and inventory-neutral two-venue pairs; grid sizing; net of fee, impact, gas and safety |
| `liquidation.ts` | Aave victims (`ERIS_LIQUIDATION_VICTIMS`, read with getUserAccountData → `liquidationCall` rawTx) and the riskiest Liquity Trove (`liquityLiquidate`) |
| `risk.ts` | reserves, inventory cap and quadratic penalty, bids, gas cost |
| `refine.ts` | confirms chosen sizes with exact quotes (and tries a smaller size) |
| `ranker.ts` | ranks by confidence-weighted risk-adjusted EV; picks a non-conflicting set inside budgets |
| `agent.ts` | orchestration, sending, structured logs (regime changes, trades with expected vs realised, heartbeats) |

Python was considered first (the official `my-arb-py` starter), but a Python strategy has no
contract addresses and no RPC client from the SDK, and the Aave liquidation path needs both; the
TypeScript runtime hands `decide()` a read-only `publicClient` and the SDK constants.

## Running it

```bash
scripts/setup-sim.sh            # clone + build the simulator, deploy all venues, bake the state dump
scripts/sync.sh                 # copy agent/ and test/ into the simulator checkout
cd ../nyxfoundation/eris-agent-simulator
node --import tsx --test test/eris-adaptive-v1/*.test.ts
npm run backtest -- --regime calm --seed 101 --agents config/agents/eris-adaptive.yaml --agent-sandbox process
```

`scripts/run-matrix.sh <roster> <scenarios> <port> <tag>` runs a scenario set on its own anvil
(several in parallel), and `scripts/report.py` turns the matrices into the tables in `results/`.

`setup-sim.sh` also works around a container that cannot reach GitHub release assets or
binaries.soliditylang.org: Foundry comes from npm and solc from solcjs behind a native-CLI shim
(`scripts/solc-shim.cjs`, registered for forge and Hardhat).

### Before bundling a submission

`gen:local-constants` rewrites `sdk/src/constants.local.ts` with the addresses of *your* local
deploy. Restore the committed file (`git checkout sdk/src/constants.local.ts`) in the simulator
checkout before `npm run bundle:agent eris-adaptive-v1`, so the bundle carries the operator's
addresses like every other agent.

## Rules this agent keeps

No scenario names, seeds, schedules or other evaluator internals are read; regimes are inferred from
the observation. The only environment input beyond the observation is `ERIS_LIQUIDATION_VICTIMS`,
which the environment hands every agent. No cheatcodes; all sends go through the runtime.
