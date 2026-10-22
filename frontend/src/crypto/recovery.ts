/**
 * الاستعادة (docs/phase1/03 §3.6):
 * - Recovery Key: 256-bit عشوائي يُعرض مرة واحدة كسلاسل base32 مقروءة.
 * - KEK = HKDF-SHA256(recovery_key, salt, info) — لا يُشتق إلا محليًا.
 * - Recovery Bundle = {بذرة الهوية، بذور الأجهزة، حالة المجموعات (export_state
 *   من الغلاف)} مشفّر AES-256-GCM بالـKEK قبل أي رفع.
 *
 * TODO(endpoint): لا يوجد بعد endpoint backend لرفع النسخة الاحتياطية
 * (العقد يذكر POST …/crypto/ دون مسار نهائي). لذلك `uploadBackup` حاليًا
 * سجلّ وعد: يخزن الـciphertext في IndexedDB (مخزن backups) معلّمًا
 * pending_endpoint: true ويطبع تحذيرًا — عند اعتماد endpoint الـbackend
 * يُستبدل الجسم الداخلي فقط، والتشفير/الفك أعلى هذه الدالة لا يتغير.
 */
import { getAllRecords, putRecord } from './keystore';import { u8ToBase32, base32ToU8, u8ToB64, b64ToU8, randomBytes } from './encoding';
import {
  deviceFromSeeds,
  identityFromSeed,
  listDeviceKeys,
  loadIdentity,
  type StoredDeviceKeys,
  type StoredIdentity,
} from './identity';
import { exportGroupState, importGroupState, resetMlsSession } from './mls';
import { useAuthUser } from './authBridge';

const HKDF_SALT = new TextEncoder().encode('correspondence-recovery-v1');
const HKDF_INFO_KEK = new TextEncoder().encode('recovery-kek');

export interface RecoveryKeyDisplay {
  /** المفتاح كما يُعرض للمستخدم: 8 مجموعات من 7 رموز base32. */
  groups: string[];
  /** بايتات المفتاح الخام (تُستخدم محليًا فقط للاشتقاق). */
  raw: Uint8Array;
}

/** يولّد مفتاح استعادة جديدًا ويعرضه بصيغة مقروءة مرة واحدة. */
export function generateRecoveryKey(): RecoveryKeyDisplay {
  const raw = randomBytes(32);
  const encoded = u8ToBase32(raw);
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) groups.push(encoded.slice(i * 7, i * 7 + 7));
  return { groups, raw };
}

/** KEK للتغليف: HKDF-SHA256(recovery_key) — يُشتق في الذاكرة فقط. */
async function deriveKek(recoveryKey: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', recoveryKey, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO_KEK },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface RecoveryBundlePayload {
  version: 1;
  /** null عندما أُنشئت الهوية على جهاز آخر ولا يملك هذا الجهاز بذرتها. */
  identity_seed: string | null;
  devices: Array<{
    device_id: number | string;
    label: string;
    platform: string;
    sign_seed: string;
    kem_seed: string;
  }>;
  groups_state: string;
  created_at: string;
}

export interface RecoveryBackupRecord {
  id: string;
  version: 1;
  kdf: 'HKDF-SHA256';
  cipher: 'AES-256-GCM';
  iv: string;
  ciphertext: string;
  payload_hash: string;
  created_at: string;
  pending_endpoint: true;
}

/** يبني الحزمة من الحالة المحلية ويشفّرها بالـKEK. */
export async function encryptRecoveryBundle(recoveryKey: Uint8Array): Promise<RecoveryBackupRecord> {
  const userId = useAuthUser().id;
  const identity = await loadIdentity(userId);
  if (!identity) throw new Error('لا هوية محلية لبناء حزمة استعادة — هيّئ الجهاز أولًا');
  const devices = await listDeviceKeys(userId);
  if (devices.length === 0) throw new Error('لا أجهزة محلية لبناء حزمة استعادة');

  const payload: RecoveryBundlePayload = {
    version: 1,
    identity_seed: identity.seed ? u8ToB64(identity.seed) : null,
    devices: devices.map((d) => ({
      device_id: d.deviceId,
      label: d.label,
      platform: d.platform,
      sign_seed: u8ToB64(d.signSeed),
      kem_seed: u8ToB64(d.kemSeed),
    })),
    groups_state: u8ToB64(await exportGroupState()),
    created_at: new Date().toISOString(),
  };
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const kek = await deriveKek(recoveryKey);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, plaintext);
  return {
    id: crypto.randomUUID(),
    version: 1,
    kdf: 'HKDF-SHA256',
    cipher: 'AES-256-GCM',
    iv: u8ToB64(iv),
    ciphertext: u8ToB64(new Uint8Array(ct)),
    payload_hash: await sha256Hex(plaintext),
    created_at: payload.created_at,
    pending_endpoint: true,
  };
}

/**
 * TODO(endpoint): الاستبدال المستقبلي — POST الـciphertext إلى
 * ‎/api/v1/crypto/… عندما يعتمده الـbackend. حاليًا: مخزن محلي مؤقت.
 */
export async function uploadBackup(record: RecoveryBackupRecord): Promise<{ stored: string }> {
  console.warn('[recovery] TODO(endpoint): لا يوجد endpoint رفع بعد — خُزّنت النسخة محليًا معلّمة pending_endpoint', {
    id: record.id,
    bytes: record.ciphertext.length,
  });
  await putRecord('backups', record.id, record);
  return { stored: 'local-pending-endpoint' };
}

export interface RestoreResult {
  identity: StoredIdentity;
  devices: StoredDeviceKeys[];
}

/**
 * يستعيد من مفتاح مُدخل: يفك أحدث نسخة مخزنة، يكتب البذور محليًا، يستورد
 * حالة المجموعات، ويسقط الجلسة المخبأة لتُبنى من جديد.
 */
export async function restoreFromRecoveryKey(keyGroups: string[]): Promise<RestoreResult> {
  const raw = base32ToU8(keyGroups.join(''));
  if (raw.length !== 32) throw new Error('مفتاح الاستعادة غير مكتمل — يجب أن يكون 8 مجموعات من 7 رموز');
  const backups = await getAllRecords<RecoveryBackupRecord>('backups');
  if (backups.length === 0) {
    throw new Error('لا نسخة استعادة محلية بعد — عند اعتماد endpoint السيرفر ستُجلب النسخ من هناك');
  }
  const latest = backups.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const kek = await deriveKek(raw);
  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToU8(latest.iv) }, kek, b64ToU8(latest.ciphertext)),
    );
  } catch {
    throw new Error('تعذر فك النسخة الاحتياطية — المفتاح غير صحيح أو النسخة تالفة');
  }
  const payload = JSON.parse(new TextDecoder().decode(plaintext)) as RecoveryBundlePayload;

  if (!payload.identity_seed) {
    throw new Error('هذه النسخة لا تتضمن بذرة الهوية (أُنشئت على جهاز آخر) — استعد من الجهاز الأصلي');
  }
  const identityMaterial = await identityFromSeed(b64ToU8(payload.identity_seed));
  const userId = useAuthUser().id;
  const identity: StoredIdentity = {
    userId,
    seed: b64ToU8(payload.identity_seed),
    pub: identityMaterial.pub,
    createdAt: payload.created_at,
  };

  const devices: StoredDeviceKeys[] = [];
  for (const d of payload.devices) {
    const material = await deviceFromSeeds(b64ToU8(d.sign_seed), b64ToU8(d.kem_seed));
    devices.push({
      userId,
      deviceId: d.device_id,
      label: d.label,
      platform: d.platform,
      signSeed: b64ToU8(d.sign_seed),
      kemSeed: b64ToU8(d.kem_seed),
      signPub: material.sign.pub,
      kemPub: material.kem.pub,
      status: 'active',
      createdAt: payload.created_at,
    });
  }

  putRecord('identity', `identity:${userId}`, identity);
  for (const device of devices) {
    putRecord('deviceKeys', `${userId}:${device.deviceId}`, device);
  }
  await importGroupState(b64ToU8(payload.groups_state));
  await resetMlsSession();
  return { identity, devices };
}
