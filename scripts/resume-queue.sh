#!/usr/bin/env bash
# After a container restart: requeue every run whose log lacks "done" or contains FAILED at the front
# of the job file, deduplicate it, clear anvil spill and start the workers.
#   scripts/resume-queue.sh [JOBS=/root/jobs-a.txt] [PORTS="8560 8561 8562 8563"]
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SIM="${ERIS_SIM_DIR:-$HERE/../nyxfoundation/eris-agent-simulator}"
JOBS="${1:-/root/jobs-a.txt}"; PORTS="${2:-8560 8561 8562 8563}"
if ps -eo args | grep -q "[r]un-queue.sh $JOBS"; then echo "workers already running" >&2; exit 1; fi
pkill -x anvil 2>/dev/null; rm -rf /root/.anvil-homes/*/.foundry/anvil/tmp
req="$(mktemp)"
for f in "$HERE"/logs/*-[0-9][0-9][0-9].log; do
  b=$(basename "$f" .log); tag=${b%%-*}; rest=${b#*-}; s=${rest##*-}; r=${rest%-*}
  if ! grep -q "^done" "$f" || grep -q FAILED "$f"; then
    case $tag in base) ro=eris-baseline;; v1) ro=eris-v1;; *) ro=eris-$tag;; esac
    echo "$tag $SIM/config/agents/$ro.yaml $r $s" >> "$req"
  fi
done
cat "$req" "$JOBS" | awk '!seen[$0]++' > "$JOBS.new" && mv "$JOBS.new" "$JOBS"
echo "requeued $(wc -l < "$req"), queue $(wc -l < "$JOBS")"; rm -f "$req"
for p in $PORTS; do nohup "$HERE/scripts/run-queue.sh" "$JOBS" "$p" >/dev/null 2>&1 & done
