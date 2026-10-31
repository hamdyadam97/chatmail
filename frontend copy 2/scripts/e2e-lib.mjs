/**
 * e2e-lib.mjs — مشاركات سكربتات الإثبار الطرف-لطرف (e2e-chat / e2e-multidevice).
 *
 * التشفير كله عبر spikes/mls/pkg/node بنفس نمط اختبارات الـSpike (بذرة 32B
 * ← الغلاف يوسّطها 64)، والتوقيعات بـnode:crypto. user.id.bytes لدى
 * الـbackend هو الـ16 بايت الخام للـUUID (Django UUIDField).
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:8000/api/v1').replace(/\/$/, '');
export const enc = new TextEncoder();
export const dec = new TextDecoder();

export const { SpikeClient } = require(path.join(__dirname, '..', '..', 'spikes', 'mls', 'pkg', 'node', 'mls_spike.js'));

// ---------------------------------------------------------------------------
// فحوصات وملخص — كل سكربت يأخذ نسخته الخاصة.
// ---------------------------------------------------------------------------

export function createChecker() {
  const results = [];
  return {
    results,
    check(name, ok, detail = '') {
      results.push({ name, ok });
      console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
    },
    section(title) {
      console.log(`\n== ${title} ==`);
    },
    /** يطبع الخلاصة ويعيد كود الخروج المقترح (0 نجاح، 1 فشل). */
    summarize(label) {
      const failed = results.filter((r) => !r.ok);
      for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
      console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} [${label}] — ${results.length - failed.length}/${results.length} فحوصات ناجحة`);
      return failed.length === 0 ? 0 : 1;
    },
  };
}

// ---------------------------------------------------------------------------
// ترميز وتراكيب بايتات.
// ---------------------------------------------------------------------------

/** user.id.bytes — الـ16 بايت الخام للـUUID. */
export function userIdBytes(userId) {
  const hex = String(userId).replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`userId ليس UUID صالحًا: ${userId}`);
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

export const u8ToB64 = (bytes) => Buffer.from(bytes).toString('base64');
export const b64ToU8 = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));
export const b64urlToU8 = (value) => new Uint8Array(Buffer.from(value, 'base64url'));

export function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// توليد المفاتيح — بنمط اختبارات الـSpike حرفيًا.
// ---------------------------------------------------------------------------

/** ed25519: pub (raw 32) + seed (32 من JWK.d) + privateKey للتوقيع. */
export function ed25519Material() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  const pub = new Uint8Array(pubDer.subarray(pubDer.length - 32));
  const privJwk = privateKey.export({ format: 'jwk' });
  const seed = b64urlToU8(privJwk.d);
  return { pub, seed, privateKey };
}

/** x25519: العام الخام فقط (32B من ذيل SPKI DER). */
export function x25519Public() {
  const { publicKey } = crypto.generateKeyPairSync('x25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return new Uint8Array(der.subarray(der.length - 32));
}

// ---------------------------------------------------------------------------
// عميل API خام — جرة كوكيز + بيرِر توكن + User-Agent مميز لكل جهاز.
// ---------------------------------------------------------------------------

export function makeClient(userAgent = 'node-e2e') {
  const jar = new Map();
  let bearer = null;

  async function call(method, pathName, body) {
    const headers = { Accept: 'application/json', 'User-Agent': userAgent };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (jar.size > 0) headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${BASE_URL}${pathName}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair] = sc.split(';');
      const eq = pair.indexOf('=');
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data };
  }

  return {
    call,
    setBearer: (token) => {
      bearer = token;
    },
    bearer: () => bearer,
  };
}

export async function login(username, password, userAgent) {
  const client = makeClient(userAgent ?? `node-e2e-${username}`);
  const res = await client.call('POST', '/auth/login/', { username, password });
  if (res.status !== 200) {
    throw new Error(`فشل دخول ${username} (HTTP ${res.status}): ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  if (res.data?.mfa_required) {
    throw new Error(`المستخدم ${username} يتطلب MFA — السيناريو يفترض حسابات seed_demo بلا MFA`);
  }
  client.setBearer(res.data.access);
  return { client, user: res.data.user };
}

// ---------------------------------------------------------------------------
// بوتستراب الهوية/الجهاز + رفع KeyPackage.
// ---------------------------------------------------------------------------

/**
 * يبني هوية+جهازًا ويرفع KP عبر pkg/node.
 * - نجاح bootstrap ← جهاز أول active فورًا.
 * - 409 ← هوية موجودة: نجلب identity_pub من الدليل ونسجّل جهازًا جديدًا
 *   (التوثيق بمفتاح الجهاز الجديد فوق identity_pub‖sign_pub‖kem_pub‖uid —
 *   تحقق الخادم الحرفي)، ثم إما اعتماد ذاتي (onConflict: 'self-approve')
 *   أو تركه pending ليعتمده جهاز آخر ('leave-pending').
 */
export async function bootstrapDevice(client, user, label, { onConflict = 'self-approve' } = {}) {
  const identity = ed25519Material();
  const deviceSign = ed25519Material();
  const kemPub = x25519Public();
  const uid = userIdBytes(user.id);

  const identityPub = identity.pub;
  const signPub = deviceSign.pub;

  const bootstrapSig = crypto.sign(null, concat(identityPub, signPub, kemPub, uid), identity.privateKey);
  const deviceSig = crypto.sign(null, concat(identityPub, signPub, kemPub, uid), deviceSign.privateKey);

  let deviceId = null;
  const boot = await client.call('POST', '/crypto/identity/', {
    identity_pub: u8ToB64(identityPub),
    bootstrap_sig: u8ToB64(bootstrapSig),
    device: {
      label,
      platform: 'node-e2e',
      sign_pub: u8ToB64(signPub),
      kem_pub: u8ToB64(kemPub),
      sig: u8ToB64(deviceSig),
    },
  });
  if (boot.status === 200 || boot.status === 201) {
    deviceId = boot.data?.device_id ?? null;
  } else if (boot.status === 409) {
    const selfQuery = await client.call('POST', '/crypto/keys/query/', { user_ids: [user.id] });
    const selfIdentityB64 = selfQuery.data?.users?.[0]?.identity_pub;
    if (!selfIdentityB64) throw new Error('تعذر جلب هويتي من الدليل بعد 409');
    const existingIdentityPub = b64ToU8(selfIdentityB64);
    const deviceSigForRegister = crypto.sign(
      null,
      concat(existingIdentityPub, signPub, kemPub, uid),
      deviceSign.privateKey,
    );
    const reg = await client.call('POST', '/crypto/devices/register/', {
      label,
      platform: 'node-e2e',
      sign_pub: u8ToB64(signPub),
      kem_pub: u8ToB64(kemPub),
      sig: u8ToB64(deviceSigForRegister),
    });
    if (reg.status !== 200 && reg.status !== 201) {
      throw new Error(`فشل تسجيل الجهاز بعد 409 (HTTP ${reg.status}): ${JSON.stringify(reg.data).slice(0, 200)}`);
    }
    deviceId = reg.data.id;
    if (onConflict === 'self-approve') {
      const approve = await client.call('POST', `/crypto/devices/${deviceId}/approve/`, {});
      if (approve.status >= 400) {
        throw new Error(`فشل اعتماد الجهاز ${deviceId} (HTTP ${approve.status}): ${JSON.stringify(approve.data).slice(0, 200)}`);
      }
    }
  } else {
    throw new Error(`فشل بوتستراب الهوية (HTTP ${boot.status}): ${JSON.stringify(boot.data).slice(0, 200)}`);
  }

  const mls = new SpikeClient(enc.encode(`${user.id}|${deviceId}`), deviceSign.seed);
  const kp = mls.key_package();
  const kpHash = crypto.createHash('sha256').update(Buffer.from(kp)).digest();
  const upload = await client.call('POST', '/crypto/keys/upload/', {
    keypackage: u8ToB64(kp),
    keypackage_hash: u8ToB64(kpHash),
    device_id: deviceId,
  });
  if (upload.status >= 400) {
    throw new Error(`فشل رفع KeyPackage (HTTP ${upload.status}): ${JSON.stringify(upload.data).slice(0, 200)}`);
  }

  return { mls, deviceId, identityPub, signPub, kemPub, signKey: deviceSign.privateKey };
}

/** يجلب أحدث Welcome من صفح رسائل (بقايا جولات سابقة قد تترك أكثر من واحد). */
export function latestWelcomeRow(messages) {
  const welcomeRows = (messages ?? []).filter((m) => m.kind === 'welcome');
  return welcomeRows[welcomeRows.length - 1];
}

// ---------------------------------------------------------------------------
// المراسلات الرسمية — مشتركة بين e2e-correspondence وe2e-approvals.
// ---------------------------------------------------------------------------

const subtle = globalThis.crypto.subtle;
const ATTACHMENT_AAD = enc.encode('corr-attachment-v1');

// --- صيغة المحتوى (مطابقة لـ content.ts) ------------------------------------

export function encodeContent(content) {
  return enc.encode(JSON.stringify({ v: 1, ...content }));
}

export function decodeContent(bytes) {
  const parsed = JSON.parse(dec.decode(bytes));
  if (parsed.v !== 1) throw new Error(`إصدار محتوى غير مدعوم: ${parsed.v}`);
  return parsed;
}

export async function encryptFile(plain) {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ATTACHMENT_AAD }, key, plain));
  const blob = new Uint8Array(iv.length + ct.length);
  blob.set(iv, 0);
  blob.set(ct, iv.length);
  const sha = new Uint8Array(await subtle.digest('SHA-256', blob));
  return { blob, rawKey, sha256: u8ToB64(sha) };
}

export async function decryptFile(blob, rawKeyB64) {
  const key = await subtle.importKey('raw', b64ToU8(rawKeyB64), 'AES-GCM', false, ['decrypt']);
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: blob.slice(0, 12), additionalData: ATTACHMENT_AAD },
    key,
    blob.slice(12),
  );
  return new Uint8Array(plain);
}

/** e2e-lib يرسل JSON فقط؛ الرفع الخام يمر بـfetch مباشر بنفس التوكن. */
export function uploadBlob(client, blob) {
  return client.raw('POST', '/attachments/', blob, 'application/octet-stream');
}

// --- MLS helpers -----------------------------------------------------------

export async function claimFor(client, deviceIds) {
  const claim = await client.call('POST', '/crypto/keys/claim/', { device_ids: deviceIds });
  if (claim.status >= 400) throw new Error(`فشل claim (HTTP ${claim.status})`);
  return claim.data;
}

/** إعداد مجموعة الخيط: Welcome لكل جهاز (epoch 0) ثم Commit (epoch 1). */
export async function setupThread(sender, threadId, groupId, claimed, recipientUserIds) {
  const [commitBytes, welcomeBytes] = sender.dev.mls.create_group(
    groupId,
    claimed.map((c) => b64ToU8(c.keypackage)),
  );
  // Welcome واحد مخزن مرة واحدة وموجّه لكل الأجهزة.
  const w = await sender.client.call('POST', `/conversations/${threadId}/messages/`, {
    kind: 'welcome',
    mls_payload: u8ToB64(welcomeBytes),
    client_msg_id: crypto.randomUUID(),
    epoch: 0,
    recipient_device_ids: claimed.map((item) => item.device_id),
  });
  if (w.status >= 400) throw new Error(`Welcome فشل (HTTP ${w.status}) ${JSON.stringify(w.data)}`);
  const c = await sender.client.call('POST', `/conversations/${threadId}/messages/`, {
    kind: 'commit',
    mls_payload: u8ToB64(commitBytes),
    client_msg_id: crypto.randomUUID(),
    sender_device_id: sender.dev.deviceId,
    epoch: 1,
    membership: { added_user_ids: recipientUserIds, removed_user_ids: [] },
  });
  if (c.status >= 400) throw new Error(`Commit فشل (HTTP ${c.status}) ${JSON.stringify(c.data)}`);
}

/**
 * لحاق عضو بالخيط: انضمام بالـWelcome الموجّه لجهازه، ثم معالجة ما بعده بالترتيب
 * متخطيًا رسائله هو؛ يعيد خريطة seq → {plaintext, sender_index}.
 */
export function catchUp(state, rows, groupId) {
  const out = new Map();
  for (const row of rows.sort((x, y) => x.seq - y.seq)) {
    if (row.seq <= state.lastSeq) continue;
    state.lastSeq = row.seq;
    if (row.kind === 'welcome') {
      if (!state.joined) {
        try {
          state.dev.mls.join_from_welcome(b64ToU8(row.mls_payload));
          state.joined = true;
          state.joinEpoch = Number(state.dev.mls.epoch(groupId));
        } catch {
          /* Welcome لجهاز آخر */
        }
      }
      continue;
    }
    if (!state.joined) continue;
    if (String(row.sender_device_id) === String(state.dev.deviceId)) continue;
    // ما قبل انضمامنا، والـCommit الذي أنشأ جيل انضمامنا نفسه (§8.3/3).
    if (row.epoch < state.joinEpoch || (row.kind === 'commit' && row.epoch <= state.joinEpoch)) continue;
    const r = state.dev.mls.process(groupId, b64ToU8(row.mls_payload));
    if (r.type === 'application') out.set(row.seq, { plaintext: r.plaintext, senderIndex: r.sender_index });
  }
  return out;
}

export async function threadRows(client, threadId) {
  const res = await client.call('GET', `/conversations/${threadId}/messages/?after_seq=0&limit=200`);
  if (res.status !== 200) throw new Error(`جلب الخيط فشل (HTTP ${res.status})`);
  return res.data.messages;
}

/** يتحقق أن مرسل MLS الموثّق هو (المستخدم، الجهاز) الذي يدّعيه الخادم. */
export function senderMatches(dev, groupId, senderUserId, senderDeviceId, senderIndex) {
  const expected = dev.mls.member_index(groupId, enc.encode(`${senderUserId}|${senderDeviceId}`));
  return Number(expected) === Number(senderIndex);
}

/** طلب خام (رفع/تنزيل bytes) بنفس هوية العميل. */
export function rawCaller(client) {
  return async (method, pathName, body, contentType) => {
    const res = await fetch(`${BASE_URL}${pathName}`, {
      method,
      headers: {
        Authorization: `Bearer ${client.bearer()}`,
        ...(contentType ? { 'Content-Type': contentType } : {}),
      },
      body,
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    let data = null;
    try {
      data = JSON.parse(dec.decode(bytes));
    } catch {
      data = null;
    }
    return { status: res.status, data, bytes };
  };
}

