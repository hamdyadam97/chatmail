#!/usr/bin/env bash
RC=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-crypto-rustcrypto-0.22.1 | head -1)
grep -rn "fn private_key_from_bytes\|fn private_key_bytes_to_public\|fn generate_keypair" -A 14 "$RC/src/ec.rs" | head -50
