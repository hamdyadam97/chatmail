/**
 * e2e-approvals.mjs — إثبات طرف-لطرف لمسار الاعتماد والإشعارات عبر خادم فعلي.
 *
 * التشغيل:   sh frontend/scripts/run-e2e-fresh.sh e2e-approvals.mjs
 *
 * السيناريو:
 *   1) ahmed يرسل مراسلة MLS حقيقية إلى mohamed (إلى) وsara (نسخة)؛ يفكّانها.
 *   2) ahmed يطلب اعتمادًا: خطوة 1 (mohamed) ثم خطوة 2 (sara).
 *   3) mohamed يوقّع قراره بمفتاح جهازه (Ed25519) على حمولة قانونية تربط القرار
 *      ببصمة SHA-256 للـciphertext الذي فكّه فعلًا ← تنتقل للخطوة 2.
 *   4) توقيع مزوّر / بصمة نسخة أخرى / تكرار القرار ← مرفوضة.
 *   5) sara تعتمد ← الطلب معتمد؛ ahmed يتلقى إشعارًا حيًا عبر /ws/notifications/.
 *   6) أي مشارك يتحقق من التوقيعات المخزنة بمفاتيح الأجهزة من الدليل.
 *   7) admin (sys_admin) ← 403 على الطلب؛ والإشعارات لا تحمل أي نص.
 */
import crypto from 'node:crypto';
import WebSocket from 'ws';
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
  claimFor,
  setupThread,
  catchUp,
  threadRows,
} from './e2e-lib.mjs';

const { check, section, summarize } = createChecker();
const SIGNING_CONTEXT = 'corr-approval-decision-v1\n';
const CANARY = `CANARY-APPROVAL-${crypto.randomUUID().slice(0, 8)}`;

/** نفس canonicalJson في الواجهة ونفس json.dumps(sort_keys, separators, ensure_ascii) في الخادم. */
function canonical(payload) {
  const body = Object.keys(payload)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(payload[k])}`)
    .join(',');
  return `{${body}}`.replace(/[^\u0000-\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function sha256B64(bytes) {
  return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('base64');
}

async function decide(person, request, decision, { contentHash, signKey } = {}) {
  const payload = canonical({
    approver_id: person.user.id,
    content_hash: contentHash ?? request.content_hash,
    correspondence_id: request.correspondence.id,
    decided_at: new Date().toISOString(),
    decision,
    device_id: person.dev.deviceId,
    on_behalf_of: null,
    request_id: request.id,
    step_order: request.current_step_order,
  });
  const payloadBytes = enc.encode(payload);
  const signature = crypto.sign(null, Buffer.concat([Buffer.from(SIGNING_CONTEXT), payloadBytes]), signKey ?? person.dev.signKey);
  return person.client.call('POST', `/approvals/${request.id}/decide/`, {
    payload: u8ToB64(payloadBytes),
    signature: u8ToB64(signature),
    device_id: person.dev.deviceId,
  });
}

function openNotificationsSocket(person) {
  return new Promise(async (resolve, reject) => {
    const t = await person.client.call('GET', '/notifications/ws-ticket/');
    const wsBase = BASE_URL.replace(/^http/, 'ws').replace(/\/api\/v1\/?$/, '');
    const ws = new WebSocket(`${wsBase}/ws/notifications/?ticket=${encodeURIComponent(t.data.ticket)}`);
    const frames = [];
    ws.on('message', (raw) => frames.push(JSON.parse(String(raw))));
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('error', reject);
  });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function main() {
  console.log(`e2e-approvals — الخادم: ${BASE_URL}`);

  section('1) دخول + أجهزة + مراسلة MLS حقيقية');
  const people = {};
  for (const [name, pw] of [['ahmed', 'Ahmed@12345'], ['mohamed', 'Mohamed@12345'], ['sara', 'Sara@12345'], ['admin', 'Admin@12345']]) {
    const session = await login(name, pw);
    people[name] = { ...session, dev: await bootstrapDevice(session.client, session.user, `e2e-appr-${name}`) };
  }
  const { ahmed, mohamed, sara, admin } = people;
  check('أربعة أجهزة جاهزة', Object.values(people).every((p) => p.dev.deviceId));

  const ahmedSocket = await openNotificationsSocket(ahmed);
  check('ahmed متصل بـ /ws/notifications/', ahmedSocket.ws.readyState === WebSocket.OPEN);

  const groupId = crypto.getRandomValues(new Uint8Array(16));
  const prep = await ahmed.client.call('POST', '/correspondences/', {
    to_user_ids: [mohamed.user.id],
    cc_user_ids: [sara.user.id],
    priority: 'urgent',
    mls_group_id: u8ToB64(groupId),
    client_ref: crypto.randomUUID(),
  });
  const corr = prep.data;
  const claimed = await claimFor(ahmed.client, [mohamed.dev.deviceId, sara.dev.deviceId]);
  await setupThread(ahmed, corr.thread.id, groupId, claimed, [mohamed.user.id, sara.user.id]);
  const content = { kind: 'correspondence', correspondence_id: corr.id, subject: `طلب شراء ${CANARY}`, body: `المبلغ 12,500 ${CANARY}`, attachments: [] };
  const sent = await ahmed.client.call('POST', `/correspondences/${corr.id}/send/`, {
    mls_payload: u8ToB64(ahmed.dev.mls.encrypt(groupId, encodeContent(content))),
    client_msg_id: crypto.randomUUID(),
    epoch: 1,
    sender_device_id: ahmed.dev.deviceId,
  });
  check('إرسال المراسلة', sent.status === 200, sent.data?.reference_number);

  const reviewed = {};
  for (const person of [mohamed, sara]) {
    const detail = (await person.client.call('GET', `/correspondences/${corr.id}/`)).data;
    const state = { dev: person.dev, lastSeq: 0, joined: false, joinEpoch: 0 };
    const got = catchUp(state, await threadRows(person.client, corr.thread.id), groupId).get(detail.content.seq);
    check(`${person.user.username} فكّ المحتوى`, decodeContent(got.plaintext).subject === content.subject);
    // البصمة تُحسب على الـciphertext الذي فُك فعلًا — لا على ما يدّعيه الخادم كبصمة.
    reviewed[person.user.username] = sha256B64(b64ToU8(detail.content.mls_payload));
  }

  section('2) ahmed يطلب الاعتماد (خطوتان متسلسلتان)');
  const outsider = await ahmed.client.call('POST', '/approvals/', {
    correspondence_id: corr.id,
    steps: [{ type: 'all', approver_ids: [admin.user.id] }],
  });
  check('رفض معتمد ليس من مستلمي المراسلة', outsider.status === 400 && outsider.data?.not_participants?.[0] === admin.user.id);
  const created = await ahmed.client.call('POST', '/approvals/', {
    correspondence_id: corr.id,
    steps: [
      { type: 'any', approver_ids: [mohamed.user.id] },
      { type: 'all', approver_ids: [sara.user.id] },
    ],
  });
  check('إنشاء الطلب', created.status === 201, `HTTP ${created.status}`);
  let request = created.data;
  check('بصمة الطلب = بصمة ما فكّه المعتمد', request.content_hash === reviewed.mohamed);
  const mPending = await mohamed.client.call('GET', '/approvals/?box=pending_mine');
  check('الطلب في «بانتظار قراري» لدى mohamed', mPending.data.some((r) => r.id === request.id));
  const sPending = await sara.client.call('GET', '/approvals/?box=pending_mine');
  check('ليس لدى sara قبل وصول خطوتها', !sPending.data.some((r) => r.id === request.id));

  section('3) admin (sys_admin) لا يرى شيئًا');
  check('admin: الطلب 403', (await admin.client.call('GET', `/approvals/${request.id}/`)).status === 403);
  check('admin: لا قرار ممكن', (await decide(admin, request, 'approved')).status === 403);

  section('4) قرارات مرفوضة');
  check('sara قبل خطوتها ← 403', (await decide(sara, request, 'approved')).status === 403);
  const forged = await decide(mohamed, request, 'approved', { signKey: sara.dev.signKey });
  check('توقيع بمفتاح جهاز آخر ← 400', forged.status === 400, JSON.stringify(forged.data));
  const otherVersion = await decide(mohamed, request, 'approved', { contentHash: sha256B64(enc.encode('نسخة أخرى')) });
  check('بصمة نسخة مختلفة ← 400', otherVersion.status === 400);

  section('5) mohamed ثم sara يعتمدان بتوقيع أجهزتهم');
  const d1 = await decide(mohamed, request, 'approved');
  check('قرار mohamed مقبول', d1.status === 201, `HTTP ${d1.status}`);
  request = d1.data;
  check('انتقل الطلب للخطوة 2', request.current_step_order === 2 && request.status === 'pending');
  check('تكرار قرار mohamed ← مرفوض', (await decide(mohamed, request, 'approved')).status === 403);
  const d2 = await decide(sara, request, 'approved');
  check('قرار sara مقبول', d2.status === 201);
  request = d2.data;
  check('الطلب معتمد', request.status === 'approved');
  const pushed = await waitFor(() => ahmedSocket.frames.some((f) => f.notification?.kind === 'approval_decided'));
  check('ahmed تلقى إشعار القرار حيًا عبر WS', pushed);
  ahmedSocket.ws.close();

  section('6) أي مشارك يتحقق من التوقيعات المخزنة');
  const view = (await sara.client.call('GET', `/approvals/${request.id}/`)).data;
  const directory = await sara.client.call('POST', '/crypto/keys/query/', { user_ids: [mohamed.user.id, sara.user.id] });
  const devices = new Map(directory.data.users.flatMap((u) => u.devices.map((d) => [String(d.id), d.sign_pub])));
  for (const step of view.steps) {
    for (const { user, decision } of step.approvers) {
      const pub = crypto.createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(devices.get(decision.device_id), 'base64')]),
        format: 'der',
        type: 'spki',
      });
      const ok = crypto.verify(
        null,
        Buffer.concat([Buffer.from(SIGNING_CONTEXT), Buffer.from(decision.payload, 'base64')]),
        pub,
        Buffer.from(decision.signature, 'base64'),
      );
      const parsed = JSON.parse(dec.decode(b64ToU8(decision.payload)));
      check(`توقيع ${user.username} صحيح ومربوط بالنسخة`, ok && parsed.content_hash === reviewed.sara && parsed.decision === 'approved');
    }
  }
  const done = await ahmed.client.call('POST', `/approvals/${request.id}/complete/`);
  check('ahmed يُكمل المعاملة', done.data?.status === 'completed');

  section('7) الإشعارات عامة الصياغة');
  const mNotes = await mohamed.client.call('GET', '/notifications/');
  const kinds = new Set(mNotes.data.results.map((n) => n.kind));
  check('mohamed: إشعار مراسلة جديدة + طلب اعتماد', kinds.has('new_correspondence') && kinds.has('approval_requested'));
  const allText = JSON.stringify([mNotes.data, (await ahmed.client.call('GET', '/notifications/')).data, ahmedSocket.frames]);
  check('لا canary في أي إشعار (SEC-11)', !allText.includes(CANARY) && !allText.includes('طلب شراء'));

  section('الخلاصة');
  process.exitCode = summarize('e2e-approvals');
}

main().catch((err) => {
  console.error(`\nFAIL: ${err?.stack ?? err?.message ?? String(err)}`);
  process.exitCode = 1;
});
