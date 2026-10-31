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
| `nginx/correspondence.conf` | TLS، CSP صارمة (بلا سكربتات خارجية أو مضمّنة)، تمرير ‎/api و‎/ws، سجلات بلا query string |
| `scripts/gen-secrets.sh` | يولّد الأسرار (تُطبع ولا تُكتب على القرص) |
| `scripts/install.sh` | التثبيت الأول |
| `scripts/deploy.sh` | البناء والترحيل وإعادة التشغيل والفحوص — لكل تحديث |
| `scripts/backup.sh` | نسخة احتياطية (قاعدة + مرفقات + SHA256SUMS، تشفير GPG اختياري) |
| `scripts/restore-test.sh` | اختبار استرجاع في قاعدة منفصلة + `verify_integrity` |

## 0. سيرفر عليه تطبيقات أخرى (الوضع الافتراضي)

السكربتات مصممة لتعمل بجانب تطبيقات قائمة:

| المكوّن | ما نفعله | ما لا نفعله أبدًا |
|---------|----------|-------------------|
| nginx | نضيف موقعًا واحدًا لنطاقنا، ثم `nginx -t` و`reload` (بلا انقطاع) | لا نحذف ولا نعدّل مواقع أخرى (ولا `default`)، ولا نعيد تشغيل nginx. أسماء `map`/`upstream`/`log_format` كلها بالبادئة `corr` |
| PostgreSQL | قاعدة `correspondence` ودوران `corr_owner`/`corr_app` | لا نلمس إعدادات الخادم ولا قواعد غيرنا |
| Redis | رقم قاعدة خاص (`/5`) وبادئة `corr` للكاش وللقناة الفورية | لا نعدّل `redis.conf` ولا نعيد تشغيل Redis |
| Node.js | نسخة خاصة في `/opt/correspondence/.tools/node` للبناء فقط | لا نثبّت ولا نرقّي Node على مستوى النظام |
| الحزم | نثبّت الناقص فقط (`--no-upgrade`) | لا نرقّي حزمًا يعتمد عليها غيرنا |
| المنافذ | لا منافذ جديدة: Daphne على Unix socket خلف nginx | — |

**قبل أي تثبيت** شغّل الفحص (قراءة فقط، لا يغيّر شيئًا) وأرسل ناتجه:

```bash
sudo DOMAIN=mail.example.org bash deploy/scripts/preflight.sh
```

الأسرار تُنشأ مباشرة على السيرفر دون عرضها (لا نسخ يدوي):

```bash
sudo DOMAIN=mail.example.org CERT_EMAIL=it@example.org bash deploy/scripts/make-env.sh
```

`install.sh` يرفض المتابعة من تلقاء نفسه إن وجد:
- المنفذ 80/443 لخادم ويب غير nginx (Apache أو Caddy أو حاوية). عندها نربط التطبيق بذلك الـproxy بدلًا من nginx.
- PostgreSQL أو Redis داخل حاوية على المنافذ الافتراضية.
- إعداد nginx غير صالح أصلًا.
- النطاق نفسه مستخدمًا في موقع آخر.

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

**احفظ نسخة غير متصلة من `/etc/correspondence` كاملًا، وأهم ما فيه `CONTENT_ENCRYPTION_KEY`**: كل الرسائل والمرفقات مشفّرة به على الخادم، فضياعه = ضياع البريد كله ولو سلمت قاعدة البيانات، وتسرّبه مع نسخة القاعدة = كشف البريد. لا تغيّره على نظام قائم. (`deploy.sh` ينشئه مرة واحدة إن لم يوجد.) وضياع `AUTH_FERNET_KEY` يُبطل أسرار MFA فقط (يعيد المستخدمون تفعيلها).

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
sudo DOMAIN=mail.example.org bash deploy/scripts/deploy.sh          # RUN_TESTS=1 لتشغيل الاختبارات على السيرفر أيضًا
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
  sudo bash /opt/correspondence/deploy/scripts/restore-test.sh
  ```

  يتحقق من SHA256، يسترجع في قاعدة `correspondence_restore_test` ومجلد مؤقت، ثم يشغّل `verify_integrity`: الترحيلات، أن `CONTENT_ENCRYPTION_KEY` يفتح أحدث الرسائل والملفات (استعادة بمفتاح خاطئ تُكتشف هنا)، كل مرفق بحجمه وبصمته، أن كل الرسائل مختومة (لا نص صريح)، وأن عدّادات الأرقام المرجعية متقدمة على كل رقم صادر.

ما يحويه النسخ الاحتياطي: ciphertext وبيانات وصفية فقط — لا يمكن منه قراءة أي مراسلة (SEC-18).

## 7. المراقبة

- `journalctl -u correspondence-web -f` — سجلات التطبيق (بلا أجسام طلبات).
- صفحة «التقارير ← حالة الخدمات» في الواجهة: قاعدة البيانات، الكاش، الاتصال الفوري، تخزين المرفقات، وسلسلة الشفافية.
- `systemctl list-timers 'correspondence-*'` — آخر وقت تشغيل للتذكيرات والنسخ.

## 8. إشعارات سطح المكتب (Web Push)

- ضع `WEB_PUSH_VAPID_PRIVATE_KEY` (من `gen-secrets.sh`) و`WEB_PUSH_SUBJECT` في ملف البيئة ثم أعد تشغيل `correspondence-web`. بدون مفتاح صالح تبقى الميزة مطفأة ولا يتأثر أي شيء آخر.
- يحتاج السيرفر اتصالًا خارجيًا HTTPS بخدمات دفع المتصفحات: `fcm.googleapis.com` (Chrome/Edge)، `*.push.services.mozilla.com` (Firefox)، `*.notify.windows.com`، `*.push.apple.com` (Safari). الخادم لا يرسل إلا لهذه النطاقات (حماية SSRF).
- يعمل فقط عبر HTTPS (أو `localhost` في التجربة). كل مستخدم يفعّلها من شريط «تفعيل الإشعارات» أو صفحة الإشعارات.
- الخصوصية: الحمولة مشفرة لمفتاح المتصفح (RFC 8291) وتحوي عنوانًا عامًا + اسم المرسِل + رابطًا داخليًا فقط — لا موضوع ولا نص (SEC-11). خدمة الدفع (Google/Mozilla/Microsoft/Apple) ترى توقيت الإشعارات فقط. من لا يريد ذلك يتركها مطفأة.
- تغيير المفتاح يُبطل كل الاشتراكات؛ يكفي أن يضغط المستخدمون «تفعيل» مرة أخرى.


## 9. ملاحظات أمنية

- `check --deploy` ينبّه إلى `SECURE_HSTS_PRELOAD`: مُطفأ عمدًا (الإدراج في قائمة المتصفحات التزام دائم لا يناسب نطاقًا داخليًا).
- عملية Daphne واحدة تكفي لبداية التجربة؛ للتوسع شغّل أكثر من نسخة خلف nginx — Redis يجعل التذاكر وحدود المعدل والبث مشتركة بينها.
- قبل الإنتاج الفعلي: مراجعة أمنية مستقلة (انظر `docs/phase1/07-test-plan.md` §7.3).
