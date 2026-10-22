# 6. هيكل المشروع (Django + React)

## 6.1 شجرة المستودع

```
correspondence-system/
├── backend/
│   ├── config/                  # settings (base/dev/prod), asgi, urls, celery
│   ├── apps/
│   │   ├── accounts/            # users, sessions, MFA, login/logout/password
│   │   ├── org/                 # organizations→institutes→branches→departments→memberships
│   │   ├── authorization/       # roles, permissions, assignments
│   │   ├── crypto_keys/         # device registry, key bundles, transparency,
│   │   │                        # key backups storage, recovery endpoints, delivery service
│   │   ├── correspondence/      # threads, participants, forwards, reference numbers, events
│   │   ├── messaging/           # conversations, members, messages, reactions (Channels WS)
│   │   ├── attachments/         # encrypted blob upload/download (presigned), metadata
│   │   ├── approvals/           # workflows, steps, requests, decisions (+ signature verify)
│   │   ├── announcements/       # circulars, ack tracking, reminders
│   │   ├── archives/            # personal archive pointers, institutional archive copies (ciphertext)
│   │   ├── notifications/       # notifications, preferences, outbox + Celery dispatch
│   │   ├── reports/             # aggregate metadata reports only
│   │   └── audit/               # audit log writers, append-only enforcement, viewer
│   ├── tests/                   # security suites (SEC-*), crypto integration, api tests
│   ├── requirements/            # base.txt, dev.txt, prod.txt
│   └── manage.py
├── frontend/
│   ├── src/
│   │   ├── app/                 # router, providers (QueryClient, Auth, Theme), layout shells
│   │   ├── features/
│   │   │   ├── auth/            # login, mfa, password change
│   │   │   ├── dashboard/
│   │   │   ├── correspondence/  # inbox, sent, drafts, compose, details
│   │   │   ├── chat/            # dm, groups, channels
│   │   │   ├── approvals/  announcements/  employees/  org/  roles/
│   │   │   ├── reports/  notifications/  devices/  recovery/  security/  audit/
│   │   ├── crypto/              # ⚠ العقل المشفر:
│   │   │   ├── wasm/            # mls-rs wasm build + loader + compat check
│   │   │   ├── keystore/        # IndexedDB + WebCrypto wrapping, non-extractable keys
│   │   │   ├── identity/        # bootstrap, device enrollment, verification SAS/QR
│   │   │   ├── groups/          # MLS group state per conversation, commits, resync
│   │   │   ├── recovery/        # recovery key gen/display, backup encrypt/upload, restore
│   │   │   ├── search/          # local decrypted index (client-side only)
│   │   │   └── transparency/    # self-chain verification, monitor, warnings
│   │   ├── shared/              # api client, ws client, ui components (shadcn), hooks, i18n
│   │   └── workers/             # web worker(s) for crypto off main thread
│   ├── public/
│   ├── index.html
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   └── tsconfig.json
├── docs/
│   └── phase1/                  # هذه الحزمة
├── infra/
│   ├── (مُستبدل) النشر بلا Docker — انظر deploy/ و deploy/README.md
│   ├── compose.yml              # dev + prod profiles
│   └── nginx/                   # TLS termination, WS upgrade, security headers, SRI策略
├── .github/workflows/           # CI: lint, typecheck, pytest+security suite, build
└── README.md
```

## 6.2 اعتبارات بنية Backend

- **تطبيق واحد لكل مجال** مع عزل: طبقة API (DRF) → خدمات (`services/`) → نماذج. لا منطق مشاركة داخل serializers.
- **Channels**: `ASGI` مع طبقة قنوات Redis؛ استهلاك WS يمر بنفس بوابة الصلاحيات (membership/participant checks) مع إبطال فوري عند إبطال جهاز/عضوية.
- **Celery**: outbox dispatcher، تذكيرات التعاميم، تنظيف الجلسات، فحوصات الشفافية الدورية.
- **التحقق من الـ ciphertext الوارد**: أي endpoint يتوقع حقلًا E2EE يتحقق أنه binary غير فارغ وبنية معدّ مسبقًا (طول/ترويسة)، ويرفض JSON نصي عادي — يمنع «التسرب عن طريق الخطأ» لنص صريح.
- **سياسات تخزين**: مرفوعات الملفات تمر ب presigned upload إلى تخزين خاص، لا تمر body الملف عبر Django.

## 6.3 اعتبارات بنية Frontend (الأهم أمنيًا)

- **كل فك التشفير داخل `crypto/` فقط**؛ المكونات لا ترى Plaintext إلا عند العرض، ولا تمرره لأي hook تخزين/تحليل.
- **Web Worker** يشغّل WASM لتفادي تجميد الواجهة وعزل الذاكرة قدر الإمكان.
- **مخزن المفاتيح**: IndexedDB مشفر + مفاتيح non-extractable حيث أمكن؛ لا localStorage؛ مسح تلقائي عند تسجيل الخروج (مع خيار «بقاء موثق على هذا الجهاز»).
- **XSS**: React escapes افتراضيًا + سياسة CSP صارمة (بدون `unsafe-inline` للسكربتات)، تعقيم Markdown/روابط، فصل مرفقات العرض (PDF/صور) في sandbox origin منفصل.
- **SRI + تثبيت البناء**: عرض الإصدار والبصمة داخل صفحة الأمان، وتحقق من نزاهة الحزم عند التحديث (يخفف A9 — لا يلغيه؛ التحديثات تمر عبر مراجعة وتوقيع).
- **RTL**: Tailwind logical properties، خط عربي، اتجاه RTL كامل.

## 6.4 البنية التحتية والنشر

| المكوّن | الاختيار | ملاحظات أمنية |
|---------|----------|----------------|
| PostgreSQL | ‏15+ | صلاحية `app` بلا DDL في الإنتاج؛ صلاحية `audit_writer` بلا UPDATE/DELETE على audit |
| Redis | ‏7 | بلا وصول عام؛ كلمات مرور + namespace للمفاتيح |
| التخزين | S3-compatible داخلي أو MinIO | private buckets، presigned قصير العمر |
| KMS للبيانات غير E2EE | مفتاح تشغيلي واحد للـ MFA secrets وما شابه (فقط) — منفصل عن E2EE تمامًا | لا يستخدم لأي محتوى مراسلات |
| النسخ الاحتياطي | pg_dump مجدول + تخزين مُشفّر بمفتاح منفصل | يفترض تسريبه: لا محتوى نظرًا للتصميم |
| TLS | ‏HAProxy/Nginx، HSTS، TLS1.2+ | WS فوق WSS |
| المراقبة | Prometheus/Grafana + سجلات بلا أسرار | تنبيه على كسر سلسلة الشفافية |

## 6.5 بيئات

- `dev`: compose محلي (sqlite للاختبارات السريعة + postgres للتطابق).
- `staging`: قريب من الإنتاج، بيانات تجريبية اصطناعية فقط، ويشمل تشغيل مجموعة اختبارات SEC-* كاملة.
- `prod`: لا أوامر destructive إلا بموافقة موثقة (حسب تعليماتك).
