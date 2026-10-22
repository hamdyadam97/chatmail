#!/usr/bin/env bash
# Grep the actual vendored mls-rs 0.56.0 sources.
SRC=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-0.56.0 2>/dev/null | head -1)
echo "SRC=$SRC"
echo "=== GroupStateStorage trait ==="
grep -rn "trait GroupStateStorage" "$SRC/src" | head -3
echo "=== state module: GroupState def ==="
grep -rn "pub struct GroupState\|pub trait GroupState" "$SRC/src/group/state.rs" | head -5
echo "=== ProcessedMessage ==="
grep -rn "pub enum ProcessedMessage" "$SRC/src" | head -3
echo "=== LeafNodeIndex ==="
grep -rn "pub struct LeafNodeIndex\|pub use.*LeafNodeIndex" "$SRC/src" $(ls -d $HOME/.cargo/registry/src/*/mls-rs-core-0.27.0 2>/dev/null | head -1)/src 2>/dev/null | head -5
echo "=== CommitOutput fields ==="
grep -rn "pub struct CommitOutput" -A 12 "$SRC/src/group/commit.rs" 2>/dev/null | head -16
echo "=== roster Member ==="
grep -rn "pub struct Member" -A 10 $(ls -d $HOME/.cargo/registry/src/*/mls-rs-core-0.27.0 2>/dev/null | head -1)/src/group/roster.rs 2>/dev/null | head -14
