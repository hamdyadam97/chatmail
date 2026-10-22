/**
 * e2e-correspondence.mjs — إثبات طرف-لطرف للمراسلات الرسمية عبر خادم Django فعلي.
 * (المساعدات المشتركة في scripts/e2e-lib.mjs.)
 *
 * المتطلبات: خادم Django على 8000 بعد `manage.py migrate` و`manage.py seed_demo`
 * (ahmed/mohamed/sara موظفون بدور employee، وadmin بدور sys_admin).
 *
 * التشغيل:   node scripts/e2e-correspondence.mjs
 *
 * السيناريو (نفس صيغة المحتوى التي تستخدمها الواجهة — src/features/correspondence/content.ts):
 *   1) ahmed يشفّر مرفقًا محليًا (AES-256-GCM بمفتاح عشوائي) ويرفع الـciphertext فقط.
 *   2) ahmed يُعدّ مراسلة إلى mohamed (إلى) وsara (نسخة): خيط = مجموعة MLS جديدة،
 *      Welcome لكل جهاز ثم Commit، ثم إرسال المحتوى المشفّر {عنوان، نص، مفتاح المرفق}
 *      → رقم مرجعي AHL-RYD-YYYY-NNNNNN.
 *   3) mohamed وsara: يجدانها في الوارد، ينضمان عبر Welcome، يفكّان المحتوى، يتحققان
 *      من ربطه بالمراسلة ومن هوية المرسل التشفيرية، وينزّلان المرفق ويفكانه.
 *   4) admin (sys_admin) ← 403 على التفاصيل والمرفق وتيار MLS للخيط.
 *   5) mohamed يردّ داخل الخيط ← ahmed وsara يفكّان الرد.
 *   6) sara تحيل إلى admin ← خيط جديد؛ admin يفك الإحالة والمرفق المُعاد مشاركته،
 *      ويبقى الأصل 403 ولا يستطيع تشفيريًا معالجة محتوى الخيط الأصلي.
 *   7) التلاعب ببايت واحد من المرفق يُفشل فك GCM بوضوح (SEC-17)، والخادم لا يرى
 *      أي canary نصي في استجاباته (SEC-03 من منظور الـAPI).
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
  encodeContent,
  decodeContent,
  encryptFile,
  decryptFile,
  uploadBlob,
  claimFor,
  setupThread,
  catchUp,
  threadRows,
  senderMatches,
  rawCaller,
} from './e2e-lib.mjs';

const { check, section, summarize } = createChecker();
const subtle = globalThis.crypto.subtle;

const CANARY_SUBJECT = `طلب صرف مستلزمات — CANARY-SUBJ-${crypto.randomUUID().slice(0, 8)}`;
const CANARY_BODY = `نرجو اعتماد صرف المبلغ المذكور. CANARY-BODY-${crypto.randomUUID().slice(0, 8)}`;
const ATTACHMENT_TEXT = `محتوى المرفق السري CANARY-FILE-${crypto.randomUUID().slice(0, 8)}`;

// ---------------------------------------------------------------------------

async function main() {
  console.log(`e2e-correspondence — الخادم: ${BASE_URL}`);

  section('0) فحص الخادم');
  try {
    await fetch(`${BASE_URL}/auth/login/`, { method: 'GET' });
  } catch (err) {
    console.log(`\nFAIL: لا يوجد خادم على ${BASE_URL} — شغّل Django ونفّذ seed_demo (${err.message})`);
    process.exitCode = 2;
    return;
  }
  check('الخادم يستجيب', true);

  section('1) دخول وبوتستراب الأجهزة');
  const people = {};
  for (const [name, pw] of [['ahmed', 'Ahmed@12345'], ['mohamed', 'Mohamed@12345'], ['sara', 'Sara@12345'], ['admin', 'Admin@12345']]) {
    const session = await login(name, pw);
    const dev = await bootstrapDevice(session.client, session.user, `e2e-corr-${name}`);
    session.client.raw = rawCaller(session.client);
    people[name] = { ...session, dev };
    check(`${name}: دخول + جهاز + KP`, !!dev.deviceId, `device=${dev.deviceId}`);
  }
  const { ahmed, mohamed, sara, admin } = people;

  section('2) ahmed يشفّر المرفق محليًا ويرفع الـciphertext فقط');
  const fileBytes = enc.encode(ATTACHMENT_TEXT);
  const encFile = await encryptFile(fileBytes);
  const up = await uploadBlob(ahmed.client, encFile.blob);
  check('رفع blob مشفّر', up.status === 201, `HTTP ${up.status}`);
  const blobId = up.data.id;
  check('بصمة الخادم = بصمة العميل', up.data.ciphertext_sha256 === encFile.sha256);
  const plainUp = await uploadBlob(ahmed.client, enc.encode('%PDF-1.7 ملف غير مشفر'));
  check('الخادم يرفض رفع ملف غير مشفر', plainUp.status === 400, `HTTP ${plainUp.status}`);

  section('3) ahmed يُعدّ المراسلة ويُنشئ مجموعة الخيط ويرسل المحتوى المشفر');
  const groupId = crypto.getRandomValues(new Uint8Array(16));
  const prep = await ahmed.client.call('POST', '/correspondences/', {
    to_user_ids: [mohamed.user.id],
    cc_user_ids: [sara.user.id],
    priority: 'high',
    classification: 'confidential',
    mls_group_id: u8ToB64(groupId),
    client_ref: crypto.randomUUID(),
  });
  check('إعداد المراسلة', prep.status === 201, `HTTP ${prep.status} ${prep.status !== 201 ? JSON.stringify(prep.data) : ''}`);
  const corr = prep.data;
  const claimed = await claimFor(ahmed.client, [mohamed.dev.deviceId, sara.dev.deviceId]);
  check('claim لجهازي المستلمين', claimed.length === 2, `got=${claimed.length}`);
  await setupThread(ahmed, corr.thread.id, groupId, claimed, [mohamed.user.id, sara.user.id]);
  check('Welcome + Commit للخيط', Number(ahmed.dev.mls.epoch(groupId)) === 1);

  const content = {
    kind: 'correspondence',
    correspondence_id: corr.id,
    subject: CANARY_SUBJECT,
    body: CANARY_BODY,
    attachments: [
      { id: blobId, name: 'كشف-المصروفات.txt', mime: 'text/plain', size: fileBytes.length, key: u8ToB64(encFile.rawKey), sha256: encFile.sha256 },
    ],
  };
  const ct = ahmed.dev.mls.encrypt(groupId, encodeContent(content));
  const sendRes = await ahmed.client.call('POST', `/correspondences/${corr.id}/send/`, {
    mls_payload: u8ToB64(ct),
    client_msg_id: crypto.randomUUID(),
    epoch: Number(ahmed.dev.mls.epoch(groupId)),
    sender_device_id: ahmed.dev.deviceId,
    attachment_ids: [blobId],
  });
  check('إرسال المراسلة', sendRes.status === 200, `HTTP ${sendRes.status} ${sendRes.status !== 200 ? JSON.stringify(sendRes.data) : ''}`);
  const sent = sendRes.data;
  const year = new Date().getFullYear();
  check('رقم مرجعي بالصيغة المعتمدة', new RegExp(`^AHL-RYD-${year}-\\d{6}$`).test(sent.reference_number ?? ''), sent.reference_number);

  const leakText = JSON.stringify(sent);
  check('استجابة الخادم بلا أي نص صريح', ![CANARY_SUBJECT, CANARY_BODY, 'CANARY-SUBJ', 'كشف-المصروفات'].some((s) => leakText.includes(s)));

  section('4) المستلمون يفكّون (إلى + نسخة)');
  const states = {};
  for (const person of [mohamed, sara]) {
    const name = person.user.username;
    const inbox = await person.client.call('GET', '/correspondences/?folder=inbox');
    check(`${name}: المراسلة في الوارد`, (inbox.data?.results ?? []).some((r) => r.id === corr.id));
    const detail = await person.client.call('GET', `/correspondences/${corr.id}/`);
    const state = { dev: person.dev, lastSeq: 0, joined: false, joinEpoch: 0 };
    states[name] = state;
    const decrypted = catchUp(state, await threadRows(person.client, corr.thread.id), groupId);
    const got = decrypted.get(detail.data.content.seq);
    check(`${name}: انضمام عبر Welcome وفك المحتوى`, !!got);
    const parsed = decodeContent(got.plaintext);
    check(`${name}: العنوان والنص مطابقان`, parsed.subject === CANARY_SUBJECT && parsed.body === CANARY_BODY);
    check(`${name}: المحتوى مربوط بهذه المراسلة`, parsed.correspondence_id === corr.id);
    check(
      `${name}: مرسل MLS الموثّق = ahmed وجهازه`,
      senderMatches(person.dev, groupId, detail.data.sender.id, detail.data.content.sender_device_id, got.senderIndex),
    );
    const att = parsed.attachments[0];
    const dl = await person.client.raw('GET', `/attachments/${att.id}/`);
    check(`${name}: تنزيل المرفق المشفر`, dl.status === 200, `HTTP ${dl.status}`);
    const sha = u8ToB64(new Uint8Array(await subtle.digest('SHA-256', dl.bytes)));
    check(`${name}: بصمة الـblob تطابق ما وقّعه المرسل داخل المحتوى`, sha === att.sha256);
    const plainFile = dec.decode(await decryptFile(dl.bytes, att.key));
    check(`${name}: فك المرفق`, plainFile === ATTACHMENT_TEXT);
    check(`${name}: الـblob المخزن لا يحوي النص`, !Buffer.from(dl.bytes).includes(Buffer.from(ATTACHMENT_TEXT)));
  }

  section('5) sys_admin لا يصل إلى شيء');
  const adminDetail = await admin.client.call('GET', `/correspondences/${corr.id}/`);
  check('admin: التفاصيل 403', adminDetail.status === 403, `HTTP ${adminDetail.status}`);
  const adminBlob = await admin.client.raw('GET', `/attachments/${blobId}/`);
  check('admin: المرفق 403', adminBlob.status === 403, `HTTP ${adminBlob.status}`);
  const adminThread = await admin.client.call('GET', `/conversations/${corr.thread.id}/messages/`);
  check('admin: تيار MLS للخيط 403', adminThread.status === 403, `HTTP ${adminThread.status}`);
  const adminSearch = await admin.client.call('GET', `/correspondences/?folder=inbox&q=${encodeURIComponent(sent.reference_number)}`);
  check('admin: البحث بالرقم المرجعي لا يعيد شيئًا', (adminSearch.data?.results ?? []).length === 0);

  section('6) mohamed يرد داخل الخيط — ahmed وsara يفكّان');
  const replyText = 'تمت المراجعة، ونوصي بالاعتماد.';
  const replyCt = mohamed.dev.mls.encrypt(
    groupId,
    encodeContent({ kind: 'correspondence', correspondence_id: null, reply_to_id: corr.id, subject: `رد: ${CANARY_SUBJECT}`, body: replyText, attachments: [] }),
  );
  const replyRes = await mohamed.client.call('POST', `/correspondences/${corr.id}/reply/`, {
    client_ref: crypto.randomUUID(),
    mls_payload: u8ToB64(replyCt),
    client_msg_id: crypto.randomUUID(),
    epoch: Number(mohamed.dev.mls.epoch(groupId)),
    sender_device_id: mohamed.dev.deviceId,
  });
  check('إرسال الرد', replyRes.status === 201, `HTTP ${replyRes.status} ${replyRes.status !== 201 ? JSON.stringify(replyRes.data) : ''}`);
  const replyCorr = replyRes.data;
  check('الرد في نفس الخيط وبرقم مرجعي جديد', replyCorr.thread_id === corr.thread.id && replyCorr.reference_number !== sent.reference_number, replyCorr.reference_number);

  const aState = { dev: ahmed.dev, lastSeq: 0, joined: true, joinEpoch: 1 };
  const aDecrypted = catchUp(aState, await threadRows(ahmed.client, corr.thread.id), groupId);
  const aReply = aDecrypted.get(replyCorr.content.seq);
  check('ahmed فك الرد', !!aReply && decodeContent(aReply.plaintext).body === replyText);
  const sDecrypted = catchUp(states.sara, await threadRows(sara.client, corr.thread.id), groupId);
  const sReply = sDecrypted.get(replyCorr.content.seq);
  check('sara فكّت الرد', !!sReply && decodeContent(sReply.plaintext).body === replyText);
  check(
    'مرسل الرد الموثّق = mohamed',
    !!sReply && senderMatches(sara.dev, groupId, mohamed.user.id, mohamed.dev.deviceId, sReply.senderIndex),
  );

  section('7) sara تحيل إلى admin — خيط جديد ومحتوى مُعاد تشفيره');
  const fwdGroup = crypto.getRandomValues(new Uint8Array(16));
  const fwdPrep = await sara.client.call('POST', `/correspondences/${corr.id}/forward/`, {
    to_user_ids: [admin.user.id],
    mls_group_id: u8ToB64(fwdGroup),
    client_ref: crypto.randomUUID(),
  });
  check('إعداد الإحالة', fwdPrep.status === 201, `HTTP ${fwdPrep.status}`);
  const fwd = fwdPrep.data;
  const adminKp = await claimFor(sara.client, [admin.dev.deviceId]);
  await setupThread(sara, fwd.thread.id, fwdGroup, adminKp, [admin.user.id]);
  const fwdContent = {
    kind: 'correspondence',
    correspondence_id: fwd.id,
    subject: `إحالة: ${CANARY_SUBJECT}`,
    body: 'للاطلاع والإفادة.',
    attachments: content.attachments,
    forwarded: { reference_number: sent.reference_number, sender_name: ahmed.user.full_name, subject: CANARY_SUBJECT, body: CANARY_BODY },
  };
  const fwdSend = await sara.client.call('POST', `/correspondences/${fwd.id}/send/`, {
    mls_payload: u8ToB64(sara.dev.mls.encrypt(fwdGroup, encodeContent(fwdContent))),
    client_msg_id: crypto.randomUUID(),
    epoch: 1,
    sender_device_id: sara.dev.deviceId,
    attachment_ids: [blobId],
  });
  check('إرسال الإحالة', fwdSend.status === 200, `HTTP ${fwdSend.status} ${fwdSend.status !== 200 ? JSON.stringify(fwdSend.data) : ''}`);

  const adminState = { dev: admin.dev, lastSeq: 0, joined: false, joinEpoch: 0 };
  const adminDec = catchUp(adminState, await threadRows(admin.client, fwd.thread.id), fwdGroup);
  const adminGot = adminDec.get(fwdSend.data.content.seq);
  const adminParsed = adminGot && decodeContent(adminGot.plaintext);
  check('admin فك الإحالة المصرّح بها', adminParsed?.forwarded?.body === CANARY_BODY);
  const adminBlob2 = await admin.client.raw('GET', `/attachments/${blobId}/`);
  check('admin: المرفق متاح الآن عبر الإحالة', adminBlob2.status === 200);
  check(
    'admin: فك المرفق بالمفتاح المُعاد مشاركته',
    adminBlob2.status === 200 && dec.decode(await decryptFile(adminBlob2.bytes, adminParsed.attachments[0].key)) === ATTACHMENT_TEXT,
  );
  const adminOrig = await admin.client.call('GET', `/correspondences/${corr.id}/`);
  check('admin: المراسلة الأصلية ما زالت 403', adminOrig.status === 403);
  let cryptoBlocked = false;
  try {
    admin.dev.mls.process(groupId, ct);
  } catch {
    cryptoBlocked = true;
  }
  check('admin: لا يستطيع تشفيريًا معالجة محتوى الخيط الأصلي حتى لو حصل على الـciphertext', cryptoBlocked);

  section('8) سلامة النقل (SEC-17)');
  const tampered = new Uint8Array(encFile.blob);
  tampered[tampered.length - 5] ^= 0x01;
  let tamperFailed = false;
  try {
    await decryptFile(tampered, u8ToB64(encFile.rawKey));
  } catch {
    tamperFailed = true;
  }
  check('تعديل بايت واحد في المرفق يُفشل فك GCM', tamperFailed);

  section('الخلاصة');
  process.exitCode = summarize('e2e-correspondence');
}

main().catch((err) => {
  console.error(`\nFAIL: ${err?.stack ?? err?.message ?? String(err)}`);
  process.exitCode = 1;
});
