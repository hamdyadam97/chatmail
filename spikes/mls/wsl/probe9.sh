#!/usr/bin/env bash
SRC=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-0.56.0 | head -1)
echo "=== state_repo commit/write fns ==="
grep -n "fn \|Snapshot\|snapshot" "$SRC/src/group/state_repo.rs" | head -40
echo "=== Group::write_to_storage / fn snapshot ==="
grep -rn "fn write_to_storage\|fn snapshot\|fn to_snapshot\|Snapshot" "$SRC/src/group/mod.rs" | head -20
echo "=== client.load_group body ==="
sed -n '700,760p' "$SRC/src/client.rs"
