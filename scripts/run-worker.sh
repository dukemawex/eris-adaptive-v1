#!/usr/bin/env bash
# Run several scenario files one after another on one port, clearing the disk spill of anvils that
# have exited in between (anvil keeps history under ~/.foundry/anvil/tmp; scoring needs it while a
# run is live, so it can only be removed once that anvil is gone).
#   scripts/run-worker.sh <roster.yaml> <port> <tag-prefix> <scenario.yaml>...
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROSTER="$1"; PORT="$2"; PREFIX="$3"; shift 3
for SCEN in "$@"; do
  name="$(basename "$SCEN" .yaml)"
  "$HERE/scripts/run-matrix.sh" "$ROSTER" "$SCEN" "$PORT" "$PREFIX-$name" || true
  # remove spill directories no live anvil process has open
  live="$(for p in $(pgrep -x anvil); do ls -l /proc/$p/fd 2>/dev/null; done | grep -o '/root/.foundry/anvil/tmp/[^/ ]*' | sort -u)"
  for d in /root/.foundry/anvil/tmp/*; do
    [ -e "$d" ] || continue
    echo "$live" | grep -qx "$d" || rm -rf "$d"
  done
done
