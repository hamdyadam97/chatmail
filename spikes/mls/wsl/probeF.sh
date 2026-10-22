#!/usr/bin/env bash
for c in mls-rs-0.56.0 mls-rs-crypto-rustcrypto-0.22.1 mls-rs-crypto-hpke-0.21.1 mls-rs-core-0.27.0; do
  D=$(ls -d $HOME/.cargo/registry/src/*/$c 2>/dev/null | head -1)
  [ -z "$D" ] && continue
  echo "=== $c ==="
  grep -rn "try_into().unwrap()\|try_from(.*).unwrap()\|\.unwrap()" "$D/src" 2>/dev/null | grep -i "try\|slice\|from" | head -8
done
echo "=== x25519/dh_kem files ==="
D=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-crypto-hpke-0.21.1 | head -1)
ls "$D/src"
grep -rn "from_slice\|try_into\|try_from" "$D/src/dh_kem.rs" 2>/dev/null | head -10
