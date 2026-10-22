#!/usr/bin/env bash
# Compile-check the spike crate for wasm32. Usage: bash -s -- [check|build] [target-dir]
set -u
cd /mnt/g/tmp/spikes/mls
. $HOME/.cargo/env
MODE=${1:-check}
TD=${2:-/root/mls-target}
CARGO_TARGET_DIR=$TD cargo $MODE --target wasm32-unknown-unknown --message-format short 2>&1 | tail -60
