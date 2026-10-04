#!/usr/bin/env bash
# Worker over a shared job file. Each line: <tag> <roster.yaml> <regime> <seed>.
# Jobs are claimed atomically (flock); a job whose log ends in "done" is skipped. One fresh anvil per
# scenario, with a per-worker anvil HOME whose spill is removed after each scenario, and a disk guard.
#   scripts/run-queue.sh <jobs.txt> <port>
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
JOBS="$1"; PORT="$2"
export ERIS_ANVIL_HOME="/root/.anvil-homes/w$PORT"
export PATH="$HERE/scripts/bin:$PATH"
mkdir -p "$ERIS_ANVIL_HOME" "$HERE/logs" "$HERE/scenarios/single"
claim() {
  # print and remove the first line of the job file under a lock
  flock "$JOBS.lock" bash -c 'l=$(head -n1 "$0"); [ -n "$l" ] && { sed -i 1d "$0"; echo "$l"; }' "$JOBS"
}
while job="$(claim)" && [ -n "$job" ]; do
  read -r tag roster r s <<<"$job"
  log="$HERE/logs/$tag-$r-$s.log"
  grep -q "^done" "$log" 2>/dev/null && ! grep -q "FAILED" "$log" && continue
  until [ "$(df --output=avail -BG / | tail -1 | tr -dc 0-9)" -ge 8 ]; do sleep 30; done
  plan="$HERE/scenarios/single/$r-$s.yaml"
  [ -f "$plan" ] || printf "# Single public scenario %s#%s (config/scenarios/public.yaml).\nregimes: [%s]\nseeds: [%s]\n" "$r" "$s" "$r" "$s" > "$plan"
  : > "$log"
  "$HERE/scripts/run-matrix.sh" "$roster" "$plan" "$PORT" "$tag-$r-$s" || true
  rm -rf "$ERIS_ANVIL_HOME/.foundry/anvil/tmp"
done
