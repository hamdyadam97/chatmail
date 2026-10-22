#!/usr/bin/env bash
CORE=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-core-0.27.0 | head -1)
SRC=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-0.56.0 | head -1)
echo "=== KeyPackageStorage trait ==="
grep -n "trait KeyPackageStorage" -A 20 "$CORE/src/key_package.rs" | head -30
echo "=== builder setter ==="
grep -n "pub fn key_package" "$SRC/src/client_builder.rs" | head -5
