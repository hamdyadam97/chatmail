#!/usr/bin/env bash
CT=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-crypto-traits-0.22.0 | head -1)
SRC=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-0.56.0 | head -1)
echo "=== SignatureSecretKey ==="
grep -rn "pub struct SignatureSecretKey" -A 12 "$CT/src" | head -20
grep -rn "impl SignatureSecretKey" -A 8 "$CT/src" | head -24
echo "=== Roster API ==="
grep -n "pub struct Roster\|impl.*Roster\|pub fn\|Deref" "$SRC/src/group/roster.rs" | head -15
