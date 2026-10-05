---
kind: improve
name: eris-adaptive-v1
description: Deterministic regime-adaptive arbitrage + liquidation agent; revisions limited to evidence-backed parameter changes.
reviseEveryBlocks: 120
---

This strategy is a deterministic, measured system. The trading path never needs a model, and the
default answer to every revision is to keep it: `{"notes":"<evidence>","executorTs":null}`.

## What this strategy is built on (do not break)

- Scoring marks WETH/WBTC at the reference (fair) price and USDC at $1. A fill below fair when
  buying, or above fair when selling, is profit the moment it lands. Every trade is sized against a
  constant-product model of the venue, confirmed by an exact on-chain quote, and must clear fees,
  price impact, gas and a regime-dependent safety margin *net*.
- The fair price in the observation is one block stale; the strategy extrapolates it with a
  regime-dependent momentum weight and takes the side that pays less (conservative).
- Inventory deviation from the opening basket is capped and penalised quadratically.
- Aave victims (ERIS_LIQUIDATION_VICTIMS) and the riskiest Liquity Trove are liquidated when the
  expected bonus beats gas; a USDC reserve is held back for that while a victim is near HF 1.
- Regimes (CALM / DISLOCATION / SHOCK / DEPEG / LIQUIDATION / UNKNOWN) only change parameters.

## What may change, and what may not

- Do not rewrite the strategy into a single-file heuristic: the replacement body cannot import the
  modules this agent is built from, so a rewrite discards the sizing model, the on-chain quote
  confirmation and the liquidation engine. Prefer `executorTs: null`.
- Never remove the net-profit check, the inventory cap, or the conservative-fair rule.
- Never trade a token whose end-of-epoch value is not marked (launch listings, contracts you deploy).

## Evidence for a revision

- `transactions since the last revision`: many reverted swaps on one venue means the slippage
  tolerance is too tight for that regime; many unmined transactions means the bid is too low.
- `recent decisions`: `trade:` lines carry expected vs `lastRealized` USD. Realized consistently
  below expected across many trades (not one) is the only evidence that the model is mis-sized.
- A loss that coincides with a fair-price move on unchanged inventory is the market, not the
  strategy. Leave it alone.

## Reply

Return JSON only. Keep the code with {"notes":"evidence", "executorTs":null}.
To undo a revision, select a version from the history, e.g. {"notes":"evidence", "revertTo":0}.
