#!/usr/bin/env bash
# Copy this repository's agent and tests into a simulator checkout.
#   scripts/sync.sh [SIM_DIR] [AGENT_ID]
#   SIM_DIR  default: $ERIS_SIM_DIR or ../nyxfoundation/eris-agent-simulator
#   AGENT_ID default: eris-adaptive-v1. Use another id (e.g. eris-adaptive-dev) to stage a variant
#            without touching an agent directory that running backtests are loading.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SIM="${1:-${ERIS_SIM_DIR:-$HERE/../nyxfoundation/eris-agent-simulator}}"
ID="${2:-eris-adaptive-v1}"
[ -d "$SIM/example/agents" ] || { echo "not a simulator checkout: $SIM" >&2; exit 1; }
rm -rf "$SIM/example/agents/$ID"
mkdir -p "$SIM/example/agents/$ID"
cp "$HERE"/agent/*.ts "$SIM/example/agents/$ID/"
sed "s/^name: eris-adaptive-v1$/name: $ID/" "$HERE/agent/prompt.md" > "$SIM/example/agents/$ID/prompt.md"
mkdir -p "$SIM/test/$ID"
rm -f "$SIM/test/$ID"/*.ts
for f in "$HERE"/test/*.ts; do
  sed "s#example/agents/eris-adaptive-v1/#example/agents/$ID/#g" "$f" > "$SIM/test/$ID/$(basename "$f")"
done
mkdir -p "$SIM/config/agents"
cp "$HERE"/rosters/*.yaml "$SIM/config/agents/" 2>/dev/null || true
echo "synced $ID into $SIM"
