#!/usr/bin/env bash
SRC=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-0.56.0 | head -1)
CORE=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-core-0.27.0 | head -1)
echo "=== write_to_storage in group/mod.rs ==="
grep -n "fn write_to_storage" -A 12 "$SRC/src/group/mod.rs"
echo "=== GroupStateRepository ==="
sed -n '1,140p' "$SRC/src/group/state_repo.rs"
echo "=== EpochRecord ==="
grep -n "struct EpochRecord" -B 3 -A 30 "$CORE/src/group/group_state.rs" | head -50
