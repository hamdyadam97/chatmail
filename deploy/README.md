# النشر على Ubuntu — تثبيت مباشر بلا Docker

الهدف: Ubuntu Server 24.04 LTS، كل المكونات مثبتة مباشرة ومُدارة بـ systemd.

```
المتصفح ──HTTPS──▶ nginx ──unix socket──▶ Daphne (Django ASGI: ‎/api و ‎/ws)
                    │                        ├── PostgreSQL (بيانات وصفية + ciphertext)
                    └── الواجهة المبنية       ├── Redis (WebSocket بين العمليات + كاش التذاكر وحدود المعدل)
                       (ملفات ثابتة)         └── /var/lib/correspondence/blobs (مرفقات مشفرة)
مؤقتات systemd: تذكيرات التعاميم كل ساعة، النسخ الاحتياطي ليلًا
```

| الملف | الغرض |
|-------|-------|
| `env.example` | متغيرات التشغيل → `/etc/correspondence/correspondence.env` |
| `postgres/grants.sql` | صلاحيات دور التشغيل: لا UPDATE/DELETE على سجل التدقيق وسجل الشفافية |
| `systemd/correspondence-web.service` | Daphne خلف nginx، بتقييد systemd (ProtectSystem=strict…) |
| `systemd/correspondence-reminders.{service,timer}` | `send_announcement_reminders` كل ساعة |
| `systemd/correspondence-backup.{service,timer}` | نسخ احتياطي ليلي |
| `nginx/correspondence.conf` | TLS، CSP صارمة (تسمح بـWASM فقط)، تمرير ‎/api و‎/ws، سجلات بلا query string |
| `scripts/gen-secrets.sh` | يولّد الأسرار (تُطبع ولا تُكتب على القرص) |
| `scripts/install.sh` | التثبيت الأول |
| `scripts/deploy.sh` | البناء والترحيل وإعادة التشغيل والفحوص — لكل تحديث |
| `scripts/backup.sh` | نسخة احتياطية (قاعدة + مرفقات + SHA256SUMS، تشفير GPG اختياري) |
| `scripts/restore-test.sh` | اختبار استرجاع في قاعدة منفصلة + `verify_integrity` |

## 1. المتطلبات

- سيرفر Ubuntu 24.04، اسم نطاق داخلي أو عام يشير إليه (مثل `mail.example.org`)، وشهادة TLS (Let's Encrypt أو شهادة المؤسسة).
- Node.js ≥ 20 لبناء الواجهة فقط (لا يعمل في التشغيل).

## 2. الكود والأسرار

```bash
sudo git clone <repo> /opt/correspondence
sudo /opt/correspondence/deploy/scripts/gen-secrets.sh        # احتفظ بالناتج في مكان آمن
sudo install -d -m 0750 /etc/correspondence
sudo cp /opt/correspondence/deploy/env.example /etc/correspondence/correspondence.env
sudoedit /etc/correspondence/correspondence.env               # الأسرار + النطاق + كلمة مرور corr_app
echo 'MIGRATE_DATABASE_URL=postgresql://corr_owner:<CORR_OWNER_PASSWORD>@localhost:5432/correspondence' \
  | sudo tee /etc/correspondence/migrate.env >/dev/null && sudo chmod 600 /etc/correspondence/migrate.env
```

**احفظ نسخة غير متصلة من `CRYPTO_LOG_SIGN_SEED` و`AUTH_FERNET_KEY`**: ضياع الأول يكسر التحقق من سلسلة الشفافية القائمة، وضياع الثاني يُبطل أسرار MFA (يعيد المستخدمون تفعيلها). لا علاقة لأي منهما بفك الرسائل — مفاتيح المحتوى على أجهزة المستخدمين فقط.

## 3. التثبيت

```bash
sudo certbot certonly --standalone -d mail.example.org        # أو ضع شهادة المؤسسة
sudo DOMAIN=mail.example.org CORR_OWNER_PASSWORD=... CORR_APP_PASSWORD=... \
     /opt/correspondence/deploy/scripts/install.sh
```

يثبت الحزم، ينشئ مستخدم الخدمة والمجلدات، يقيّد Redis على localhost، ينشئ دوري PostgreSQL (`corr_owner` للترحيل، `corr_app` للتشغيل)، ثم يستدعي `deploy.sh` ويفعّل المؤقتات.

## 4. التحديث

```bash
cd /opt/correspondence && sudo git pull
sudo DOMAIN=mail.example.org deploy/scripts/deploy.sh          # RUN_TESTS=1 لتشغيل الاختبارات على السيرفر أيضًا
```

`deploy.sh` يرحّل بدور المالك ثم يعيد تطبيق `grants.sql`، يبني الواجهة بنفس الأصل (`https://<domain>/api/v1`)، يعيد التشغيل، ثم يفشل إن لم تنجح: `check --deploy`، `verify_integrity --skip-blobs`، والوصول إلى الـAPI عبر nginx.

## 5. أول مسؤول

```bash
sudo bash -c 'set -a; . /etc/correspondence/correspondence.env; set +a; cd /opt/correspondence/backend; \
  runuser -u correspondence -- /opt/correspondence/.venv/bin/python manage.py bootstrap_admin \
  --username it.admin --first-name ... --last-name ... --institute AHL --role sys_admin'
```

تُطبع كلمة مرور مؤقتة **مرة واحدة**. للفصل بين الواجبات: مسؤول ثانٍ بدور `hr_admin` (إسناد الأدوار) ومراقب أمن بدور `security_auditor` — الأمر يرفض جمع `roles.manage` و`accounts.manage_users` لشخص واحد إلا بخيار صريح. **لا تشغّل `seed_demo` في الإنتاج** (كلمات مروره معروفة).

## 6. النسخ الاحتياطي واختبار الاسترجاع

- ليلًا عبر `correspondence-backup.timer` إلى `/var/backups/correspondence/<stamp>/` (احتفاظ 14 يومًا: `BACKUP_KEEP_DAYS`).
- خارج السيرفر: انسخ المجلد إلى وسيط آخر، ويُنصح بضبط `BACKUP_GPG_RECIPIENT` في `/etc/correspondence/backup.env` لتشفيره.
- **اختبار الاسترجاع شهريًا** (لا يمس الإنتاج):

  ```bash
  sudo /opt/correspondence/deploy/scripts/restore-test.sh
  ```

  يتحقق من SHA256، يسترجع في قاعدة `correspondence_restore_test` ومجلد مؤقت، ثم يشغّل `verify_integrity`: الترحيلات، سلسلة الشفافية، كل مرفق بحجمه وبصمته، أن كل رسائل MLS ثنائية (لا نص صريح)، وأن عدّادات الأرقام المرجعية متقدمة على كل رقم صادر.

ما يحويه النسخ الاحتياطي: ciphertext وبيانات وصفية فقط — لا يمكن منه قراءة أي مراسلة (SEC-18).

## 7. المراقبة

- `journalctl -u correspondence-web -f` — سجلات التطبيق (بلا أجسام طلبات).
- صفحة «التقارير ← حالة الخدمات» في الواجهة: قاعدة البيانات، الكاش، الاتصال الفوري، تخزين المرفقات، وسلسلة الشفافية.
- `systemctl list-timers 'correspondence-*'` — آخر وقت تشغيل للتذكيرات والنسخ.

## 8. ملاحظات أمنية

- `check --deploy` ينبّه إلى `SECURE_HSTS_PRELOAD`: مُطفأ عمدًا (الإدراج في قائمة المتصفحات التزام دائم لا يناسب نطاقًا داخليًا).
- عملية Daphne واحدة تكفي لبداية التجربة؛ للتوسع شغّل أكثر من نسخة خلف nginx — Redis يجعل التذاكر وحدود المعدل والبث مشتركة بينها.
- قبل الإنتاج الفعلي: مراجعة أمنية مستقلة (انظر `docs/phase1/07-test-plan.md` §7.3).
