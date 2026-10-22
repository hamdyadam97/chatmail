#!/usr/bin/env bash
SRC=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-0.56.0 2>/dev/null | head -1)
CORE=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-core-0.27.0 2>/dev/null | head -1)
echo "=== GroupStateStorage anywhere ==="
grep -rln "GroupStateStorage" "$SRC/src" | head -5
echo "=== GroupState struct fields ==="
sed -n '15,45p' "$SRC/src/group/state.rs"
echo "=== ProcessedMessage in core ==="
grep -rn "enum ProcessedMessage" "$CORE/src" "$SRC/src" 2>/dev/null | head -3
echo "=== LeafNodeIndex in core ==="
grep -rn "LeafNodeIndex" "$CORE/src" 2>/dev/null | grep "pub struct\|pub use" | head -5
echo "=== in_memory storage ==="
grep -rn "pub struct\|impl.*Storage" "$SRC/src/storage_provider/in_memory.rs" 2>/dev/null | head -10
ls "$SRC/src/storage_provider/" 2>/dev/null
