# wasm-pkg — غلاف MLS (mls-rs → WASM)

نسخة مُرقّاة من أثر بناء الـSpike (`spikes/mls/pkg/web`) حتى لا نحتاج بناء Rust
للتطوير. **لا تُعدّل هذه الملفات يدويًا.**

## إعادة البناء

البناء يتم داخل **WSL Ubuntu** (لا رابط C على ويندوز المضيف — انظر
`docs/phase1/08-mls-spike-results.md` §8.1):

```bash
# من داخل WSL، من جذر المستودع:
cd spikes/mls && npm run build:wasm
# ثم انسخ الناتج:
cp -r spikes/mls/pkg/web/* frontend/src/crypto/wasm-pkg/
```

## المحتوى

- `mls_spike.js` / `mls_spike.d.ts` — وحدة wasm-bindgen (هدف web): الصنف
  `SpikeClient` مع العمليات (key_package, create_group, join_from_welcome,
  add_member, remove_member, encrypt, process, export/import_state, epoch,
  member_*). نمط «عميل قصير العمر»: كل عملية تبني Client، تحمّل الحالة من
  المخزن، تنفّذ، وتكتب الحالة (§8.2 من تقرير الـSpike) — مخزننا في
  `crypto/keystore.ts`.
- `mls_spike_bg.wasm` — الثنائية (≈2.1MB غير مضغوطة).
- `snippets/` — مقتطفات wasm-bindgen المولّدة.

أي ترقية لـ `mls-rs`/`wasm-bindgen` تتم في `spikes/mls` مع تثبيت crate+CLI
معًا (§8.6).
