#!/usr/bin/env bash
set -e
. $HOME/.cargo/env
cd /mnt/g/tmp/spikes/mls/probe-native
CARGO_TARGET_DIR=/root/kp-target cargo run 2>&1 | tail -30
