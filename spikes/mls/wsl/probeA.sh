#!/usr/bin/env bash
SRC=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-0.56.0 | head -1)
CORE=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-core-0.27.0 | head -1)
echo "=== core GroupState struct ==="
sed -n '1,27p' "$CORE/src/group/group_state.rs"
echo "=== IntoAnyError impls ==="
grep -n "impl.*IntoAnyError for\|pub struct AnyError\|pub type AnyError" "$CORE/src/error.rs" | head -10
echo "=== CommitBuilder ==="
grep -n "pub fn add_member\|pub fn remove_member\|pub fn build\b\|pub struct CommitBuilder" "$SRC/src/group/commit.rs" | head -8
echo "=== remove_member arg type ==="
grep -n "fn remove_member" -A 6 "$SRC/src/group/commit.rs" | head -10
echo "=== create_group_with_id args ==="
grep -n "pub async fn create_group_with_id" -A 8 "$SRC/src/client.rs" | head -12
echo "=== join_group args ==="
grep -n "pub async fn join_group" -A 8 "$SRC/src/client.rs" | head -12
echo "=== SigningIdentity fields ==="
grep -rn "pub struct SigningIdentity" -A 6 "$CORE/src/identity" "$SRC/src/identity" 2>/dev/null | head -10
echo "=== Credential enum + BasicCredential ==="
grep -rn "pub enum Credential\|pub struct BasicCredential" -A 6 "$CORE/src/identity/basic.rs" "$SRC/src/identity/basic.rs" 2>/dev/null | head -20
echo "=== cipher suite variants ==="
grep -rn "CURVE25519_AES128\|MLS_128_DHKEMX25519" "$CORE/src/crypto/cipher_suite.rs" 2>/dev/null | head -5
grep -rln "CURVE25519_AES128" "$CORE/src" | head -3
