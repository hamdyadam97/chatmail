#!/usr/bin/env bash
SRC=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-0.56.0 | head -1)
CORE=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-core-0.27.0 | head -1)
echo "=== core GroupStateStorage trait ==="
grep -rn "trait GroupStateStorage" -A 25 "$CORE/src/group" | head -45
echo "=== message_processor pub items ==="
grep -n "^pub\|^pub(crate) enum\|pub enum" "$SRC/src/group/message_processor.rs" | head -10
echo "=== snapshot.rs ==="
sed -n '1,60p' "$SRC/src/group/snapshot.rs"
