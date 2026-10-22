#!/usr/bin/env bash
SRC=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-0.56.0 | head -1)
grep -rn "trait GroupStateStorage\|GroupStateStorage" "$SRC/src/group/state_repo.rs" 2>/dev/null | head -8
echo "=== state_repo files ==="
ls "$SRC/src/group/" | grep -i "state\|repo"
echo "=== any file ==="
grep -rln "GroupStateStorage" "$SRC/src"
echo "=== ProcessedMessage grep loose ==="
grep -rln "ProcessedMessage" "$SRC/src" | head -5
