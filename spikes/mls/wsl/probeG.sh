#!/usr/bin/env bash
CORE=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-core-0.27.0 | head -1)
grep -n "async fn \|fn " "$CORE/src/crypto.rs" | sed -n '1,60p' | grep -E "fn [a-z_]+" | head -40
