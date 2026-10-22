#!/usr/bin/env bash
# Release-build the spike for wasm32 and run wasm-bindgen for node + web targets.
set -e
cd /mnt/g/tmp/spikes/mls
. $HOME/.cargo/env
CARGO_TARGET_DIR=/root/mls-target cargo build --release --target wasm32-unknown-unknown 2>&1 | tail -3
WASM=/root/mls-target/wasm32-unknown-unknown/release/mls_spike.wasm
ls -la "$WASM"
mkdir -p pkg/node pkg/web
wasm-bindgen --target nodejs --out-dir pkg/node "$WASM" 2>&1 | tail -2
wasm-bindgen --target web --out-dir pkg/web "$WASM" 2>&1 | tail -2
echo "=== pkg/node ==="; ls -la pkg/node
echo "=== pkg/web ==="; ls -la pkg/web
