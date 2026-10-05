#!/usr/bin/env bash
# Run scenarios one per anvil (a fresh anvil from the state dump per scenario, which is what the
# backtest's snapshot/revert is equivalent to), so anvil's on-disk history spill never accumulates
# across scenarios. Skips scenarios whose result already exists for this tag.
#   scripts/run-singles.sh <roster.yaml> <port> <tag> <regime:seed>...
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROSTER="$1"; PORT="$2"; TAG="$3"; shift 3
for item in "$@"; do
  r="${item%%:*}"; s="${item#*:}"
  plan="$HERE/scenarios/single/$r-$s.yaml"
  [ -f "$plan" ] || printf "# Single public scenario %s#%s (config/scenarios/public.yaml).\nregimes: [%s]\nseeds: [%s]\n" "$r" "$s" "$r" "$s" > "$plan"
  log="$HERE/logs/$TAG-$r-$s.log"
  grep -q "^done" "$log" 2>/dev/null && continue
  : > "$log"
  "$HERE/scripts/run-matrix.sh" "$ROSTER" "$plan" "$PORT" "$TAG-$r-$s" || true
done
