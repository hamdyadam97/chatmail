/**
 * e2e-announcements.mjs — إثبات طرف-لطرف للتعاميم عبر خادم فعلي.
 *
 * التشغيل:   sh frontend/scripts/run-e2e-fresh.sh e2e-announcements.mjs
 *
 * السيناريو:
 *   1) manager (مدير فرع الرياض) يُعدّ تعميمًا لموظفَين محددين (mohamed, sara)
 *      مع إقرار إلزامي وموعد نهائي؛ الخادم يحل الجمهور ويعلنه.
 *   2) مجموعة MLS بالجمهور المعلن فقط (Welcome واحد مخزن مرة واحدة) ← نشر المحتوى
 *      المشفر برقم مرجعي AHL-TAM-YYYY-NNNNN.
 *   3) المستلمان يفكّان، ويتحققان من مرسل MLS ومن أن الروستر = الجمهور المعلن.
 *   4) ahmed (ليس من الجمهور) وadmin (sys_admin) ← 403 ولا قدرة تشفيرية على الفك.
 *   5) إقرار موقّع بمفتاح الجهاز؛ إقرار بنسخة مختلفة ← مرفوض.
 *   6) تقرير الالتزام للناشر (وصفي فقط)، تذكير لمن لم يقر، ثم سحب التعميم.
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
  claimFor,
  setupThread,
  catchUp,
  threadRows,
  senderMatches,
} from './e2e-lib.mjs';

const { check, section, summarize } = createChecker();
const ACK_CONTEXT = 'announcement-ack-v1\n';
const CANARY = `CANARY-TAM-${crypto.randomUUID().slice(0, 8)}`;

function sha256B64(bytes) {
  return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('base64');
}

function ackBody(person, announcement, contentHash) {
  // مفاتيح مرتبة + بلا مسافات = نفس الصيغة القانونية للخادم والواجهة.
  const payload = JSON.stringify({
    acknowledged_at: new Date().toISOString(),
    announcement_id: announcement.id,
    content_hash: contentHash,
    device_id: person.dev.deviceId,
    user_id: person.user.id,
  });
  const bytes = enc.encode(payload);
  const signature = crypto.sign(null, Buffer.concat([Buffer.from(ACK_CONTEXT), bytes]), person.dev.signKey);
  return { payload: u8ToB64(bytes), signature: u8ToB64(signature), device_id: person.dev.deviceId };
}

async function main() {
  console.log(`e2e-announcements — الخادم: ${BASE_URL}`);

  section('1) دخول + أجهزة');
  const people = {};
  for (const [name, pw] of [
    ['manager', 'Manager@12345'],
    ['mohamed', 'Mohamed@12345'],
    ['sara', 'Sara@12345'],
    ['ahmed', 'Ahmed@12345'],
    ['admin', 'Admin@12345'],
  ]) {
    const session = await login(name, pw);
    people[name] = { ...session, dev: await bootstrapDevice(session.client, session.user, `e2e-ann-${name}`) };
  }
  const { manager, mohamed, sara, ahmed, admin } = people;
  check('خمسة أجهزة جاهزة', Object.values(people).every((p) => p.dev.deviceId));

  section('2) صلاحية النشر');
  const byEmployee = await ahmed.client.call('POST', '/announcements/', {
    target_type: 'users', user_ids: [mohamed.user.id], mls_group_id: u8ToB64(crypto.getRandomValues(new Uint8Array(16))),
    client_ref: crypto.randomUUID(),
  });
  check('موظف بلا announcements.publish ← 403', byEmployee.status === 403);
  const toAll = await manager.client.call('POST', '/announcements/', {
    target_type: 'all', mls_group_id: u8ToB64(crypto.getRandomValues(new Uint8Array(16))), client_ref: crypto.randomUUID(),
  });
  check('مدير فرع لا ينشر لجميع المعاهد ← 403', toAll.status === 403);

  section('3) الإعداد والجمهور المعلن');
  const groupId = crypto.getRandomValues(new Uint8Array(16));
  const due = new Date(Date.now() + 2 * 86400_000).toISOString();
  const prep = await manager.client.call('POST', '/announcements/', {
    target_type: 'users',
    user_ids: [mohamed.user.id, sara.user.id],
    requires_ack: true,
    ack_due_at: due,
    priority: 'high',
    mls_group_id: u8ToB64(groupId),
    client_ref: crypto.randomUUID(),
  });
  check('إعداد التعميم', prep.status === 201, `HTTP ${prep.status} ${prep.status !== 201 ? JSON.stringify(prep.data) : ''}`);
  const ann = prep.data;
  const audience = (await manager.client.call('GET', `/announcements/${ann.id}/audience/`)).data;
  const declared = new Set([audience.publisher.id, ...audience.recipients.map((u) => u.id)]);
  check('الجمهور المعلن = mohamed وsara', audience.recipients.length === 2 && declared.has(mohamed.user.id) && declared.has(sara.user.id));

  section('4) مجموعة MLS بالجمهور فقط + نشر مشفّر');
  const claimed = await claimFor(manager.client, [mohamed.dev.deviceId, sara.dev.deviceId]);
  await setupThread(manager, ann.thread.id, groupId, claimed, [mohamed.user.id, sara.user.id]);
  const content = { v: 1, kind: 'announcement', announcement_id: ann.id, subject: `تعميم الدوام ${CANARY}`, body: `يبدأ الدوام الساعة 7:30. ${CANARY}` };
  const ciphertext = manager.dev.mls.encrypt(groupId, enc.encode(JSON.stringify(content)));
  const pub = await manager.client.call('POST', `/announcements/${ann.id}/publish/`, {
    mls_payload: u8ToB64(ciphertext),
    client_msg_id: crypto.randomUUID(),
    epoch: 1,
    sender_device_id: manager.dev.deviceId,
  });
  check('النشر', pub.status === 200, `HTTP ${pub.status}`);
  const published = pub.data;
  const year = new Date().getFullYear();
  check('رقم التعميم', new RegExp(`^AHL-TAM-${year}-\\d{5}$`).test(published.reference_number ?? ''), published.reference_number);
  check('بصمة الخادم = بصمة الـciphertext', published.content_hash === sha256B64(ciphertext));
  check('استجابة النشر بلا نص صريح', !JSON.stringify(published).includes(CANARY));

  section('5) المستلمان يفكّان ويتحققان');
  for (const person of [mohamed, sara]) {
    const name = person.user.username;
    const box = await person.client.call('GET', '/announcements/?box=received&pending_ack=1');
    check(`${name}: في «بانتظار الإقرار»`, box.data.results.some((a) => a.id === ann.id));
    const detail = (await person.client.call('GET', `/announcements/${ann.id}/`)).data;
    check(`${name}: سُجّل الاستلام`, Boolean(detail.mine?.delivered_at));
    const state = { dev: person.dev, lastSeq: 0, joined: false, joinEpoch: 0 };
    const got = catchUp(state, await threadRows(person.client, ann.thread.id), groupId).get(detail.content.seq);
    const parsed = got && JSON.parse(dec.decode(got.plaintext));
    check(`${name}: فك المحتوى`, parsed?.body === content.body && parsed.announcement_id === ann.id);
    check(`${name}: مرسل MLS = الناشر وجهازه`, senderMatches(person.dev, groupId, manager.user.id, manager.dev.deviceId, got.senderIndex));
    const roster = [...new Set(person.dev.mls.member_identities(groupId).map((b) => dec.decode(b).split('|')[0]))];
    check(`${name}: روستر MLS = الجمهور المعلن (لا مستلم خفي)`, roster.length === declared.size && roster.every((u) => declared.has(u)));
  }

  section('6) غير المستلمين');
  for (const person of [ahmed, admin]) {
    const name = person.user.username;
    check(`${name}: التفاصيل 403`, (await person.client.call('GET', `/announcements/${ann.id}/`)).status === 403);
    check(`${name}: تيار MLS 403`, (await person.client.call('GET', `/conversations/${ann.thread.id}/messages/`)).status === 403);
    let blocked = false;
    try {
      person.dev.mls.process(groupId, ciphertext);
    } catch {
      blocked = true;
    }
    check(`${name}: لا قدرة تشفيرية على الفك حتى مع الـciphertext`, blocked);
  }

  section('7) الإقرار الموقّع');
  const wrong = await mohamed.client.call('POST', `/announcements/${ann.id}/ack/`, ackBody(mohamed, ann, sha256B64(enc.encode('نسخة أخرى'))));
  check('إقرار بنسخة مختلفة ← 400', wrong.status === 400);
  const myHash = sha256B64(b64ToU8((await mohamed.client.call('GET', `/announcements/${ann.id}/`)).data.content.mls_payload));
  const ok = await mohamed.client.call('POST', `/announcements/${ann.id}/ack/`, ackBody(mohamed, ann, myHash));
  check('إقرار mohamed مقبول', ok.status === 200, `HTTP ${ok.status} ${JSON.stringify(ok.data)}`);

  section('8) الالتزام والتذكير (بيانات وصفية فقط)');
  const report = (await manager.client.call('GET', `/announcements/${ann.id}/compliance/`)).data;
  check('التقرير: 2 مستلم، 2 استلام، 1 إقرار', report.total === 2 && report.delivered === 2 && report.acknowledged === 1);
  check('التقرير بلا محتوى', !JSON.stringify(report).includes(CANARY));
  check('مستلم لا يرى تقرير الالتزام', (await mohamed.client.call('GET', `/announcements/${ann.id}/compliance/`)).status === 403);
  const remind = await manager.client.call('POST', `/announcements/${ann.id}/remind/`);
  check('تذكير يصل لمن لم يقر فقط (sara)', remind.data?.reminded === 1);
  const saraNotes = (await sara.client.call('GET', '/notifications/')).data.results.map((n) => n.kind);
  check('sara: إشعار تعميم + تذكير', saraNotes.includes('announcement') && saraNotes.includes('announcement_reminder'));
  const mohamedNotes = JSON.stringify((await mohamed.client.call('GET', '/notifications/')).data);
  check('لا canary في الإشعارات (SEC-11)', !mohamedNotes.includes(CANARY) && !JSON.stringify(saraNotes).includes(CANARY));

  section('9) السحب');
  const withdrawn = await manager.client.call('POST', `/announcements/${ann.id}/withdraw/`);
  check('سحب التعميم', withdrawn.data?.status === 'withdrawn');
  const late = await sara.client.call('POST', `/announcements/${ann.id}/ack/`, ackBody(sara, ann, published.content_hash));
  check('لا إقرار بعد السحب ← 409', late.status === 409);

  section('الخلاصة');
  process.exitCode = summarize('e2e-announcements');
}

main().catch((err) => {
  console.error(`\nFAIL: ${err?.stack ?? err?.message ?? String(err)}`);
  process.exitCode = 1;
});
