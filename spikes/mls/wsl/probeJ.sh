#!/usr/bin/env bash
RC=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-crypto-rustcrypto-0.22.1 | head -1)
grep -n "fn ed25519_private_from_bytes\|fn private_key_to_public\|fn private_key_to_bytes\|fn pub_key_to_uncompressed" -A 12 "$RC/src/ec.rs" | head -60
