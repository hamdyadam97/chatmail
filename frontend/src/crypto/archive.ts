/**
 * الأرشيف المركزي — نسخة صريحة لمستلم مؤسسي معلن (docs/phase1/README §3)، لا باب خلفي.
 *
 * - مفتاح الأرشيف X25519: يُنشأ على جهاز ضابط أرشيف، والخاص منه لا يغادر أجهزة
 *   الضباط إلا مشفّرًا لمفتاح KEM جهاز ضابط آخر. العام منشور وموقّع من الجهاز المُنشئ.
 * - «الختم» (seal): X25519 (مؤقت ↔ المستلم) ← HKDF-SHA256 ← AES-256-GCM، مع AAD
 *   يربط النص بسياقه (نسخة مراسلة بعينها / مشاركة مفتاح لجهاز بعينه).
 * - نسخة المراسلة يصنعها المرسل عند الإرسال فقط للمصنّفة «قابلة للأرشفة المؤسسية».
 */
import { apiFetch } from '../shared/api';
import { b64ToU8, randomBytes, u8ToB64, utf8ToU8 } from './encoding';
import { deviceFromSeeds, loadCurrentDevice, signWithCurrentDevice, x25519FromSeed } from './identity';
import { getRecord, putRecord } from './keystore';
import { useAuthUser } from './authBridge';

const KEY_CONTEXT = 'corr-archive-key-v1\n';
const HKDF_INFO = utf8ToU8('corr-archive-seal-v1');

export interface ArchiveKeyInfo {
  id: string;
  version: number;
  public_key: string;
  created_by: string;
  created_at: string;
  signer_sign_pub: string;
  signature: string;
}

export interface ArchiveDeviceStatus {
  device_id: string;
  label: string;
  user: string;
  kem_pub: string;
  has_key: boolean;
}

export interface ArchiveKeyState {
  key: ArchiveKeyInfo | null;
  is_officer: boolean;
  devices: ArchiveDeviceStatus[];
  next_version: number;
}

export interface Sealed {
  ephemeral_pub: string;
  iv: string;
  ciphertext: string;
}

export const archiveKeyApi = {
  state: () => apiFetch<ArchiveKeyState>('/archive/key/'),
  create: (body: { device_id: string; public_key: string; signature: string }) =>
    apiFetch<ArchiveKeyInfo>('/archive/key/', { method: 'POST', body }),
  share: (body: Sealed & { key_id: string; recipient_device_id: string }) =>
    apiFetch<{ id: string }>('/archive/key/shares/', { method: 'POST', body }),
  myShare: (deviceId: string) =>
    apiFetch<Sealed & { key_id: string }>(`/archive/key/shares/mine/?device_id=${encodeURIComponent(deviceId)}`),
};

// --- الختم -------------------------------------------------------------------------------

async function sealKey(ourPrivate: CryptoKey, theirPub: Uint8Array, ephPub: Uint8Array, recipientPub: Uint8Array) {
  const peer = await crypto.subtle.importKey('raw', theirPub, { name: 'X25519' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'X25519', public: peer }, ourPrivate, 256);
  const base = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const salt = new Uint8Array(ephPub.length + recipientPub.length);
  salt.set(ephPub);
  salt.set(recipientPub, ephPub.length);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: HKDF_INFO },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(recipientPub: Uint8Array, plaintext: Uint8Array, aad: string): Promise<Sealed> {
  const eph = await x25519FromSeed(randomBytes(32));
  const key = await sealKey(eph.privateKey, recipientPub, eph.pub, recipientPub);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8ToU8(aad) }, key, plaintext);
  return { ephemeral_pub: u8ToB64(eph.pub), iv: u8ToB64(iv), ciphertext: u8ToB64(new Uint8Array(ct)) };
}

export async function unseal(
  recipient: { privateKey: CryptoKey; pub: Uint8Array },
  sealed: Sealed,
  aad: string,
): Promise<Uint8Array> {
  const ephPub = b64ToU8(sealed.ephemeral_pub);
  const key = await sealKey(recipient.privateKey, ephPub, ephPub, recipient.pub);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToU8(sealed.iv), additionalData: utf8ToU8(aad) },
    key,
    b64ToU8(sealed.ciphertext),
  );
  return new Uint8Array(plain);
}

// --- مفتاح الأرشيف -----------------------------------------------------------------------

function keySigningMessage(version: number, pub: Uint8Array): Uint8Array {
  const head = utf8ToU8(`${KEY_CONTEXT}${version}\n`);
  const out = new Uint8Array(head.length + pub.length);
  out.set(head);
  out.set(pub, head.length);
  return out;
}

/** يتحقق أن المفتاح العام موقّع فعلًا من الجهاز المُنشئ المعلن. */
export async function verifyArchiveKey(key: ArchiveKeyInfo): Promise<boolean> {
  try {
    const signer = await crypto.subtle.importKey('raw', b64ToU8(key.signer_sign_pub), { name: 'Ed25519' }, false, ['verify']);
    return crypto.subtle.verify({ name: 'Ed25519' }, signer, b64ToU8(key.signature), keySigningMessage(key.version, b64ToU8(key.public_key)));
  } catch {
    return false;
  }
}

interface StoredArchiveKey {
  keyId: string;
  seed: Uint8Array;
  pub: Uint8Array;
}

const recordKey = (keyId: string) => `archive-key:${keyId}`;

async function deviceId(): Promise<string> {
  const device = await loadCurrentDevice(useAuthUser().id);
  if (!device || device.status !== 'active') throw new Error('يلزم جهاز موثّق نشط');
  return String(device.deviceId);
}

/** يُنشئ مفتاح الأرشيف على هذا الجهاز (أول ضابط أرشيف). */
export async function createArchiveKey(nextVersion: number): Promise<ArchiveKeyInfo> {
  const seed = randomBytes(32);
  const material = await x25519FromSeed(seed);
  const { signature } = await signWithCurrentDevice(useAuthUser().id, keySigningMessage(nextVersion, material.pub));
  const key = await archiveKeyApi.create({
    device_id: await deviceId(),
    public_key: u8ToB64(material.pub),
    signature: u8ToB64(signature),
  });
  await putRecord<StoredArchiveKey>('identity', recordKey(key.id), { keyId: key.id, seed, pub: material.pub });
  return key;
}

/** مفتاح الأرشيف الخاص على هذا الجهاز: محليًا، أو من مشاركة زميل (تُفك بمفتاح KEM الجهاز). */
export async function loadArchiveKey(keyId: string): Promise<{ privateKey: CryptoKey; pub: Uint8Array } | null> {
  let stored = await getRecord<StoredArchiveKey>('identity', recordKey(keyId));
  if (!stored) {
    const device = await loadCurrentDevice(useAuthUser().id);
    if (!device) return null;
    let share;
    try {
      share = await archiveKeyApi.myShare(String(device.deviceId));
    } catch {
      return null; // لم يُشارَك بعد
    }
    if (share.key_id !== keyId) return null;
    const kem = (await deviceFromSeeds(device.signSeed, device.kemSeed)).kem;
    const seed = await unseal({ privateKey: kem.privateKey, pub: kem.pub }, share, `archive-key-share-v1|${keyId}|${device.deviceId}`);
    const material = await x25519FromSeed(seed);
    stored = { keyId, seed, pub: material.pub };
    await putRecord('identity', recordKey(keyId), stored);
  }
  const material = await x25519FromSeed(stored.seed);
  return { privateKey: material.privateKey, pub: material.pub };
}

/** يشارك مفتاح الأرشيف مع جهاز ضابط أرشيف آخر (مشفّرًا لمفتاح KEM جهازه). */
export async function shareArchiveKey(keyId: string, target: ArchiveDeviceStatus): Promise<void> {
  const stored = await getRecord<StoredArchiveKey>('identity', recordKey(keyId));
  if (!stored) throw new Error('مفتاح الأرشيف غير موجود على هذا الجهاز');
  const sealed = await seal(b64ToU8(target.kem_pub), stored.seed, `archive-key-share-v1|${keyId}|${target.device_id}`);
  await archiveKeyApi.share({ ...sealed, key_id: keyId, recipient_device_id: target.device_id });
}

// --- نسخ المراسلات ----------------------------------------------------------------------

export const copyAad = (keyId: string, clientMsgId: string) => `corr-archive-copy-v1|${keyId}|${clientMsgId}`;

/** نسخة الأرشيف لمحتوى مراسلة (يصنعها المرسل). يرفض مفتاحًا غير موقّع من جهازه المُنشئ. */
export async function sealArchiveCopy(
  key: ArchiveKeyInfo,
  contentJson: string,
  clientMsgId: string,
): Promise<Sealed & { key_id: string }> {
  if (!(await verifyArchiveKey(key))) throw new Error('مفتاح الأرشيف المركزي غير موقّع توقيعًا صحيحًا — أوقف الإرسال وأبلغ مسؤول النظام');
  const sealed = await seal(b64ToU8(key.public_key), utf8ToU8(contentJson), copyAad(key.id, clientMsgId));
  return { ...sealed, key_id: key.id };
}
