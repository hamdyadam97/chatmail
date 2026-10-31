/**
 * e2e-chat.mjs — إثبات طرف-لطرف للمحادثة المباشرة عبر العقد المشترك.
 * (المساعدات المشتركة في scripts/e2e-lib.mjs — أي تعديل توقيع/مسار يتم هناك.)
 *
 * المتطلبات قبل التشغيل:
 *   1) خادم Django يعمل على 8000 وقد شُغّلت عليه `manage.py seed_demo`
 *      (المستخدمان: ahmed/Ahmed@12345، mohamed/Mohamed@12345).
 *   2) من جذر frontend:  npm install   (تثبيت devDependency ‏ws)
 *
 * التشغيل:   node scripts/e2e-chat.mjs
 *            BASE_URL=http://host:port/api/v1 node scripts/e2e-chat.mjs
 *
 * السيناريو (يعكس نمط اختبارات spikes/mls/test):
 *   دخول الطرفين ← بوتستراب الهوية/الجهاز عبر API ← رفع KeyPackage لكل
 *   جهاز ← ahmed ينشئ المحادثة + مجموعة MLS (Welcome epoch=0 ثم Commit
 *   epoch=1) ← mohamed يلحق عبر Welcome فقط (لا يعالج commit الإضافة) ←
 *   3 رسائل من ahmed يفكها mohamed ويطابِق نصوصها ← ردّ من mohamed يفكه
 *   ahmed ويطابقه.
 *
 * لا يُختبَر WS هنا (يتطلب بقاء الاتصال وتذكرة حية) — المسار HTTP الكامل
 * هو بوابة هذا الإثبات.
 */
import crypto from 'node:crypto';
import {
  BASE_URL,
  enc,
  dec,
  u8ToB64,
  b64ToU8,
  createChecker,
  login,
  bootstrapDevice,
  latestWelcomeRow,
} from './e2e-lib.mjs';

// ws devDependency غير مطلوبة حاليًا (لا نفتح WS)؛ نُبقي التحقق من توفرها
// عند توسعة السيناريو مستقبلًا.
await import('ws');

const { check, section, summarize } = createChecker();

async function main() {
  console.log(`e2e-chat — الخادم: ${BASE_URL}`);

  section('0) فحص توفر الخادم');
  let probe;
  try {
    probe = await fetch(`${BASE_URL}/auth/login/`, { method: 'GET' });
  } catch (err) {
    console.log(`\nFAIL: لا يوجد خادم على ${BASE_URL} — شغّل Django ونفّذ seed_demo أولًا (${err.message})`);
    process.exitCode = 2;
    return;
  }
  check('الخادم يستجيب', probe.status < 500, `HTTP ${probe.status}`);

  section('1) دخول الطرفين');
  const ahmed = await login('ahmed', 'Ahmed@12345');
  check('دخول ahmed', !!ahmed.user?.id, `user.id=${ahmed.user?.id}`);
  const mohamed = await login('mohamed', 'Mohamed@12345');
  check('دخول mohamed', !!mohamed.user?.id, `user.id=${mohamed.user?.id}`);

  section('2) بوتستراب الهوية/الجهاز + رفع KeyPackage (pkg/node)');
  const a = await bootstrapDevice(ahmed.client, ahmed.user, 'e2e-ahmed');
  check('ahmed: هوية+جهاز+KP', true, `device=${a.deviceId}`);
  const b = await bootstrapDevice(mohamed.client, mohamed.user, 'e2e-mohamed');
  check('mohamed: هوية+جهاز+KP', true, `device=${b.deviceId}`);

  section('3) ahmed ينشئ المحادثة + مجموعة MLS (Welcome ثم Commit)');
  const groupId = crypto.getRandomValues(new Uint8Array(16));
  const convRes = await ahmed.client.call('POST', '/conversations/', {
    type: 'dm',
    member_user_ids: [mohamed.user.id],
    mls_group_id: u8ToB64(groupId),
  });
  if (convRes.status !== 200 && convRes.status !== 201) {
    throw new Error(`فشل إنشاء المحادثة (HTTP ${convRes.status}): ${JSON.stringify(convRes.data).slice(0, 300)}`);
  }
  const conversation = convRes.data;
  check('إنشاء المحادثة', conversation.id != null, `id=${conversation.id} epoch=${conversation.current_epoch}`);

  // دليل المفاتيح ← Claim لجهاز mohamed النشط.
  const query = await ahmed.client.call('POST', '/crypto/keys/query/', { user_ids: [mohamed.user.id] });
  const bDir = (query.data?.users ?? []).find((u) => String(u.user_id) === String(mohamed.user.id));
  const bActiveDevices = (bDir?.devices ?? []).filter((d) => d.status === 'active');
  if (bActiveDevices.length === 0) throw new Error('لا أجهزة نشطة لدى mohamed في الدليل');
  const claim = await ahmed.client.call('POST', '/crypto/keys/claim/', {
    device_ids: bActiveDevices.map((d) => d.id),
  });
  if (claim.status >= 400 || (claim.data ?? []).length === 0) {
    throw new Error(`فشل claim لحزم مفاتيح mohamed (HTTP ${claim.status})`);
  }
  const claimedB = claim.data[0];

  const [commitBytes, welcomeBytes] = a.mls.create_group(groupId, [b64ToU8(claimedB.keypackage)]);
  check('إنشاء المجموعة محليًا', Number(a.mls.epoch(groupId)) === 1, `epoch=${Number(a.mls.epoch(groupId))}`);

  const welcomePost = await ahmed.client.call('POST', `/conversations/${conversation.id}/messages/`, {
    kind: 'welcome',
    mls_payload: u8ToB64(welcomeBytes),
    client_msg_id: crypto.randomUUID(),
    epoch: 0, // جيل النشر الحالي قبل الـCommit
    recipient_device_id: claimedB.device_id,
  });
  check('نشر Welcome (epoch=0)', welcomePost.status < 400, `HTTP ${welcomePost.status}`);

  const commitPost = await ahmed.client.call('POST', `/conversations/${conversation.id}/messages/`, {
    kind: 'commit',
    mls_payload: u8ToB64(commitBytes),
    client_msg_id: crypto.randomUUID(),
    sender_device_id: a.deviceId,
    epoch: 1, // current_epoch(0)+1
    membership: { added_user_ids: [mohamed.user.id], removed_user_ids: [] },
  });
  check('نشر Commit (epoch=1)', commitPost.status < 400, `HTTP ${commitPost.status}`);

  section('4) mohamed يلحق عبر Welcome (لا يعالج commit الإضافة)');
  const catchup = await mohamed.client.call('GET', `/conversations/${conversation.id}/messages/?after_seq=0&limit=50`);
  const rows = catchup.data?.messages ?? [];
  // أحدث Welcome هو الصحيح (جولات سابقة قد تُركت من بقايا rerun على نفس الحساب).
  const welcomeRows = rows.filter((m) => m.kind === 'welcome');
  const welcomeRow = welcomeRows[welcomeRows.length - 1];
  check('صف Welcome وصل لمستلمه', !!welcomeRow, `rows=${rows.length}`);
  const joinedGid = b.mls.join_from_welcome(b64ToU8(welcomeRow.mls_payload));
  check('الانضمام عبر Welcome', dec.decode(joinedGid) === dec.decode(groupId), `epoch(B)=${Number(b.mls.epoch(groupId))}`);
  // §8.3/3: لا نعالج commit الإضافة — الانضمام بالـWelcome وحده كافٍ.

  section('5) ahmed يرسل 3 رسائل — mohamed يفك ويطابق');
  const sentTexts = ['السلام عليكم', 'رسالة اختبار ثانية', 'المراسلة مشفرة طرف-لطرف'];
  const epochA = Number(a.mls.epoch(groupId));
  for (const text of sentTexts) {
    const ct = a.mls.encrypt(groupId, enc.encode(text));
    const post = await ahmed.client.call('POST', `/conversations/${conversation.id}/messages/`, {
      kind: 'application',
      mls_payload: u8ToB64(ct),
      client_msg_id: crypto.randomUUID(),
      sender_device_id: a.deviceId,
      epoch: epochA,
    });
    if (post.status >= 400) throw new Error(`فشل نشر رسالة (HTTP ${post.status}): ${JSON.stringify(post.data).slice(0, 200)}`);
  }
  const bFetch = await mohamed.client.call('GET', `/conversations/${conversation.id}/messages/?after_seq=0&limit=50`);
  const appRows = (bFetch.data?.messages ?? []).filter((m) => m.kind === 'application').sort((x, y) => x.seq - y.seq);
  check('وصول 3 رسائل تطبيق', appRows.length === sentTexts.length, `got=${appRows.length}`);
  appRows.forEach((row, i) => {
    const r = b.mls.process(groupId, b64ToU8(row.mls_payload));
    check(`فك الرسالة ${i + 1}`, dec.decode(r.plaintext) === sentTexts[i], `"${dec.decode(r.plaintext)}"`);
  });

  section('6) mohamed يردّ — ahmed يفك ويطابق');
  const replyText = 'وعليكم السلام — وصلت الرسائل سليمة';
  const replyCt = b.mls.encrypt(groupId, enc.encode(replyText));
  const replyPost = await mohamed.client.call('POST', `/conversations/${conversation.id}/messages/`, {
    kind: 'application',
    mls_payload: u8ToB64(replyCt),
    client_msg_id: crypto.randomUUID(),
    sender_device_id: b.deviceId,
    epoch: Number(b.mls.epoch(groupId)),
  });
  check('نشر الرد', replyPost.status < 400, `HTTP ${replyPost.status}`);

  const aFetch = await ahmed.client.call('GET', `/conversations/${conversation.id}/messages/?after_seq=0&limit=50`);
  const replyRow = (aFetch.data?.messages ?? [])
    .filter((m) => m.kind === 'application')
    .sort((x, y) => y.seq - x.seq)[0];
  const replyPlain = a.mls.process(groupId, b64ToU8(replyRow.mls_payload));
  check('ahmed فك الرد', dec.decode(replyPlain.plaintext) === replyText, `"${dec.decode(replyPlain.plaintext)}"`);

  section('الخلاصة');
  process.exitCode = summarize('e2e-chat');
}

main().catch((err) => {
  console.error(`\nFAIL: ${err.message}`);
  process.exitCode = 1;
});
