#!/usr/bin/env bash
CORE=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-core-0.27.0 | head -1)
echo "== find file =="
grep -rln "SignatureSecretKey" "$CORE/src"
echo "== def =="
F=$(grep -rln "pub struct SignatureSecretKey\|enum SignatureSecretKey" "$CORE/src" | head -1)
echo "file: $F"
grep -n "SignatureSecretKey" -B 2 -A 10 "$F" | head -60
