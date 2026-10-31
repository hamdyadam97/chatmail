/**
 * مخزن المفاتيح المحلي — IndexedDB مشفّر أثناء الراحة (docs/phase1/03 §3.9).
 *
 * منهج «التخزين المُغلَّف» (wrapped storage):
 * - KEK = مفتاح AES-256-GCM غير قابل للتصدير (`extractable: false`) يُولَّد
 *   عند أول bootstrap ويُحفظ في مخزن `meta` ككائن CryptoKey (يدعمها الـ
 *   structured clone في IndexedDB). أي مادة سرية أخرى لا تُخزن أبدًا إلا
 *   مشفّرة بـ KEK مع IV عشوائي لكل سجل.
 * - بهذا لا توجد لحظة يوجد فيها الـKEK كبايتات قابلة للتصدير: يُولَّد داخل
 *   WebCrypto ويعيش كمقبض غير قابل للاستخراج. تعزيز §3.9 القائم على اشتقاق
 *   المفتاح من جلسة الدخول مرحلة لاحقة؛ حاليًا الربط بالجهاز عبر عدم قابلية
 *   التصدير + تشفير كل السجلات.
 *
 * المخازن:
 * - meta:       kek + إعدادات غير سرية (chat: آخر تسلسل مقروء/معالج…)
 * - identity:   بذرة الهوية Ed25519 + المفتاح العام (مغلّفان)
 * - deviceKeys: مفاتيح الجهاز (sign seed / kem seed + العامة) لكل جهاز مسجّل
 * - groups:     conversation_id → حالة MLS المسلسلة (export_state من الغلاف)
 *               + رقم الجيل + وقت التحديث. ملاحظة: غلاف الـSpike يصدّر كل
 *               المجموعات دفعة واحدة، لذا `blob` هنا لقطة شاملة تُكتب بعد كل
 *               عملية على أي مجموعة؛ عند التحميل نقرأ أحدث سجل (max updated_at)
 *               فيكون لدينا الحالة الكاملة دائمًا.
 * - kps:        KeyPackageاتنا المعلّقة (تجزئة + حالة الرفع)
 * - backups:    نسخ الاستعادة المشفرة المعلّقة رفعها (TODO(endpoint))
 * - sent:       نصوص رسائل الشات المرسلة من هذا الجهاز (MLS لا يفك رسائلنا)
 * - mail:       محتوى المراسلات الرسمية بعد فكه (فك MLS لمرة واحدة — بلا هذا
 *               الكاش يضيع المحتوى بعد أول عرض)، مغلّف بالـKEK كغيره
 * - drafts:     مسودات المراسلات — محلية على هذا الجهاز فقط ومغلّفة بالـKEK
 * - chatlog:    رسائل الشات المستلمة بعد فكها (`{conversation}:{seq}`) — فك MLS
 *               لمرة واحدة، فبدونه يضيع النص بعد إعادة التحميل؛ مغلّف بالـKEK
 *
 * قاعدة مستقلة لكل مستخدم (`correspondence-crypto:<userId>`) بـKEK خاص بها:
 * مستخدمان على المتصفح نفسه لا يرى أحدهما مفاتيح الآخر ولا نسخه المفكوكة
 * (البحث المحلي مثلًا)، ولا تُحمَّل حالة MLS لهوية في عميل هوية أخرى.
 *
 * المحظور (§3.9): لا localStorage لأي مادة سرية، لا Plaintext في السجلات.
 */
import { openDB, type DBSchema, type IDBPDatabase, type StoreNames } from 'idb';
import { useAuthUser } from './authBridge';

export const DB_NAME = 'correspondence-crypto';
export const DB_VERSION = 4;

const STORE_NAMES: StoreName[] = [
  'meta',
  'identity',
  'deviceKeys',
  'groups',
  'kps',
  'backups',
  'sent',
  'mail',
  'drafts',
  'chatlog',
];

export type StoreName =
  | 'meta'
  | 'identity'
  | 'deviceKeys'
  | 'groups'
  | 'kps'
  | 'backups'
  | 'sent'
  | 'mail'
  | 'drafts'
  | 'chatlog';

interface CryptoDB extends DBSchema {
  meta: { key: string; value: unknown };
  identity: { key: string; value: unknown };
  deviceKeys: { key: string; value: unknown };
  groups: { key: string; value: unknown };
  kps: { key: string; value: unknown };
  backups: { key: string; value: unknown };
  sent: { key: string; value: unknown };
  mail: { key: string; value: unknown };
  drafts: { key: string; value: unknown };
  chatlog: { key: string; value: unknown };
}

interface WrappedRecord {
  iv: Uint8Array;
  ct: Uint8Array;
}

const WRAP_PREFIX_U8 = 0x01;
const WRAP_PREFIX_JSON = 0x00;

let dbPromise: Promise<IDBPDatabase<CryptoDB>> | null = null;
let dbUser: string | null = null;

function getDb(): Promise<IDBPDatabase<CryptoDB>> {
  const uid = String(useAuthUser().id);
  if (uid !== dbUser) {
    // تبدّل المستخدم: قاعدة أخرى ومفتاح تغليف آخر — لا شيء مشترك.
    void dbPromise?.then((db) => db.close()).catch(() => undefined);
    dbPromise = null;
    kekPromise = null;
    dbUser = uid;
  }
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('المخزن المحلي (IndexedDB) غير متوفر في هذا المتصفح'));
  }
  dbPromise ??= openDB<CryptoDB>(`${DB_NAME}:${uid}`, DB_VERSION, {
    upgrade(db, oldVersion) {
      for (const store of STORE_NAMES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      }
      void oldVersion;
    },
  });
  return dbPromise;
}

let kekPromise: Promise<CryptoKey> | null = null;

/** KEK غير قابل للتصدير: يُولَّد مرة واحدة ويُخزَّن كمقبض CryptoKey. */
function getKek(): Promise<CryptoKey> {
  kekPromise ??= (async () => {
    const db = await getDb();
    const existing = (await db.get('meta', 'kek')) as CryptoKey | undefined;
    if (existing) return existing;
    const kek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    await db.put('meta', kek, 'kek');
    return kek;
  })();
  return kekPromise;
}

/**
 * JSON لا يعرف Uint8Array: كان يحوّلها إلى {"0":12,"1":34,…} فتعود كائنًا عاديًا
 * (بذور الأجهزة، المفاتيح العامة، لقطات MLS). نرمّزها صراحةً {"$u8":"<base64>"}
 * ونستعيدها عند القراءة.
 */
const U8_TAG = '$u8';

function bytesReplacer(this: unknown, _key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    let bin = '';
    for (let i = 0; i < value.length; i += 0x8000) {
      bin += String.fromCharCode(...value.subarray(i, i + 0x8000));
    }
    return { [U8_TAG]: btoa(bin) };
  }
  return value;
}

function bytesReviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === U8_TAG) {
      const bin = atob((value as Record<string, string>)[U8_TAG]);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
  }
  return value;
}

async function wrap(value: unknown): Promise<WrappedRecord> {
  const kek = await getKek();
  let payload: Uint8Array;
  if (value instanceof Uint8Array) {
    payload = new Uint8Array(1 + value.length);
    payload[0] = WRAP_PREFIX_U8;
    payload.set(value, 1);
  } else {
    const json = new TextEncoder().encode(JSON.stringify(value ?? null, bytesReplacer));
    payload = new Uint8Array(1 + json.length);
    payload[0] = WRAP_PREFIX_JSON;
    payload.set(json, 1);
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, payload);
  return { iv, ct: new Uint8Array(ct) };
}

async function unwrap(record: WrappedRecord): Promise<unknown> {
  const kek = await getKek();
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, kek, record.ct);
  const bytes = new Uint8Array(plain);
  if (bytes[0] === WRAP_PREFIX_U8) return bytes.slice(1);
  return JSON.parse(new TextDecoder().decode(bytes.slice(1)), bytesReviver);
}

// --- مراقبة الكتابة (يجدول بها النسخ الاحتياطي التلقائي) ---------------------
type WriteListener = (store: StoreName, key: string) => void;
const writeListeners = new Set<WriteListener>();

export function onStoreWrite(listener: WriteListener): () => void {
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
}

function notifyWrite(store: StoreName, key: string): void {
  for (const l of writeListeners) l(store, key);
}

export async function putRecord<T>(store: StoreName, key: string, value: T): Promise<void> {
  const db = await getDb();
  await db.put(store, await wrap(value), key);
  notifyWrite(store, key);
}

export async function getRecord<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await getDb();
  const record = (await db.get(store, key)) as WrappedRecord | undefined;
  if (!record) return undefined;
  return (await unwrap(record)) as T;
}

export async function deleteRecord(store: StoreName, key: string): Promise<void> {
  const db = await getDb();
  await db.delete(store, key);
  notifyWrite(store, key);
}

/** كل سجلات مخزن مُغلَّفة مع مفاتيحها (للبحث المحلي). */
export async function getAllEntries<T>(store: StoreName): Promise<Array<[string, T]>> {
  const db = await getDb();
  const tx = db.transaction(store, 'readonly');
  const keys = (await tx.store.getAllKeys()) as string[];
  const records = (await tx.store.getAll()) as WrappedRecord[];
  await tx.done;
  const values = await Promise.all(records.map((r) => unwrap(r) as Promise<T>));
  return keys.map((k, i) => [String(k), values[i]]);
}

/** كل سجلات مخزن مُغلَّفة (مفكوكة التشفير) — للتعداد المحلي. */
export async function getAllRecords<T>(store: StoreName): Promise<T[]> {
  const db = await getDb();
  const records = (await db.getAll(store)) as WrappedRecord[];
  return Promise.all(records.map((r) => unwrap(r) as Promise<T>));
}

/** بيانات علنية (غير سرية) تُخزن دون تشفير — أرقام تسلسل، أعلام، إلخ. */
export async function putPublic(store: StoreName, key: string, value: unknown): Promise<void> {
  const db = await getDb();
  await db.put(store, value, key);
  notifyWrite(store, key);
}

export async function getPublic<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await getDb();
  return (await db.get(store, key)) as T | undefined;
}

export async function getAllPublic<T>(store: StoreName): Promise<T[]> {
  const db = await getDb();
  return (await db.getAll(store)) as T[];
}

/**
 * يطلب من المتصفح ألا يمسح هذا المخزن عند ضيق المساحة. مسحه يضيّع مفاتيح
 * الجهاز فيُسجَّل المتصفح كجهاز جديد. أفضل جهد: الرفض أو غياب الواجهة لا يوقف شيئًا.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** يمحو كل المخزن (تسجيل خروج/إعادة ضبط). الـKEK نفسه يُمسح مع meta. */
export async function wipeCryptoStore(): Promise<void> {
  kekPromise = null;
  const db = await getDb();
  const tx = db.transaction(STORE_NAMES as StoreNames<CryptoDB>[], 'readwrite');
  await Promise.all(STORE_NAMES.map((s) => tx.objectStore(s).clear()));
  await tx.done;
}

// --- لقطة كاملة للنسخ الاحتياطي المشفّر (docs/phase1/03 §3.6) ------------------
//
// كل محتوى المخزن ما عدا: مفتاح التغليف المحلي، مفاتيح/حالة النسخ الاحتياطي
// نفسها، ومخزن backups القديم. اللقطة لا تغادر الذاكرة إلا مشفّرة بمفتاح
// الاستعادة (recovery.ts). الاستيراد يعيد تغليف كل سجل بـKEK هذا المتصفح.

/** مفاتيح meta التي لا تدخل اللقطة (مقابض CryptoKey ومؤشرات النسخ). */
export const LOCAL_ONLY_META = /^(kek$|backup_|recovery_)/;
const SNAPSHOT_STORES: StoreName[] = STORE_NAMES.filter((s) => s !== 'backups');

interface SnapshotEntry {
  s: StoreName;
  k: string;
  /** مغلّف (سري) أم علني. */
  w: boolean;
  v: unknown;
}

function isWrapped(value: unknown): value is WrappedRecord {
  if (!value || typeof value !== 'object') return false;
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    (value as WrappedRecord).iv instanceof Uint8Array &&
    (value as WrappedRecord).ct instanceof Uint8Array
  );
}

export async function exportSnapshot(): Promise<Uint8Array> {
  const db = await getDb();
  const entries: SnapshotEntry[] = [];
  for (const store of SNAPSHOT_STORES) {
    const tx = db.transaction(store, 'readonly');
    const keys = (await tx.store.getAllKeys()) as string[];
    const values = (await tx.store.getAll()) as unknown[];
    await tx.done;
    for (let i = 0; i < keys.length; i++) {
      const key = String(keys[i]);
      const raw = values[i];
      if (store === 'meta' && LOCAL_ONLY_META.test(key)) continue;
      if (raw instanceof CryptoKey) continue;
      entries.push(isWrapped(raw) ? { s: store, k: key, w: true, v: await unwrap(raw) } : { s: store, k: key, w: false, v: raw });
    }
  }
  return new TextEncoder().encode(JSON.stringify({ format: 1, entries }, bytesReplacer));
}

/** يستبدل المخزن كله بمحتوى اللقطة (يُمسح الموجود أولًا، ومنه مفاتيح الجهاز المعلّق). */
export async function importSnapshot(bytes: Uint8Array): Promise<void> {
  const parsed = JSON.parse(new TextDecoder().decode(bytes), bytesReviver) as { format: number; entries: SnapshotEntry[] };
  if (parsed.format !== 1 || !Array.isArray(parsed.entries)) throw new Error('صيغة النسخة الاحتياطية غير معروفة');
  await wipeCryptoStore();
  const db = await getDb();
  for (const e of parsed.entries) {
    if (!SNAPSHOT_STORES.includes(e.s)) continue;
    if (e.s === 'meta' && LOCAL_ONLY_META.test(e.k)) continue;
    await db.put(e.s, e.w ? await wrap(e.v) : e.v, e.k);
  }
}
