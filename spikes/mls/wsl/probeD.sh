#!/usr/bin/env bash
CORE=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-core-0.27.0 | head -1)
grep -rn "pub struct SignatureSecretKey" -A 14 "$CORE/src/crypto" | head -24
echo "=== ctors ==="
grep -rn "impl SignatureSecretKey" -A 10 "$CORE/src/crypto" | head -26
