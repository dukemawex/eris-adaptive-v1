#!/usr/bin/env bash
# Run one scenario set for one roster on its own anvil port, logging to logs/.
#   scripts/run-matrix.sh <roster.yaml> <scenarios.yaml> <port> <tag>
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SIM="${ERIS_SIM_DIR:-$HERE/../nyxfoundation/eris-agent-simulator}"
ROSTER="$1"; SCEN="$2"; PORT="$3"; TAG="$4"
mkdir -p "$HERE/logs"
cd "$SIM"
export ERIS_PYTHON="${ERIS_PYTHON:-$SIM/.venv/bin/python}"
npm run backtest -- --scenarios "$SCEN" --agents "$ROSTER" --agent-sandbox process --port "$PORT" ${RESUME:+--resume "$RESUME"} \
  >> "$HERE/logs/$TAG.log" 2>&1
echo "done $TAG" >> "$HERE/logs/$TAG.log"
