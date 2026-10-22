# MLS Spike (mls-rs → WASM)

Spike for the E2EE correspondence system — proves MLS (RFC 9420) via `mls-rs`
compiled to wasm32 and driven from Node. See `../../docs/phase1/08-mls-spike-results.md`
for results and the go/no-go recommendation.

## Layout

- `src/lib.rs` — wasm-bindgen wrapper (thin API: client/group/message/storage ops)
- `test/*.test.js` — scenarios S1–S6 (node:test); `helpers.js` shared fixtures
- `pkg/node`, `pkg/web` — wasm-bindgen outputs (checked in for convenience; regenerate)
- `.cargo/config.toml` — crates.io **git** index protocol (sparse index is broken on this network)
- `wsl/*.sh` — build/check helper scripts, fed via `bash -s < ...` (MSYS2 mangles path args)
- `probe-native/` — diagnostic crate used to root-cause a panic (see report §8.3)

## Rebuild + test

Requires WSL Ubuntu with rustup (user-local) + `wasm32-unknown-unknown` target +
`wasm-bindgen-cli` 0.2.129 (`cargo install wasm-bindgen-cli --version 0.2.129 --locked`).

```bash
npm run build:wasm   # cargo build --release (in WSL) + wasm-bindgen node & web
npm test             # S1..S6, node --test
```

Cipher suite: MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519 (pure-Rust provider).
