#!/usr/bin/env bash
SRC=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-0.56.0 2>/dev/null | head -1)
echo "=== client_config.rs GroupStateStorage trait ==="
grep -n "trait GroupStateStorage" -A 20 "$SRC/src/client_config.rs" | head -40
echo "=== lib.rs re-export of it ==="
grep -n "GroupStateStorage\|ProcessedMessage\|pub use crate" "$SRC/src/lib.rs" | head -20
echo "=== ProcessedMessage location ==="
grep -rn "ProcessedMessage" "$SRC/src/group/message_processor.rs" | head -8
