/**
 * الاستعادة والنسخ الاحتياطي المشفّر (docs/phase1/03 §3.6).
 *
 * - Recovery Key: 256-bit عشوائي يُعرض مرة واحدة (13 مجموعة × 4 رموز base32). لا يُرسل
 *   للخادم أبدًا.
 * - منه يُشتق محليًا (HKDF-SHA256): مفتاح تشفير النسخة (AES-256-GCM، غير قابل
 *   للتصدير، يُحفظ كمقبض CryptoKey ليعمل النسخ التلقائي) + key_id (بصمة أحادية
 *   الاتجاه تقول أي نسخ يفتحها هذا المفتاح — ليست المفتاح).
 * - النسخة = لقطة المخزن المحلي كله (الهوية، مفاتيح الجهاز، حالة MLS، والمراسلات
 *   والمحادثات المفكوكة) مشفّرة قبل الرفع، وAAD يربطها بالمستخدم والجهاز والمفتاح.
 *   فك MLS لمرة واحدة، فبدون النصوص المفكوكة لا يُسترجع البريد القديم.
 * - كل رفع موقّع بمفتاح الجهاز؛ والنسخ يتجدد تلقائيًا بعد التغييرات.
 * - الاستعادة على متصفح جديد = يتولى هذا المتصفح الجهازَ المفقود نفسه (نفس
 *   مفاتيحه وحالته)، ويُسحب تسجيله المعلّق، ويُسجَّل حدث شفافية.
 *
 * حدّ معروف: إن كان الجهاز القديم ما زال يعمل فلا تستعد عليه من متصفح آخر —
 * اعتمد الجهاز الجديد منه بدلًا من ذلك (نسختان من الجهاز نفسه تتباعد حالتهما).
 */
import { exportSnapshot, getPublic, importSnapshot, LOCAL_ONLY_META, onStoreWrite, putPublic } from './keystore';
import { base32ToU8, randomBytes, u8ToB64, u8ToBase32, u8ToHex, utf8ToU8 } from './encoding';
import { loadCurrentDevice, signWithCurrentDevice } from './identity';
import { resetMlsSession } from './mls';
import { cryptoApi, type KeyBackupInfo } from './api';
import { useAuthUser } from './authBridge';

const HKDF_SALT = utf8ToU8('correspondence-recovery-v1');
const INFO_KEK = utf8ToU8('recovery-kek');
const INFO_KEY_ID = utf8ToU8('recovery-key-id');
const BACKUP_CONTEXT = 'key-backup-v1\n';
const RESTORE_CONTEXT = 'device-restore-v1\n';

/** بعد آخر تغيير ننتظر قليلًا (تُجمع الدفعات)، وبين رفعين دقيقة على الأقل. */
const DEBOUNCE_MS = 15_000;
const MIN_INTERVAL_MS = 60_000;

/** 32 بايت = 52 رمز base32 بالضبط → 13 مجموعة من 4 رموز. */
const KEY_CHARS = 52;
const GROUP = 4;

export interface RecoveryKeyDisplay {
  /** المفتاح كما يُعرض للمستخدم: 13 مجموعة من 4 رموز base32. */
  groups: string[];
  raw: Uint8Array;
}

export function generateRecoveryKey(): RecoveryKeyDisplay {
  const raw = randomBytes(32);
  const encoded = u8ToBase32(raw);
  const groups: string[] = [];
  for (let i = 0; i < KEY_CHARS; i += GROUP) groups.push(encoded.slice(i, i + GROUP));
  return { groups, raw };
}

/** يقبل المفتاح بشرطات أو مسافات أو بدونها، وبأي حالة أحرف. */
export function parseRecoveryKey(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (clean.length !== KEY_CHARS) throw new Error('مفتاح الاستعادة غير مكتمل — يجب أن يكون 13 مجموعة من 4 رموز');
  const raw = base32ToU8(clean);
  if (raw.length !== 32) throw new Error('مفتاح الاستعادة غير صالح');
  return raw;
}

async function deriveKeys(raw: Uint8Array): Promise<{ kek: CryptoKey; keyId: string }> {
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const kek = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: INFO_KEK },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const idBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: INFO_KEY_ID }, base, 128);
  return { kek, keyId: u8ToHex(new Uint8Array(idBits)) };
}

function aad(userId: string, deviceId: string, keyId: string): Uint8Array {
  return utf8ToU8(`corr-backup-v1|${userId}|${deviceId}|${keyId}`);
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

// --- الحالة المحلية -------------------------------------------------------------

export interface RecoveryStatus {
  configured: boolean;
  keyId: string | null;
  lastBackupAt: string | null;
  lastError: string | null;
}

export async function recoveryStatus(): Promise<RecoveryStatus> {
  const [kek, keyId, at, error] = await Promise.all([
    getPublic<CryptoKey>('meta', 'recovery_kek'),
    getPublic<string>('meta', 'recovery_key_id'),
    getPublic<string>('meta', 'backup_last_at'),
    getPublic<string>('meta', 'backup_last_error'),
  ]);
  return { configured: Boolean(kek && keyId), keyId: keyId ?? null, lastBackupAt: at ?? null, lastError: error ?? null };
}

async function storeRecoveryKey(raw: Uint8Array): Promise<string> {
  const { kek, keyId } = await deriveKeys(raw);
  await putPublic('meta', 'recovery_kek', kek);
  await putPublic('meta', 'recovery_key_id', keyId);
  await putPublic('meta', 'backup_last_hash', null);
  return keyId;
}

/** هل يفتح هذا المفتاح نسخًا موجودة؟ (للتحقق قبل اعتماده على جهاز ثانٍ). */
export async function checkKeyAgainstServer(raw: Uint8Array): Promise<{ matches: number; total: number }> {
  const { keyId } = await deriveKeys(raw);
  const all = await cryptoApi.listBackups();
  return { matches: all.filter((b) => b.key_id === keyId).length, total: all.length };
}

/** يعتمد المفتاح على هذا الجهاز ويرفع أول نسخة فورًا. */
export async function enableRecovery(raw: Uint8Array): Promise<KeyBackupInfo | null> {
  await storeRecoveryKey(raw);
  return backupNow({ force: true });
}

// --- الرفع ---------------------------------------------------------------------

let running: Promise<KeyBackupInfo | null> | null = null;

/** يرفع لقطة مشفّرة إن تغيّر شيء منذ آخر رفع (أو دائمًا مع force). */
export function backupNow(opts: { force?: boolean } = {}): Promise<KeyBackupInfo | null> {
  running ??= doBackup(Boolean(opts.force)).finally(() => {
    running = null;
  });
  return running;
}

async function doBackup(force: boolean): Promise<KeyBackupInfo | null> {
  const userId = String(useAuthUser().id);
  const kek = await getPublic<CryptoKey>('meta', 'recovery_kek');
  const keyId = await getPublic<string>('meta', 'recovery_key_id');
  if (!kek || !keyId) return null;
  const device = await loadCurrentDevice(userId);
  if (!device || device.status !== 'active') return null;
  const deviceId = String(device.deviceId);
  try {
    const snapshot = await exportSnapshot();
    const snapshotHash = u8ToHex(await sha256(snapshot));
    if (!force && snapshotHash === (await getPublic<string>('meta', 'backup_last_hash'))) return null;

    const iv = randomBytes(12);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(userId, deviceId, keyId) }, kek, snapshot),
    );
    const message = BACKUP_CONTEXT + [userId, deviceId, keyId, u8ToB64(iv), u8ToHex(await sha256(ciphertext))].join('\n');
    const { signature } = await signWithCurrentDevice(userId, utf8ToU8(message));
    const info = await cryptoApi.uploadBackup(ciphertext, {
      deviceId,
      keyId,
      iv: u8ToB64(iv),
      signature: u8ToB64(signature),
    });
    await putPublic('meta', 'backup_last_hash', snapshotHash);
    await putPublic('meta', 'backup_last_at', info.created_at);
    await putPublic('meta', 'backup_last_error', null);
    return info;
  } catch (err) {
    await putPublic('meta', 'backup_last_error', err instanceof Error ? err.message : 'تعذر رفع النسخة').catch(() => undefined);
    throw err;
  }
}

// --- النسخ التلقائي ---------------------------------------------------------------

let autoUser: string | null = null;
let unsubscribe: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastRun = 0;

function schedule(delay: number): void {
  if (timer) clearTimeout(timer);
  const wait = Math.max(delay, lastRun + MIN_INTERVAL_MS - Date.now());
  timer = setTimeout(() => {
    timer = null;
    lastRun = Date.now();
    backupNow().catch((err) => console.warn('auto backup failed', err instanceof Error ? err.message : err));
  }, wait);
}

/** يُشغَّل بعد جاهزية التشفير: نسخة عند البدء إن تغيّر شيء، ثم بعد كل تغيير. */
export function startAutoBackup(userId: number | string): void {
  if (autoUser === String(userId)) return;
  stopAutoBackup();
  autoUser = String(userId);
  unsubscribe = onStoreWrite((store, key) => {
    if (store === 'meta' && LOCAL_ONLY_META.test(key)) return;
    schedule(DEBOUNCE_MS);
  });
  schedule(3_000);
}

export function stopAutoBackup(): void {
  unsubscribe?.();
  unsubscribe = null;
  if (timer) clearTimeout(timer);
  timer = null;
  autoUser = null;
}

// --- الاستعادة -----------------------------------------------------------------

export interface RestoreResult {
  deviceLabel: string;
  backupAt: string;
}

/**
 * يجلب أحدث نسخة يفتحها هذا المفتاح، يفكها، يستبدل المخزن المحلي بها (فيتولى
 * هذا المتصفح الجهاز المستعاد)، ثم يثبت ذلك للخادم بتوقيع مفتاح الجهاز.
 */
export async function restoreFromRecoveryKey(input: string): Promise<RestoreResult> {
  const raw = parseRecoveryKey(input);
  const userId = String(useAuthUser().id);
  const { kek, keyId } = await deriveKeys(raw);
  const all = await cryptoApi.listBackups();
  if (all.length === 0) throw new Error('لا توجد نسخة احتياطية لحسابك على الخادم');
  const candidates = all
    .filter((b) => b.key_id === keyId && b.device_status === 'active')
    .sort((a, b) => b.version - a.version);
  if (candidates.length === 0) throw new Error('هذا المفتاح لا يفتح أيًا من نسخك الاحتياطية — تأكد من المفتاح');

  let chosen: KeyBackupInfo | null = null;
  let snapshot: Uint8Array | null = null;
  for (const b of candidates) {
    try {
      const ct = await cryptoApi.downloadBackup(b.id);
      const iv = Uint8Array.from(atob(b.iv), (c) => c.charCodeAt(0));
      snapshot = new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(userId, b.device_id, keyId) }, kek, ct),
      );
      chosen = b;
      break;
    } catch {
      // نسخة تالفة/غير صالحة → نجرب الأقدم.
    }
  }
  if (!chosen || !snapshot) throw new Error('تعذر فك النسخ الاحتياطية بهذا المفتاح');

  const pending = await loadCurrentDevice(userId);
  const abandoned = pending && String(pending.deviceId) !== chosen.device_id ? String(pending.deviceId) : null;

  await importSnapshot(snapshot);
  const restored = await loadCurrentDevice(userId);
  if (!restored || String(restored.deviceId) !== chosen.device_id) {
    throw new Error('النسخة لا تحتوي مفاتيح الجهاز المتوقَّع');
  }
  await storeRecoveryKey(raw);
  await putPublic('meta', 'backup_last_at', chosen.created_at);

  const issuedAt = Math.floor(Date.now() / 1000);
  const message = RESTORE_CONTEXT + [userId, chosen.device_id, chosen.id, abandoned ?? '', String(issuedAt)].join('\n');
  const { signature } = await signWithCurrentDevice(userId, utf8ToU8(message));
  await cryptoApi.backupRestored({
    device_id: chosen.device_id,
    backup_id: chosen.id,
    abandoned_device_id: abandoned,
    issued_at: issuedAt,
    signature: u8ToB64(signature),
  });
  await resetMlsSession();
  return { deviceLabel: chosen.device_label, backupAt: chosen.created_at };
}
