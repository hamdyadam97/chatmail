# تطبيق أندرويد (APK) — توزيع مباشر بلا متجر

غلاف TWA (Trusted Web Activity) يفتح `https://mail.m3had-system.cloud/mail/inbox`
بملء الشاشة. كل الواجهة من الخادم، فتحديث الخادم يصل للتطبيق فورًا؛ لا يُعاد
بناء الـAPK إلا عند تغيير الاسم/الأيقونة/الحزمة.

- الحزمة: `cloud.m3hadsystem.mail` — minSdk 24 (أندرويد 7+).
- الربط بالموقع: `frontend/public/.well-known/assetlinks.json` (بصمة SHA-256
  لشهادة التوقيع) يقدّمه nginx من `dist`. بدونه يظهر شريط عنوان أعلى التطبيق.
- **مفتاح التوقيع ليس في المستودع** (`corr-release.keystore` + كلمة مروره).
  أي تحديث للتطبيق يجب أن يُوقَّع بالمفتاح نفسه، وإلا رفض أندرويد التحديث
  (يلزم حذف التطبيق وتثبيته من جديد) وتغيّرت البصمة في assetlinks.json.

## إعادة البناء

المتطلبات: JDK 17، Android SDK (`build-tools;36.1.0`، `platforms;android-36`)،
و`npm i @bubblewrap/cli@1.24.1` مع `~/.bubblewrap/config.json` (jdkPath، androidSdkPath).

```bash
mkdir twa && cp deploy/android/twa-manifest.json twa/ && cd twa
# عدّل signingKey.path لمكان المفتاح، وارفع appVersionCode/appVersionName
npx bubblewrap update --skipVersionUpgrade
./gradlew assembleRelease
BT=$ANDROID_HOME/build-tools/36.1.0
$BT/zipalign -f -p 4 app/build/outputs/apk/release/app-release-unsigned.apk aligned.apk
$BT/apksigner sign --ks corr-release.keystore --ks-key-alias corr --out correspondence.apk aligned.apk
$BT/apksigner verify --print-certs correspondence.apk
```
(على ويندوز مع `NoDefaultCurrentDirectoryInExePath` شغّل `gradlew.bat` بـ`./` بدل `bubblewrap build`.)
