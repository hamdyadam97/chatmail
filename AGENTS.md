# AGENTS.md — Correspondence System (E2EE)

مشروع نظام مراسلات داخلي لمجموعة معاهد، بتشفير طرف-لطرف. التصميم المعتمد موثق في `docs/phase1/` ويجب قراءته قبل أي عمل: ERD في `04-erd.md`، الصلاحيات في `05-permissions-design.md`، هيكل المشروع في `06-project-structure.md`، الاختبارات في `07-test-plan.md`. المراسلات الرسمية (المرحلة الثانية): `docs/phase2/09-correspondence-e2ee.md`. الموافقات والإشعارات: `docs/phase2/10-approvals-notifications.md`. التعاميم: `docs/phase2/11-announcements.md`. التقارير والتدقيق: `docs/phase2/12-reports-audit.md`. البحث المحلي: `docs/phase2/13-local-search.md`. إدارة الموظفين: `docs/phase2/14-employee-admin.md`. النسخ الاحتياطي والاستعادة: `docs/phase2/15-key-backup.md`.

## البيئة

- Windows + Git Bash. لا يوجد `python`/`python3` في PATH — استخدم المُشغّل: `py` (Python 3.13.5).
- الـ venv في جذر المستودع: `.venv` — الثنائي: `.venv/Scripts/python.exe` (وليس bin/).
- Node 22 + npm متوفران.

## الأوامر

```bash
# Backend
.venv/Scripts/python.exe backend/manage.py migrate
.venv/Scripts/python.exe backend/manage.py runserver
.venv/Scripts/python.exe -m pytest backend/tests -q

# Frontend
cd frontend && npm install && npm run dev
cd frontend && npm run build && npx tsc -b
cd frontend && npm run test:unit        # فهرس البحث المحلي
cd frontend && npm run test:ui          # الواجهة الحقيقية في Edge المثبّت (بيئة معزولة 8001/5180) — إلزامي بعد أي تعديل في الواجهة أو crypto/

# إثباتات e2e (كل تشغيل على قاعدة مؤقتة جديدة، منفذ 8001 — لا تلمس db.sqlite3)
sh frontend/scripts/run-e2e-fresh.sh e2e-correspondence.mjs
sh frontend/scripts/run-e2e-fresh.sh e2e-approvals.mjs
sh frontend/scripts/run-e2e-fresh.sh e2e-announcements.mjs

# تذكيرات التعاميم المجدولة (cron كل ساعة)
.venv/Scripts/python.exe backend/manage.py send_announcement_reminders
sh frontend/scripts/run-e2e-fresh.sh e2e-chat.mjs
sh frontend/scripts/run-e2e-fresh.sh e2e-multidevice.mjs
```

**PostgreSQL بصلاحيات الإنتاج (إلزامي قبل أي نشر يمس قاعدة البيانات):** اختبارات pytest تعمل على SQLite، وSQLite يتجاهل `FOR UPDATE` وصلاحيات الأدوار. شغّل PostgreSQL 16 مؤقتًا: هاجر بدور المالك، وطبّق `deploy/postgres/grants.sql`، ثم شغّل كدور التشغيل:
`UI_SMOKE_DATABASE_URL=postgresql://corr_app@localhost:55432/correspondence npm run test:ui` و`E2E_DATABASE_URL=… sh frontend/scripts/run-e2e-fresh.sh <script>`. والقاعدة يجب أن تكون نظيفة لكل سكربت e2e.
القواعد المستفادة:
- لا `select_for_update` على جداول append-only، فهو يحتاج صلاحية UPDATE (`test_append_only_locks.py` يمنعه).
- سلاسل الشفافية لكل مستخدم على حدة، فتُتحقق بـ`verify_all_chains`.

ملاحظة: سكربتات e2e تولّد هويات جديدة لحسابات seed_demo؛ على قاعدة سبق تشغيلها عليها يرفض الخادم اعتماد الجهاز (403) لأن الهوية موجودة ومفتاحها ضاع — هذا سلوك صحيح، لذا استخدم `run-e2e-fresh.sh`.

## قواعد غير قابلة للكسر

1. لا نصوص Plaintext ولا مفاتيح خاصة تُخزن في قاعدة البيانات أو السجلات (انظر SEC-03/09/10 في خطة الاختبار).
2. قائمة المنع: لا وجود لأي صلاحية `view_all_messages` / `decrypt_all_messages` أو ما يشابها — فحص SEC-14 ثابت في CI.
3. إعادة تعيين كلمة المرور (صلاحية دخول فقط) منفصلة تقنيًا عن أي شيء متعلق بالتشفير (SEC-08).
4. لا Plaintext يُقبل في أي endpoint مصنّف E2EE عند بنائه لاحقًا.
5. أي endpoint جديد يمرّ بنفس بوابة object-permission (ممنوع كسر العزل لـ «راحة المدير»).

## الوضع الحالي

- تم: المرحلة الأولى (حزمة التصميم في `docs/phase1/`).
- تم: أساس الـ backend — الحسابات المستقلة + الهيكل التنظيمي (مبذور بخمسة معاهد) + المصادقة/MFA + الجلسات الدوّارة + RBAC بالنطاق التنظيمي + سجل تدقيق append-only + اختبارات بوابة 1 (SEC-01/02/08/14 وغيرها، 63 اختبارًا خضراء في `backend/tests`).
- تم: هيكل الـ frontend (Vite/React/TS/Tailwind RTL) + تدفق المصادقة الكامل (login ← MFA ← refresh بكوكي httpOnly، access token في الذاكرة فقط) + الصدفة والقوائم — تطابق عقد `/api/v1` موثق أعلاه (`/users/me/`).
- تم: Spike تشفير MLS — `mls-rs 0.56` + `mls-rs-crypto-rustcrypto` (pure-Rust) → wasm-bindgen 0.2.129، سيناريوهات S1–S6 كلها خضراء تحت Node (SEC-06/07/15/17 تشفيريًا، commit عند 100 عضو ≈15ms). التوصية: PROCEED. النتائج الكاملة في `docs/phase1/08-mls-spike-results.md`، الكود في `spikes/mls/` (البناء داخل WSL — لا رابط C على الويندوز المضيف؛ فهرس crates.io الـsparse معطوب عبر الشبكة فنستخدم بروتوكول git).
- تم: طبقة التشفير الفعلية + الشات المشفر E2EE — تطبيقا `crypto_keys` (هوية/أجهزة/KeyPackages/شفافية hash-chain موقعة) و`messaging` (محادثات/رسائل/أجيال/WS بتذكرة) + طبقة `frontend/src/crypto` (keystore IndexedDB مشفر، WASM مُرقّى، موجه MLS) + واجهة الشات RTL. **154 اختبارًا خضراء** و**إثبات e2e حقيقي 17/17** (`frontend/scripts/e2e-chat.mjs`: مستخدمان عبر خادم Django فعلي يتبادلان رسائل MLS ويفكّانها). التشغيل: `manage.py seed_demo` (ahmed/Ahmed@12345…) ثم الخادمان.
- تم: **متعدد الأجهزة** — اعتماد الجهاز الجديد يشترط جهازًا موثّقًا بالمفاتيح فعلًا (services.approve_device)، و`syncNewDeviceToGroups` على العميل تُدخل الجهاز المعتمد في كل مجموعات MLS الموجودة (claim KP ← add_member ← Welcome ثم Commit بلا metadata عضوية)، ولحاق الجهاز الجديد يتخطى أجيال ما قبل انضمامه. إثبات `scripts/e2e-multidevice.mjs` **36/36** (A1+A2 لنفس المستخدم + B؛ أربعة اتجاهات فك صحيحة)، وتراجع `e2e-chat.mjs` 17/17.
- تم: **المراسلات الرسمية E2EE** (المرحلة الثانية) — تطبيق `correspondence`: كل خيط مراسلة = مجموعة MLS (`Conversation(type=correspondence)`)، والمحتوى {عنوان، نص، مفاتيح المرفقات} رسالة MLS واحدة؛ إعداد ← إرسال يجمّد الصف ويُصدر رقمًا مرجعيًا بقفل صف (`AHL-RYD-2026-000001`)؛ الرد داخل الخيط، والإحالة خيط جديد بمحتوى مُعاد تشفيره؛ مرفقات AES-256-GCM على العميل (`/api/v1/attachments/` يرفض الصيغ الصريحة)؛ مجلدات الوارد/الصادر/المؤرشفة/المهمة/بانتظار ردي، ومسودات محلية مشفرة؛ العميل يتحقق من مرسل MLS الموثّق ومن ربط المحتوى بالصف. **196 اختبارًا خضراء** و**e2e حقيقي 49/49** (`scripts/e2e-correspondence.mjs`). demo users لديهم الآن دور `employee` (شرط `correspondence.send`).
- تم: **الموافقات + الإشعارات** — تطبيق `approvals`: خطوات متسلسلة (`all`/`any`)، المعتمد يجب أن يكون مستلمًا للمراسلة (لا مسار قراءة جديد)، قرار موقّع Ed25519 بمفتاح الجهاز على حمولة قانونية تربطه ببصمة SHA-256 للـciphertext المراجع (توقيع سلامة، **ليس** توقيعًا نظاميًا قانونيًا)، منع التكرار بـUNIQUE(step, slot_user)، تفويض مؤقت (≤90 يومًا، لا يمنح اطلاعًا)، ومسارات معرّفة بمحدِّدات دور/نطاق. تطبيق `notifications`: عناوين ثابتة فقط (SEC-11)، `/ws/notifications/` و`/ws/correspondences/` بتذكرة، تنبيه أجهزة عند الإضافة/الاعتماد/الإبطال. **228 اختبارًا** و**e2e 26/26** (`scripts/e2e-approvals.mjs`). مساعدات e2e للمراسلات انتقلت إلى `e2e-lib.mjs`.
- تم: **التعاميم** — تطبيق `announcements`: كل تعميم مجموعة MLS بجمهور يحله الخادم من الهيكل (مستخدمون/قسم/فرع/معهد/الكل) ومعلن لكل مستلم (العميل يطابقه مع روستر MLS — لا مستلم خفي)، `announcements.publish` بنطاق الهدف، رقم `AHL-TAM-2026-00001`، استلام/اطلاع، إقرار موقّع بمفتاح الجهاز مربوط ببصمة الـciphertext، تقرير التزام وصفي (الناشر + `track_ack`)، تذكير يدوي ومجدول، وسحب. وفي التوصيل: **Welcome واحد لعدة أجهزة** (`welcome_recipients`) وحد مصافحة 1MB (قياس: 335 بايت/عضو). **247 اختبارًا** و**e2e 35/35** (`scripts/e2e-announcements.mjs`). حساب تجريبي `manager / Manager@12345` (مدير فرع الرياض).
- تم: **التقارير + سجل التدقيق** — `/api/v1/reports/`: أعداد وأزمنة مجمّعة فقط (مرسلة، مغلقة، متأخرة، زمن أول رد، الاعتماد، التعاميم، الاستخدام، سلسلة شهرية) بنطاق `reports.view_metadata`، دمج الوحدات الأصغر من 3 موظفين، وكل عرض مُدقَّق؛ `/reports/health/` يتحقق من الخدمات وسلسلة الشفافية. `/api/v1/audit-logs/` لـ`audit.view` المركزي (والاطلاع نفسه مُسجَّل) و`/mine/` لأحداث أمان كل مستخدم. **257 اختبارًا**.
- تم: **البحث المحلي** — فهرس مقلوب في الذاكرة فقط من سجلات IndexedDB المغلّفة (مراسلات، تعاميم، شات)، توحيد عربي، إبراز آمن، الاستعلام خارج العنوان، وزر فك وفهرسة الكل. وإصلاح: رسائل الشات المستلمة صارت تُخزن مغلّفة في `chatlog` (كانت تضيع بعد إعادة التحميل، ورسائل أجهزتي الأخرى لا تُعرض).
- تم: **إدارة الموظفين والهيكل والأدوار** — API: `/users/managed/` (نطاق `manage_users`)، العضويات (إضافية/نقل/رئيسية/إنهاء بـ`org.manage_structure` في كل وحدة معنية)، `revoke-sessions` (`manage_sessions`)، `/roles/catalog/`؛ لا شيء منها يلمس الأجهزة أو المفاتيح (SEC-08). الواجهة: صفحات الموظفين والمعاهد والفروع والأقسام والأدوار. **265 اختبارًا**.
- تم: **حزمة النشر بلا Docker** (`deploy/`): خدمة Daphne مقيّدة بـsystemd خلف nginx (TLS، CSP صارمة تسمح بـWASM فقط، سجلات بلا query string)، مؤقتات systemd للتذكيرات والنسخ الاحتياطي، دوران في PostgreSQL (`corr_owner` للترحيل، `corr_app` للتشغيل بلا UPDATE/DELETE على سجل التدقيق والشفافية؛ رابط المالك في `migrate.env` root-only)، `prod.py` يرفض الإقلاع بلا الأسرار ويضع الكاش في Redis، `manage.py verify_integrity` (ترحيلات، شفافية، بصمات المرفقات، لا نص صريح، العدادات) و`restore-test.sh`، و`manage.py bootstrap_admin` لأول مسؤول (فصل الواجبات). **275 اختبارًا**. لم يُجرَّب التثبيت على Ubuntu فعلي بعد.
- تم: **اختبار الواجهة في متصفح حقيقي** (`scripts/ui-smoke.mjs`، playwright-core + Edge، 19/19): كشف وأُصلح: (1) `keystore` كان يحوّل Uint8Array داخل السجلات إلى كائنات (البذور ولقطات MLS) فيفشل التشفير في المتصفح؛ (2) قاعدة IndexedDB مشتركة بين المستخدمين ← صارت قاعدة لكل مستخدم؛ (3) ضياع استجابة تجديد الجلسة عند مغادرة الصفحة كان يُخرج المستخدم ← «فترة إعادة استخدام» 30ث على الخادم (`replaced_by`)؛ (4) رفع KeyPackages عند كل تحميل كان يصطدم بحد المعدل ← `keys/count/` ويُكمَّل النقص فقط؛ (5) حلقة إعادة رسم في صفحة المجلدات؛ (6) اختفاء رسالة الشات لحظة إرسالها. سكربتات e2e في Node لا تمر بكود الواجهة — لذلك `test:ui` لازم.
- تم: **واجهة بأسلوب Outlook وSlack** — شريط أقسام بالأيقونات (`app/AppShell.tsx`، `nav-items.ts`)؛ البريد بثلاث لوحات `features/mail/MailLayout.tsx` (`/mail/:folder[/:id]`، `/mail/compose`؛ المسارات القديمة تُحوَّل)؛ المحادثات `features/chat/ChatWorkspace.tsx` (`/chat[/:id]`، شريط جانبي، تجميع الرسائل، فواصل الأيام، محرر Enter/Shift+Enter)؛ صفحتا `/admin` و`/settings`. الخادم يعيد `members` (أسماء) مع كل محادثة لتسمية المحادثة المباشرة باسم الطرف الآخر. `SHOTS=1 npm run test:ui` يلتقط صورتي البريد والمحادثات للمراجعة. **عرض المحادثة كـOutlook**: لوحة القراءة تعرض كل رسائل الخيط تحت بعضها (الأحدث أولًا؛ الأحدث والمختارة وغير المقروءة مفتوحة والباقي سطر مختصر)، و`thread_items[].unread` (صفّي فقط) يحدد غير المقروء ويُعلَّم عند العرض؛ «رد على الجميع» يفتح محررًا داخل المحادثة ويبقى فيها؛ وقائمة الرسائل تدمج صفوف الخيط الواحد في صف بعدّاد.
- تم: **النسخ الاحتياطي المشفّر على الخادم + الاستعادة** (§3.6): مفتاح استعادة 13×4 base32، ولقطة المخزن المحلي كله (مفاتيح + MLS + بريد وشات مفكوك) مشفّرة AES-GCM على الجهاز. الرفع تلقائي بعد كل تغيير وموقّع بمفتاح الجهاز (`/api/v1/crypto/backups/`، آخر 3 لكل جهاز). الاستعادة على متصفح جديد «تتولى» الجهاز المفقود بتوقيعه، فيُسحب التسجيل المعلّق وتُنقل الجلسة ويُسجَّل حدث شفافية `device_restored`. شريط تنبيه حتى يُفعَّل النسخ. وتصليب: الدخول لا يعيد تفعيل جهاز تشفير مُبطَل. **306 اختبارًا**، و`test:ui` **30/30** بسيناريو ضياع المتصفح والاستعادة.
- تم: **النشر على سيرفر مشترك**: `deploy/scripts/preflight.sh` (فحص قراءة فقط). `install.sh` يثبّت الناقص فقط، ولا يلمس مواقع nginx الأخرى ولا `redis.conf` ولا Node النظام (نسخة خاصة في `.tools/node`)، ويرفض التعارضات. nginx بأسماء `corr_*`، وRedis على db 5 ببادئة `corr`. وإصلاح: `http2 on;` لا يعمل على nginx 1.24 (Ubuntu 24.04) فصار `listen 443 ssl http2` — مُتحقَّق بـnginx 1.24 الحقيقي (مستخرج مؤقتًا في WSL). لم يُثبَّت على الـVPS بعد.
- تم: **تذكير مواعيد المراسلات**: `send_correspondence_reminders` كل ساعة، على نفس مؤقت التذكيرات. يذكّر المستلم الأساسي الذي لم يرد مرة واحدة حين يكون الموعد اليوم أو غدًا، ومرة واحدة بعد فواته، ويُبلَّغ المرسل مرة عند الفوات. لا تذكير لمراسلة مُجابة أو مغلقة أو مؤرشفة أو لمستلم نسخة. الحقلان `due_reminded_at`/`overdue_notified_at` على المشارك. و`deploy.sh` صار يحدّث وحدات systemd مع كل تحديث. مُتحقَّق على PostgreSQL كـ`corr_app`.
- تم: **تصدير التقارير إلى Excel**: `/api/v1/reports/export/` بنفس صلاحية التقرير ونطاقه، ويُدقَّق كـ`report_exported`. الملف (`apps/reports/export.py`، openpyxl) فيه ثلاث أوراق من اليمين لليسار: ملخص، وشهري، وحسب الوحدة. أعداد فقط، وكل نص يُكتب كنص صريح (لا حقن صيغ). زر Excel في صفحة التقارير. والتنزيلات كلها تمر بـ`shared/lib/download.ts` (`saveBlob`).
- حدود هذه المرحلة (معلنة): BCC غير مبني (روستر MLS مكشوف للأعضاء؛ يحتاج خيطًا لكل مستلم مخفي — الخادم يرفضه)، المسودات لا تتزامن بين الأجهزة، والأرشفة المؤسسية لم تُبنَ بعد، والتعاميم محدودة بـ1000 مستلم وبلا مرفقات، حجم wasm ‏2.1MB (تخفيض لاحق بـwasm-opt)، لا تستعد بينما الجهاز القديم يعمل (نموذج تولّي الجهاز — انظر 15-key-backup.md)، والتصليب الأمني المستقبلي: تأكيد قبول الدعوة قبل معالجة Welcome لمجموعة مجهولة (إضافة غير المرغوبة حاليًا تظهر كمحادثة جديدة — يُدار بالسياسة مؤقتًا).

- تم: **إشعارات سطح المكتب (Web Push/VAPID)** — `notifications.push` (pywebpush، قائمة سماح لمضيفي خدمات الدفع ضد SSRF، تسليم بعد الـcommit على thread pool، حذف الاشتراكات 404/410)، `PushSubscription` (endpoint فريد ينتقل بين الحسابات على نفس المتصفح)، API `notifications/push/{public-key,subscribe,unsubscribe,test}/`، كل `notify()` يدفع إشعارًا عامًا + اسم الفاعل، ورسائل الشات (dm/group) تدفع للأعضاء الآخرين فقط (`kind=new_message`، tag لكل محادثة). الواجهة: `public/sw.js`، `features/notifications/push.ts` + `PushControls.tsx` (شريط تفعيل + بطاقة في صفحة الإشعارات)، إلغاء الاشتراك عند الخروج، عدد غير المقروء في عنوان التبويب. مفتاح التطوير يُولّد تلقائيًا في `backend/var/vapid-dev.key` عند DEBUG.

## قرارات افتراضية معتمدة (قابلة للرجوع)

- BCC: مبني لكن معطّل افتراضيًا (feature flag) حتى طلب صريح.
- الأرشيف المؤسسي: بتصنيف صريح من المرسل (`institutional_archive_eligible`) وليس تلقائيًا.
- الاستضافة: On-prem على **Ubuntu 24.04 بتثبيت مباشر بلا Docker** (قرار المستخدم): PostgreSQL + Redis + nginx + خدمات systemd. الملفات في `deploy/` ودليلها `deploy/README.md`.
