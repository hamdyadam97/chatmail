#!/usr/bin/env bash
CORE=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-core-0.27.0 | head -1)
sed -n '79,95p' "$CORE/src/key_package.rs"
grep -n "pub struct KeyPackageData" -B 6 "$CORE/src/key_package.rs" | head -12
