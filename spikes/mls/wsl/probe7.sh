#!/usr/bin/env bash
SRC=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-0.56.0 | head -1)
CORE=$(ls -d $HOME/.cargo/registry/src/*/mls-rs-core-0.27.0 | head -1)
echo "=== rest of GroupStateStorage trait ==="
sed -n '91,140p' "$CORE/src/group/group_state.rs"
echo "=== ReceivedMessage + descriptions ==="
sed -n '177,300p' "$SRC/src/group/message_processor.rs"
