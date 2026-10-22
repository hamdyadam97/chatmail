# 8. نتائج Spike التشفير MLS (mls-rs → WASM)

الحالة: **مكتمل — كل السيناريوهات S1–S6 خضراء تحت Node على بناء WASM**. التوصية: **PROCEED مع MLS (مكتبة mls-rs)**.

## 8.1 المسار المتخذ والبيئة

**المسار A (المعتمد):** بناء `mls-rs` كـ WASM وتشغيل السيناريوهات من Node.

| المكوّن | الإصدار |
|---------|---------|
| rustc / cargo | 1.99.1 (2026-10-13) |
| mls-rs | 0.56.0 |
| mls-rs-crypto-rustcrypto | 0.22.1 |
| mls-rs-core | 0.27.0 |
| wasm-bindgen (crate + CLI) | 0.2.129 (مثبّتة معًا حتميًا) |
| Node | v22.21.1 |
| cipher suite | MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519 |

ملاحظات بيئية موثقة (كلها في `spikes/mls/.cargo/config.toml` و`spikes/mls/wsl/`):

1. **لا يوجد رابط C على الويندوز المضيف** (لا MSVC Build Tools — مجلد VS 18 فارغ — ولا gcc). الثنائيات المُولّدة WASM لا تحتاج رابطًا، لكن cargo يحتاج toolchain مضيفًا لبناء proc-macros. لذلك بُنيت داخل **WSL Ubuntu 24.04** (موجود مسبقًا): rustup عبر السكربت الرسمي، `--profile minimal` + هدف `wasm32-unknown-unknown`، و`build-essential`. هذا ما يعادل «rustup user-local» في خطة الـSpike، منفّذ داخل distro.
2. **الفهرس ال_sparse لـcrates.io معطوب عبر شبكة المخرج هذه** (S3 `NoSuchKey` لمعظم المسارات مثل `3/syn` بينما `1/a` يعمل). الحل: بروتوكول **git** للفهرس (`[registries.crates-io] protocol = "git"`) — downloads الـ.crate تعمل طبيعيًا.
3. مزوّد التشفير **rustcrypto نقي-Rust بالكامل** (ed25519-dalek, x25519-dalek, aes-gcm) — لا OpenSSL/ring، لا بناء native تحت wasm32. دقة WASM = دقة المتصفح (نفس الثنائية الرياضيات)، وتشغيل Node هو بوابة الـSpike المعتمدة.
4. مكتبة `mls-rs-crypto-webcrypto` تُسحب تلقائيًا مع mls-rs على wasm32 (غير اختيارية) — لم نستخدمها هنا؛ rustcrypto أبسط للـNode. للإنتاج في المتصفح تبقى خيارًا جديًا (مفاتيح WebCrypto غير قابلة للتصدير، §3.9).

## 8.2 بنية الـSpike (`spikes/mls/`)

- `src/lib.rs` — غلاف wasm-bindgen رقيق فوق mls-rs. تصميمه مقصود: **لا عميل دائم**؛ كل عملية تبني `Client` قصير العمر، تحمّل المجموعة من مخزن مشترك، تنفّذ، وتكتب الحالة. هذا يطابق تصميم المتصفح المستقبلي (IndexedDB يحمل الحالة، تُحمَّل المجموعة عند الحاجة) ويتجنب تسمية نوع الإعدادات المعتمَد عمدًا في mls-rs.
- المخزن `MemStorage` (GroupStateStorage) + `MemKeyPackageStorage` (KeyPackageStorage) خلف `Arc<Mutex<..>>` مشترك بين كل العمليات — نفس العزل الذي سيطبّقه IndexedDB المشفّر.
- `export_state`/`import_state` يلتقطان/يستعيدان كل شيء (لقطات المجموعات + الأجيال المحفوظة + KeyPackages المعلّقة) كـblob معتم — إثبات S6.
- السياسات: `CommitOptions::with_path_required(true)` (UpdatePath في كل Commit — أساس PCS عند الإزالة/التدوير، §2.4).
- `pkg/node` (_commonjs للسيناريوهات) و`pkg/web` (للمتصفح لاحقًا) — مولّدان معًا.

## 8.3 حالة السيناريوهات (البوابة: `npm test` في `spikes/mls` — 7/7 أخضر)

| السيناريو | الحالة | ما يثبته |
|-----------|--------|-----------|
| S1 الهوية والرسائل الثنائية | ✅ | هوية توقيع Ed25519 لكل جهاز + مفاتيح مستقلة؛ مجموعة MLS من عضوين؛ roundtrip تشفير/فك في الاتجاهين؛ السيرفر أنبوب غبي (payloads معتمة فقط) |
| S2 مجموعة 50 + غير متزامن | ✅ | إنشاء 50 عضوًا بـCommit واحد؛ 10 أعضاء «غير متصلين» يستلمون لاحقًا عبر طوابير dumb server ويفكّون بالترتيب الصحيح (5 رسائل لكل عضو) |
| S3 إزالة/إضافة عضو (SEC-06/07) | ✅ | المُزال يعالج commit إزالته (يُعلم بها) لكن **يفشل تشفيريًا** في فك أي ciphertext للجيل التالي؛ العضو المضاف عبر Welcome يفك من جيل انضمامه فقط — ciphertext ما قبل الالتحاق يفشل |
| S4 Replay وتلاعب (SEC-15/17) | ✅ | إعادة تسليم نفس ciphertext تُرفض: «key not available, invalid generation 0» (شجرة الأسرار تُستهلك اتجاهًا واحدًا — رفض تشفيري لا رفض API)؛ قلب byte واحد يفشل بخطأ AEAD authentication |
| S5 الأداء والأحجام | ✅ | الأرقام في §8.4 |
| S6 المثابرة | ✅ | تصدير كامل الحالة → عميل جديد بنفس الهوية/البذرة → استيراد → استئناف الإرسال والاستقبال في الأجيال التالية بالاتجاهين |

اختبار وحدة مضيف إضافي (`cargo test --lib`): توليد KeyPackage على x86_64 — أخضر.

### أخطاء اكتشفها الـSpike وسببها (درس للتكامل الفعلي)

1. **مفتاح Ed25519 عند rustcrypto بصيغة 64-byte** (seed‖public، `from_keypair_bytes`) لا 32-byte. الغلاف يقبل بذرة 32-byte ويوسّعها. الخطأ يظهر كـ`TryFromSliceError("could not convert slice to array")` — **panic** لا Result، فلا يُلتقط بـmap_err.
2. **KeyPackages المولّدة تُخزن في KeyPackageRepository لدى العميل** — العميل الوسيط يحتاجها عند قبول Welcome (البحث بالمرجع). ببقاء المخزن بين النداءات (كما سيفعل IndexedDB) انحلّ «key package not found».
3. **العضو المُضاف لا يعالج commit الإضافة** — Welcome وحده ينقله للجيل الجديد؛ معالجة commit القديم ترفض «incorrect epoch» (سلوك صحيح بالمواصفة).
4. **Welcome واحد مدمج** لكل الأعضاء المضافين في commit واحد افتراضيًا (`single_welcome_message`) — لا welcome-per-member.
5. **تفرّع جهاز إلى نسختين مرسلتين = split-brain** — الـratchet اتجاه واحد؛ النسخة «المنسيّة» تُرفض بـinvalid generation (خصيصة أمنية، لا عيب).

## 8.4 أرقام الأداء المقيسة (Node/WASM، rustcrypto، نفس الجهاز)

| المقياس | القيمة |
|---------|--------|
| زمن إنشاء مجموعة 50 (commit واحد بإضافة 49) | ≈ 60 ms |
| زمن إنشاء مجموعة 100 (commit واحد بإضافة 99) | ≈ 63 ms |
| **زمن توليد commit عند 100 عضو** (إضافة عضو 101 + تخزين) | **≈ 15 ms** |
| حجم commit الإنشاء عند 50 عضوًا | 14,518 B |
| **حجم رسالة التطبيق عند 50 عضوًا** (نص قصير) | **197 B** |
| **حالة المجموعة المسلسلة لكل عضو** عند 50 (لقطة + أجيال + KPs) | **≈ 18.8 KB** |
| حالة المجموعة لكل عضو عند 100 | ≈ 40.6 KB |
| حجم KeyPackage | 288 B |
| رسالة تطبيق بدلة ثنائية / commit / welcome | 162 / 676 / 789 B |
| لقطة حالة عضو بدلة ثنائية (epoch 1) | 1,644 B |

**مقابل معيار §2.5:** البنود 1–4 مجتازة بأرقام مريحة — commit عند 100 جهاز ≈15ms (دون أي تخصيص)، حالة العضو عشرات الكيلوبايتات، الرسالة ~200B. لا حاجة لأي خطة احتياط بسبب الأداء.

## 8.5 حكم ملاءمة الـAPI لطبقات React (keystore/groups)

- **يمكن قيادته من TypeScript بوضوح:** الغلاف الحالي 11 دالة (constructor, key_package, create_group, join_from_welcome, add_member, remove_member, encrypt, process, export/import_state, epoch, member_*) — يكفي لبناء طبقة groups خاصة بنا فوقه، ولا يفرض نموذج Wire/Synapse.
- نقاط الاحتكاك الحقيقية (قابلة للحل، ليست حواجز):
  - أخطاء المكتبة تمزج Result بـ**panics** (الـpanic أعلاه) — طبقة الربط يجب أن تثبّت panic-hook وتحوّله لاستثناءات JS، وأن نتجنب الأنماط غير القابلة للفحص (طول المفتاح) بالتحقق المسبق.
  - واجهة mls-rs 0.56 شهدت إعادة تنظيم كبيرة (تخزين repository/snapshot، `ReceivedMessage` بدل `ProcessedMessage`) — تثبيت الإصدارات في Cargo.lock إلزامي، والترقية بمراجعة changelog.
  - التخزين غير متزامن المعمارية (traits جاهزة للـIndexedDB عبر `GroupStateStorage`؛ واجهتنا الحالية متزامنة — عند ربط IndexedDB سنحتاج تحويل العمليات إلى async).
- نموذج «عميل قصير العمر + مخزن دائم» الذي أثبتناه هنا هو نفسه ما ستبنيه طبقة keystore في React — أي الـSpike أنتج نمط تكامل حقيقيًا لا مجرد اختبارات.

## 8.6 المخاطر والبنود المتبقية

1. **بند §2.5/5 غير مختبَر:** استهلاك طاقة/ذاكرة WASM في تبويب خامل — يتطلب متصفحًا (Playwright). مؤجل لمرحلة pilot؛ لا مؤشرات مقلقة (حالة ثابتة بالكيلوبايتات، لا مؤقتات).
2. **حجم الوحدة 2.1MB** غير مضغوطة — `wasm-opt` و`wee_alloc`-style تقليص لاحق؛ غير مؤثر على القرار.
3. **اعتمادية X.509 موصى بها رسميًا للإنتاج** بدل BasicCredential (الـSpike يستخدم Basic متعمدًا لأنه يطابق تصميمنا §3.2 باعتماد موقّع من الهوية — عند التنفيذ نقرر: Basic مخصص أو X.509، mls-rs يدعم الاثنين).
4. **سياسات KeyPackage**: الإنتاج يحتاج قاعدة منع إعادة استهلاك على السيرفر (consumed_at، SEC-15) — خارج نطاق Spike العميل.
5. بروتوكول git للفهرس ظرف بيئي مؤقت؛ إن أُصلح الـegress يُرجَع sparse افتراضيًا.
6. تثبيت إصدارات wasm-bindgen crate+CLI معًا (`=0.2.129`) — أي ترقية تتم معًا.

## 8.7 التوصية

**PROCEED مع MLS عبر `mls-rs` (AWS, RFC 9420) + `mls-rs-crypto-rustcrypto` (pure-Rust) → wasm-bindgen.**

- لم نحتج للمسار B (@wireapp/core-crypto) ولا C (Megolm) — البوابة اجتيزت بأرقام ممتازة.
- إزالة العضوية والـPCS والـreplay protection أُثبتت **تشفيريًا** لا واجهيًا (S3/S4) — وهو ما يميّز MLS عن البدائل في §2.2.
- بناء Django القادم يبقى كما قرّر §2.4: دليل هويات + تخزين KeyPackages + تمرير Commit/Welcome/Application + شفافية — وقد جرى نمذجته فعليًا في S2 (dumb server).

## 8.8 إعادة التشغيل

```bash
# من جذر المستودع (يتطلب WSL Ubuntu + rustup داخله)
cd spikes/mls && npm run build:wasm   # cargo build + wasm-bindgen (node + web)
npm test                              # S1..S6 — node:test
```

السكربتات المساعدة في `spikes/mls/wsl/` (تُغذّى عبر stdin لتفادي MSYS2 arg-mangling). `probe-native/` مجلد تشخيصي موثّق §8.3.
