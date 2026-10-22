#!/usr/bin/env bash
RC=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-crypto-rustcrypto-0.22.1 | head -1)
grep -n "derive_public\|fn sign\|from_bytes\|from_keypair\|SigningKey\|VerifyingKey\|64\|32" "$RC/src/ec_signer.rs" | head -30
