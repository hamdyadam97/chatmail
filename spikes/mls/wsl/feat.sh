#!/usr/bin/env bash
# Pretty-print features/deps of the latest index entry for a crate path.
set -u
GD=$HOME/.cargo/registry/index/github.com-25cdd57fae9f0462/.git
REF=refs/remotes/origin/HEAD
git --git-dir="$GD" show "$REF:$1" 2>/dev/null | tail -1 | python3 -c '
import sys, json
d = json.loads(sys.stdin.read())
print("name:", d["name"], "vers:", d["vers"])
print("features:", json.dumps(d.get("features", {}), indent=1)[:2000])
deps = [(x["name"], x.get("optional"), x.get("target")) for x in d.get("deps", [])]
print("deps:", json.dumps(deps)[:1500])
'
