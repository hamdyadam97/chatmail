#!/usr/bin/env bash
SRC=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-0.56.0 | head -1)
echo "=== callers of state_repo.write_to_storage ==="
grep -rn "write_to_storage\|\.write(" "$SRC/src/group/mod.rs" | head -10
echo "=== Group pub fns mentioning storage/snapshot ==="
grep -n "pub fn\|pub async fn" "$SRC/src/group/mod.rs" | grep -i "stor\|snapshot\|flush" | head
echo "=== lib.rs root re-export block 155-185 ==="
sed -n '155,185p' "$SRC/src/lib.rs"
