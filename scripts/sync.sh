#!/usr/bin/env bash
# Copy this repository's agent and tests into a simulator checkout.
#   scripts/sync.sh [SIM_DIR]   (default: $ERIS_SIM_DIR or ../nyxfoundation/eris-agent-simulator)
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SIM="${1:-${ERIS_SIM_DIR:-$HERE/../nyxfoundation/eris-agent-simulator}}"
[ -d "$SIM/example/agents" ] || { echo "not a simulator checkout: $SIM" >&2; exit 1; }
rm -rf "$SIM/example/agents/eris-adaptive-v1"
mkdir -p "$SIM/example/agents/eris-adaptive-v1"
cp "$HERE"/agent/*.ts "$HERE"/agent/prompt.md "$SIM/example/agents/eris-adaptive-v1/"
mkdir -p "$SIM/test/eris-adaptive-v1"
rm -f "$SIM"/test/eris-adaptive-v1/*.test.ts
cp "$HERE"/test/*.ts "$SIM/test/eris-adaptive-v1/" 2>/dev/null || true
mkdir -p "$SIM/config/agents"
cp "$HERE"/rosters/*.yaml "$SIM/config/agents/" 2>/dev/null || true
echo "synced into $SIM"
