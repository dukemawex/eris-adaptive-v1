#!/usr/bin/env bash
# Reproduce the environment these results were measured in, without network access to GitHub
# release assets or binaries.soliditylang.org (both blocked in the cloud container used here):
#   - Foundry 1.7.1 from npm (@foundry-rs/{forge,anvil,cast})
#   - solc via solcjs (npm `solc`) behind a native-CLI shim, registered for forge (~/.svm) and
#     Hardhat (~/.cache/hardhat-nodejs/compilers-v2). The shim compiles large inputs in parallel
#     chunks of the output selection (solcjs cannot serialize GMX's full output in one go).
# Then the simulator's own documented steps: npm install, forge build, deployer vendors, deploy,
# gen:local-constants, gen:state-dump.
#   scripts/setup-sim.sh [SIM_DIR]
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SIM="${1:-${ERIS_SIM_DIR:-$HERE/../nyxfoundation/eris-agent-simulator}}"
SIM_SHA="${ERIS_SIM_SHA:-3bee7ec909a1}"

if [ ! -d "$SIM/.git" ]; then
  GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/NyxFoundation/eris-agent-simulator "$SIM"
fi
git -C "$SIM" checkout -q "$SIM_SHA" 2>/dev/null || echo "warning: could not pin $SIM_SHA"

if ! command -v anvil >/dev/null; then
  mkdir -p /opt/foundry && (cd /opt/foundry && npm init -y >/dev/null && \
    npm install @foundry-rs/forge@1.7.1 @foundry-rs/anvil@1.7.1 @foundry-rs/cast@1.7.1 >/dev/null)
  for b in forge anvil cast; do ln -sf /opt/foundry/node_modules/@foundry-rs/$b-linux-amd64/bin/$b /usr/local/bin/$b; done
fi

mkdir -p /opt/solc/bin
cp "$HERE/scripts/solc-shim.cjs" /opt/solc/shim.cjs
declare -A COMMIT=( [0.8.29]=ab55807c [0.8.20]=a1b79de6 [0.8.10]=fc410830 [0.6.11]=5ef660b1 )
HH=~/.cache/hardhat-nodejs/compilers-v2/linux-amd64
mkdir -p "$HH"
BUILDS=""
for v in "${!COMMIT[@]}"; do
  [ -d /opt/solc/$v/node_modules/solc ] || (mkdir -p /opt/solc/$v && cd /opt/solc/$v && npm init -y >/dev/null && npm install solc@$v >/dev/null)
  printf '#!/bin/sh\nSOLC_SHIM_VERSION=%s exec node --stack-size=65500 /opt/solc/shim.cjs "$@"\n' "$v" > /opt/solc/bin/solc-$v
  chmod +x /opt/solc/bin/solc-$v
  mkdir -p ~/.svm/$v && cp /opt/solc/bin/solc-$v ~/.svm/$v/solc-$v
  name="solc-linux-amd64-v$v+commit.${COMMIT[$v]}"
  cp /opt/solc/bin/solc-$v "$HH/$name"
  BUILDS="$BUILDS{\"path\":\"$name\",\"version\":\"$v\",\"build\":\"commit.${COMMIT[$v]}\",\"longVersion\":\"$v+commit.${COMMIT[$v]}\",\"keccak256\":\"0x0\",\"sha256\":\"0x0\",\"urls\":[]},"
done
echo "{\"builds\":[${BUILDS%,}],\"releases\":{},\"latestRelease\":\"0.8.29\"}" > "$HH/list.json"

cd "$SIM"
npm install
forge build
python3 -m venv .venv && .venv/bin/python -m pip install -q ./sdk-py
(cd deployer && npm install && forge build && cp -n .env.example .env && \
  sed -i 's/^MANAGE_ANVIL=.*/MANAGE_ANVIL=false/' .env && ./scripts/setup-vendors.sh)
(cd deployer && nohup npm run anvil > /tmp/eris-anvil.log 2>&1 &)
for _ in $(seq 1 60); do cast block-number --rpc-url http://127.0.0.1:8545 >/dev/null 2>&1 && break; sleep 2; done
(cd deployer && npm run deploy -- --keep-fresh)
npm run gen:local-constants
npm run gen:state-dump
"$HERE/scripts/sync.sh" "$SIM"
echo "ready: $SIM"
