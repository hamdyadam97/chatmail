#!/usr/bin/env bash
# Prints latest index entry (last line) for given crates from the cargo git index.
set -u
GD=$HOME/.cargo/registry/index/github.com-25cdd57fae9f0462/.git
REF=refs/remotes/origin/HEAD
for p in "$@"; do
  echo "== $p =="
  git --git-dir="$GD" show "$REF:$p" 2>/dev/null | tail -1 | head -c 400
  echo
done
