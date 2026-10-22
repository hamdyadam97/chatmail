#!/usr/bin/env bash
SRC=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-0.56.0 | head -1)
echo "=== GroupStateStorage def location ==="
grep -rln "pub trait GroupStateStorage" "$SRC/src"
echo "=== in group/mod.rs ==="
grep -n "GroupStateStorage" "$SRC/src/group/mod.rs" | head -6
echo "=== ProcessedMessage ==="
grep -rln "enum ProcessedMessage" "$SRC/src"
echo "=== write_to_storage / load_group sigs ==="
grep -rn "fn write_to_storage\|fn load_group\b" "$SRC/src/group/mod.rs" "$SRC/src/client.rs" | head -5
echo "=== remove_member on CommitBuilder? ==="
grep -rn "fn remove_member\|fn add_member\|fn build(" "$SRC/src/group/commit_builder.rs" 2>/dev/null | head -8
ls "$SRC/src/group/" | head -30
