/**
 * e2e-multidevice.mjs — إثبات ثلاثة أجهزة: جهاز ثانٍ لنفس المستخدم ينضم
 * للمحادثة القائمة عبر مزامنة الأجهزة (§3.3) ويفك الرسائل في الاتجاهين.
 *
 * Runbook (من جذر المستودع G:\tmp):
 *   1) إيقاف أي خادم على المنفذ 8000:
 *      netstat -ano | grep :8000   →   taskkill //PID <pid> //F
 *   2) قاعدة بيانات نظيفة + بذور:
 *      rm backend/db.sqlite3
 *      .venv/Scripts/python.exe backend/manage.py migrate
 *      .venv/Scripts/python.exe backend/manage.py seed_demo
 *   3) التشغيل (نافذة منفصلة):
 *      .venv/Scripts/python.exe backend/manage.py runserver --noreload 8000
 *   4) الإثبات:
 *      cd frontend && BASE_URL=http://127.0.0.1:8000/api/v1 node scripts/e2e-multidevice.mjs
 *
 * السيناريو (يعكس syncNewDeviceToGroups في src/crypto/mls.ts):
 *   (1) ahmed جهاز A1 + mohamed B: محادثة مباشرة + رسالة في كل اتجاه.
 *   (2) ahmed جهاز A2 (جلسة ثانية، User-Agent مميز ← صف جهاز مستقل):
 *       bootstrap ← 409 ← جلب identity_pub من الدليل ← register
 *       (sig = مفتاح A2 فوق identity_pub‖sign_pub‖kem_pub‖uid) ← الاعتماد
 *       من جلسة A1 (الجهاز الموثّق الوحيد بمفاتيح) ← رفع KP لـA2 صراحة
 *       بـdevice_id.
 *   (3) A1 يزامن A2 مع المحادثة: Claim لـKP ← add_member ← Welcome
 *       (recipient=A2, epoch=current) ثم Commit (epoch=current+1) بلا أي
 *       membership metadata.
 *   (4) A2 يلحق بأحدث Welcome وينضم فقط (لا يعالج commit الإضافة ولا ما قبل
 *       جيل انضمامه)؛ B يلحق فيعالج commit الإضافة كما يفعل العميل.
 *       تحقق: A1 يرسل ← A2 وB يفكان ويطابقان؛ A2 يردّ ← A1 وB يفكان.
 */
import crypto from 'node:crypto';
import {
  BASE_URL,
  SpikeClient,
  enc,
  dec,
  u8ToB64,
  b64ToU8,
  concat,
  createChecker,
  login,
  bootstrapDevice,
  ed25519Material,
  x25519Public,
  userIdBytes,
  latestWelcomeRow,
} from './e2e-lib.mjs';

const { check, section, summarize } = createChecker();

const A1_LABEL = 'e2e-md-ahmed-A1';
const A2_LABEL = 'e2e-md-ahmed-A2';
const B_LABEL = 'e2e-md-mohamed-B1';

async function fetchMessages(client, conversationId, afterSeq = 0) {
  const res = await client.call('GET', `/conversations/${conversationId}/messages/?after_seq=${afterSeq}&limit=100`);
  if (res.status >= 400) {
    throw new Error(`فشل جلب الرسائل (HTTP ${res.status}): ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  return res.data;
}

async function main() {
  console.log(`e2e-multidevice — الخادم: ${BASE_URL}`);

  section('0) فحص توفر الخادم');
  let probe;
  try {
    probe = await fetch(`${BASE_URL}/auth/login/`, { method: 'GET' });
  } catch (err) {
    console.log(`\nFAIL: لا يوجد خادم على ${BASE_URL} — نفّذ runbook الترويسة أولًا (${err.message})`);
    process.exitCode = 2;
    return;
  }
  check('الخادم يستجيب', probe.status < 500, `HTTP ${probe.status}`);

  // -------------------------------------------------------------------------
  section('1) خط الأساس: ahmed A1 + mohamed B — محادثة ورسالة في كل اتجاه');
  const ahmed1 = await login('ahmed', 'Ahmed@12345', 'node-e2e-ahmed-A1');
  check('دخول ahmed (A1)', !!ahmed1.user?.id, `user.id=${ahmed1.user?.id}`);
  const mohamed = await login('mohamed', 'Mohamed@12345', 'node-e2e-mohamed-B1');
  check('دخول mohamed (B)', !!mohamed.user?.id, `user.id=${mohamed.user?.id}`);

  const a1 = await bootstrapDevice(ahmed1.client, ahmed1.user, A1_LABEL);
  check('A1: بوتستراب + KP', true, `device=${a1.deviceId}`);
  const b = await bootstrapDevice(mohamed.client, mohamed.user, B_LABEL);
  check('B: بوتستراب + KP', true, `device=${b.deviceId}`);

  const groupId = crypto.getRandomValues(new Uint8Array(16));
  const convRes = await ahmed1.client.call('POST', '/conversations/', {
    type: 'dm',
    member_user_ids: [mohamed.user.id],
    mls_group_id: u8ToB64(groupId),
  });
  if (convRes.status !== 200 && convRes.status !== 201) {
    throw new Error(`فشل إنشاء المحادثة (HTTP ${convRes.status}): ${JSON.stringify(convRes.data).slice(0, 300)}`);
  }
  const conversation = convRes.data;
  check('إنشاء المحادثة', conversation.id != null, `id=${conversation.id} epoch=${conversation.current_epoch}`);

  const queryB = await ahmed1.client.call('POST', '/crypto/keys/query/', { user_ids: [mohamed.user.id] });
  const bDeviceId = (queryB.data?.users?.[0]?.devices ?? []).find((d) => d.status === 'active')?.id;
  if (!bDeviceId) throw new Error('لا جهاز نشط لدى mohamed في الدليل');
  const claimB = await ahmed1.client.call('POST', '/crypto/keys/claim/', { device_ids: [bDeviceId] });
  if (claimB.status >= 400 || (claimB.data ?? []).length === 0) throw new Error('فشل claim لجهاز B');
  const claimedB = claimB.data[0];

  const [commit0, welcome0] = a1.mls.create_group(groupId, [b64ToU8(claimedB.keypackage)]);
  check('إنشاء المجموعة (A1)', Number(a1.mls.epoch(groupId)) === 1, `epoch=${Number(a1.mls.epoch(groupId))}`);
  const w0 = await ahmed1.client.call('POST', `/conversations/${conversation.id}/messages/`, {
    kind: 'welcome',
    mls_payload: u8ToB64(welcome0),
    client_msg_id: crypto.randomUUID(),
    epoch: 0,
    recipient_device_id: claimedB.device_id,
  });
  if (w0.status >= 400) throw new Error(`فشل نشر welcome0 (HTTP ${w0.status})`);
  const c0 = await ahmed1.client.call('POST', `/conversations/${conversation.id}/messages/`, {
    kind: 'commit',
    mls_payload: u8ToB64(commit0),
    client_msg_id: crypto.randomUUID(),
    sender_device_id: a1.deviceId,
    epoch: 1,
    membership: { added_user_ids: [mohamed.user.id], removed_user_ids: [] },
  });
  check('نشر Welcome+Commit الإنشاء', c0.status < 400, `HTTP ${c0.status}`);

  const bCatchup = await fetchMessages(mohamed.client, conversation.id);
  const bWelcome = latestWelcomeRow(bCatchup.messages);
  if (!bWelcome) throw new Error('لا welcome لدى B');
  const bJoinedGid = b.mls.join_from_welcome(b64ToU8(bWelcome.mls_payload));
  check('B انضم للمجموعة', dec.decode(bJoinedGid) === dec.decode(groupId), `epoch(B)=${Number(b.mls.epoch(groupId))}`);

  // رسالة لكل اتجاه على خط الأساس
  const baseText = 'خط الأساس قبل الجهاز الثاني';
  const baseCt = a1.mls.encrypt(groupId, enc.encode(baseText));
  const basePost = await ahmed1.client.call('POST', `/conversations/${conversation.id}/messages/`, {
    kind: 'application',
    mls_payload: u8ToB64(baseCt),
    client_msg_id: crypto.randomUUID(),
    sender_device_id: a1.deviceId,
    epoch: Number(a1.mls.epoch(groupId)),
  });
  check('A1 يرسل خط الأساس', basePost.status < 400, `HTTP ${basePost.status}`);
  let bRows = (await fetchMessages(mohamed.client, conversation.id)).messages;
  const baseRow = bRows.filter((m) => m.kind === 'application').sort((x, y) => y.seq - x.seq)[0];
  check('B فك خط الأساس', dec.decode(b.mls.process(groupId, b64ToU8(baseRow.mls_payload)).plaintext) === baseText);
  const bLastSeq = Math.max(...bRows.map((m) => m.seq));

  // -------------------------------------------------------------------------
  section('2) جهاز ahmed الثاني A2: 409 ← register ← اعتماد من A1 ← رفع KP');
  const ahmed2 = await login('ahmed', 'Ahmed@12345', 'node-e2e-ahmed-A2');
  check('دخول ahmed (A2 — جلسة مستقلة)', !!ahmed2.user?.id, `user.id=${ahmed2.user?.id}`);

  // نفس مسار العميل (identity.ts): register يوقّع الجهاز الجديد بمفتاحه فوق
  // identity_pub العائم من الدليل ‖sign_pub‖kem_pub‖uid — لا نملك بذرة
  // الهوية هنا (هي على A1) لذا نبني sig التسجيل يدويًا بنفس الصيغة.
  const a2Keys = { sign: ed25519Material(), kem: x25519Public() };
  const uid = userIdBytes(ahmed2.user.id);
  // محاولة بوتستراب كاملة التوقيع — الخادم يرد 409 (الهوية موجودة) قبل أي
  // تحقق توقيعي (services.bootstrap_identity).
  const throwawayIdentity = ed25519Material();
  const bootAttempt = await ahmed2.client.call('POST', '/crypto/identity/', {
    identity_pub: u8ToB64(throwawayIdentity.pub),
    bootstrap_sig: u8ToB64(
      crypto.sign(null, concat(throwawayIdentity.pub, a2Keys.sign.pub, a2Keys.kem, uid), throwawayIdentity.privateKey),
    ),
    device: {
      label: A2_LABEL,
      platform: 'node-e2e',
      sign_pub: u8ToB64(a2Keys.sign.pub),
      kem_pub: u8ToB64(a2Keys.kem),
      sig: u8ToB64(crypto.sign(null, concat(throwawayIdentity.pub, a2Keys.sign.pub, a2Keys.kem, uid), a2Keys.sign.privateKey)),
    },
  });
  check('A2: bootstrap يرفض بهوية موجودة (409)', bootAttempt.status === 409, `HTTP ${bootAttempt.status}`);

  const selfQuery = await ahmed2.client.call('POST', '/crypto/keys/query/', { user_ids: [ahmed2.user.id] });
  const existingIdentityPubB64 = selfQuery.data?.users?.[0]?.identity_pub;
  check('A2: جلب identity_pub من الدليل', !!existingIdentityPubB64);
  const identityPub = b64ToU8(existingIdentityPubB64);
  check('A2: identity_pub يطابق مفتاح A1', u8ToB64(identityPub) === u8ToB64(a1.identityPub));

  const registerSig = crypto.sign(
    null,
    concat(identityPub, a2Keys.sign.pub, a2Keys.kem, uid),
    a2Keys.sign.privateKey,
  );
  const reg = await ahmed2.client.call('POST', '/crypto/devices/register/', {
    label: A2_LABEL,
    platform: 'node-e2e',
    sign_pub: u8ToB64(a2Keys.sign.pub),
    kem_pub: u8ToB64(a2Keys.kem),
    sig: u8ToB64(registerSig),
  });
  check('A2: تسجيل الجهاز (pending)', reg.status === 200 || reg.status === 201, `HTTP ${reg.status} status=${reg.data?.status}`);
  const a2DeviceId = reg.data?.id;
  check('A2: الجهاز pending', reg.data?.status === 'pending', `id=${a2DeviceId}`);

  // الاعتماد من جلسة A1 — الجهاز الموثّق (active + بمفاتيح) هو الوحيد المخوّل.
  const approve = await ahmed1.client.call('POST', `/crypto/devices/${a2DeviceId}/approve/`, {});
  check('A1 اعتمد A2', approve.status === 200 && approve.data?.status === 'active', `HTTP ${approve.status} status=${approve.data?.status}`);

  // A2 يرفع KP الخاص به صراحة بـdevice_id (جلسة A2 مربوطة بصف placeholder مستقل).
  const a2Mls = new SpikeClient(enc.encode(`${ahmed2.user.id}|${a2DeviceId}`), a2Keys.sign.seed);
  const a2Kp = a2Mls.key_package();
  const a2KpHash = crypto.createHash('sha256').update(Buffer.from(a2Kp)).digest();
  const a2Upload = await ahmed2.client.call('POST', '/crypto/keys/upload/', {
    keypackage: u8ToB64(a2Kp),
    keypackage_hash: u8ToB64(a2KpHash),
    device_id: a2DeviceId,
  });
  check('A2 رفع KeyPackage (device_id صريح)', a2Upload.status < 400, `HTTP ${a2Upload.status}`);

  // -------------------------------------------------------------------------
  section('3) A1 يزامن A2 مع المحادثة (مرادف syncNewDeviceToGroups)');
  const convNow = (await ahmed1.client.call('GET', '/conversations/')).data.find(
    (c) => String(c.id) === String(conversation.id),
  );
  check('قراءة جيل المحادثة الحالي', convNow?.current_epoch === 1, `current_epoch=${convNow?.current_epoch}`);
  const baseEpoch = convNow.current_epoch; // 1

  const claimA2 = await ahmed1.client.call('POST', '/crypto/keys/claim/', { device_ids: [a2DeviceId] });
  check('Claim لـKP الخاص بـA2', claimA2.status === 200 && (claimA2.data ?? []).length === 1, `got=${(claimA2.data ?? []).length}`);
  const claimedA2 = claimA2.data[0];

  const [syncCommit, syncWelcome] = a1.mls.add_member(groupId, b64ToU8(claimedA2.keypackage));
  check('A1 أضاف A2 محليًا (add_member)', Number(a1.mls.epoch(groupId)) === baseEpoch + 1, `epoch(A1)=${Number(a1.mls.epoch(groupId))}`);

  const syncW = await ahmed1.client.call('POST', `/conversations/${conversation.id}/messages/`, {
    kind: 'welcome',
    mls_payload: u8ToB64(syncWelcome),
    client_msg_id: crypto.randomUUID(),
    epoch: baseEpoch, // جيل النشر الحالي
    recipient_device_id: a2DeviceId,
  });
  check('نشر Welcome للجهاز A2', syncW.status < 400, `HTTP ${syncW.status}`);

  // بلا أي حقل membership — المستخدم عضو أصلًا والخادم لا يشترط أدمن هنا.
  const syncC = await ahmed1.client.call('POST', `/conversations/${conversation.id}/messages/`, {
    kind: 'commit',
    mls_payload: u8ToB64(syncCommit),
    client_msg_id: crypto.randomUUID(),
    sender_device_id: a1.deviceId,
    epoch: baseEpoch + 1,
  });
  check('نشر Commit إضافة الجهاز (بلا membership)', syncC.status < 400, `HTTP ${syncC.status}`);

  // -------------------------------------------------------------------------
  section('4) A2 يلحق بأحدث Welcome؛ B يلحق بمعالجة commit الإضافة');
  const a2Catchup = await fetchMessages(ahmed2.client, conversation.id);
  const a2Welcome = latestWelcomeRow(a2Catchup.messages);
  check('A2 يرى Welcome موجهًا له', !!a2Welcome, `welcome rows=${a2Catchup.messages.filter((m) => m.kind === 'welcome').length}`);
  const a2Joined = a2Mls.join_from_welcome(b64ToU8(a2Welcome.mls_payload));
  check('A2 انضم عبر Welcome', dec.decode(a2Joined) === dec.decode(groupId), `epoch(A2)=${Number(a2Mls.epoch(groupId))}`);
  const a2JoinEpoch = Number(a2Mls.epoch(groupId));
  check('جيل انضمام A2 متوقع', a2JoinEpoch === baseEpoch + 1, `joinEpoch=${a2JoinEpoch}`);

  // B يلحق: يعالج فقط ما بعد آخر seq عنده — commit الإضافة.
  const bNew = await fetchMessages(mohamed.client, conversation.id, bLastSeq);
  const bCommits = bNew.messages.filter((m) => m.kind === 'commit').sort((x, y) => x.seq - y.seq);
  check('وصول commit مزامنة الجهاز إلى B', bCommits.length >= 1, `commits=${bCommits.length}`);
  for (const row of bCommits) {
    const r = b.mls.process(groupId, b64ToU8(row.mls_payload));
    check('B عالج commit المزامنة', r.type === 'commit', `epoch=${Number(r.epoch)}`);
  }
  check('جيل B بعد المزامنة', Number(b.mls.epoch(groupId)) === a2JoinEpoch, `epoch(B)=${Number(b.mls.epoch(groupId))}`);

  // -------------------------------------------------------------------------
  section('5) تحقق الاتجاهات الأربعة بعد المزامنة');
  const textFromA1 = 'رسالة بعد إضافة الجهاز الثاني — من A1';
  const ctA1 = a1.mls.encrypt(groupId, enc.encode(textFromA1));
  const postA1 = await ahmed1.client.call('POST', `/conversations/${conversation.id}/messages/`, {
    kind: 'application',
    mls_payload: u8ToB64(ctA1),
    client_msg_id: crypto.randomUUID(),
    sender_device_id: a1.deviceId,
    epoch: Number(a1.mls.epoch(groupId)),
  });
  check('A1 نشر بعد المزامنة', postA1.status < 400, `HTTP ${postA1.status}`);

  const a2Rows = (await fetchMessages(ahmed2.client, conversation.id)).messages;
  const a1MsgRow = a2Rows.filter((m) => m.kind === 'application').sort((x, y) => y.seq - x.seq)[0];
  const a2Plain = a2Mls.process(groupId, b64ToU8(a1MsgRow.mls_payload));
  check('A2 فك رسالة A1', dec.decode(a2Plain.plaintext) === textFromA1, `"${dec.decode(a2Plain.plaintext)}"`);

  const bRows2 = (await fetchMessages(mohamed.client, conversation.id)).messages;
  const bMsgRow = bRows2.filter((m) => m.kind === 'application').sort((x, y) => y.seq - x.seq)[0];
  const bPlain = b.mls.process(groupId, b64ToU8(bMsgRow.mls_payload));
  check('B فك رسالة A1 بعد المزامنة', dec.decode(bPlain.plaintext) === textFromA1, `"${dec.decode(bPlain.plaintext)}"`);

  const textFromA2 = 'ردّ من الجهاز الثاني A2';
  const ctA2 = a2Mls.encrypt(groupId, enc.encode(textFromA2));
  const postA2 = await ahmed2.client.call('POST', `/conversations/${conversation.id}/messages/`, {
    kind: 'application',
    mls_payload: u8ToB64(ctA2),
    client_msg_id: crypto.randomUUID(),
    sender_device_id: a2DeviceId,
    epoch: Number(a2Mls.epoch(groupId)),
  });
  check('A2 نشر ردًّا', postA2.status < 400, `HTTP ${postA2.status}`);

  const a1Rows = (await fetchMessages(ahmed1.client, conversation.id)).messages;
  const a2MsgRow = a1Rows.filter((m) => m.kind === 'application').sort((x, y) => y.seq - x.seq)[0];
  const a1Plain = a1.mls.process(groupId, b64ToU8(a2MsgRow.mls_payload));
  check('A1 فك ردّ A2', dec.decode(a1Plain.plaintext) === textFromA2, `"${dec.decode(a1Plain.plaintext)}"`);

  const bRows3 = (await fetchMessages(mohamed.client, conversation.id)).messages;
  const bA2Row = bRows3.filter((m) => m.kind === 'application').sort((x, y) => y.seq - x.seq)[0];
  const bPlainA2 = b.mls.process(groupId, b64ToU8(bA2Row.mls_payload));
  check('B فك ردّ A2', dec.decode(bPlainA2.plaintext) === textFromA2, `"${dec.decode(bPlainA2.plaintext)}"`);

  section('الخلاصة');
  process.exitCode = summarize('e2e-multidevice');
}

main().catch((err) => {
  console.error(`\nFAIL: ${err.message}`);
  process.exitCode = 1;
});
