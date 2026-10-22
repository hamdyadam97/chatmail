/**
 * بوتستراب الهوية والأجهزة (docs/phase1/03 §3.2/§3.3).
 *
 * الغلاف الـWASM لا يصدّر توليد مفاتيح — يستقبل بذرة Ed25519 بطول 32 بايت
 * ويوسّعها داخليًا (§8.3 الدرس 1: مزود rustcrypto يتوقع صيغة 64-byte
 * seed‖public). لذا نولّد كل البذور عبر WebCrypto:
 *
 * - بذرة 32 بايت عشوائية (crypto.getRandomValues — لا Math.random).
 * - استيرادها كمفتاح خاص عبر PKCS#8 (بادئة DER ثابتة: Ed25519 OID
 *   1.3.101.112 / X25519 OID 1.3.101.110 + OCTET STRING البذرة)، ثم تصدير
 *   JWK يعطينا `x` (العام) و`d` (البذرة). دعم Ed25519/X25519 في WebCrypto
 *   متوفر في المتصفحات الحديثة وNode 22.
 *
 * سلسلة الثقة:
 * - bootstrap_sig: الهوية توقّع identity_pub‖sign_pub‖kem_pub‖user.id.bytes
 *   عند إنشاء الهوية + أول جهاز (برهان امتلاك مفتاح الهوية).
 * - جهاز لاحق: يسجّل نفسه بـ sig بمفتاح توقيعه الخاص فوق
 *   sign_pub‖kem_pub‖user.id.bytes (برهان امتلاك) ثم يبقى PENDING حتى
 *   يعتمد جهاز موثّق موجود (§3.3/§3.5).
 */
import { cryptoApi } from './api';
import { deleteRecord, getAllRecords, getRecord, putRecord } from './keystore';
import { b64ToU8, u8ToB64, randomBytes } from './encoding';

const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
  0x20,
]);
const X25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04,
  0x20,
]);

/**
 * user.id كبايتات للتوقيعات. العقد: user.id.bytes — Django UUIDField
 * يعطي الـ16 بايت الخام للـUUID (big-endian كما يخزّنها PostgreSQL/Django).
 */
export function userIdBytes(userId: number | string): Uint8Array {
  const hex = String(userId).replace(/-/g, '');
  if (hex.length === 32 && /^[0-9a-fA-F]+$/.test(hex)) {
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  throw new Error(`userId ليس UUID صالحًا: ${userId}`);
}

export interface KeyMaterial {
  seed: Uint8Array;
  pub: Uint8Array;
  privateKey: CryptoKey;
}

function b64urlToU8(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return b64ToU8(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

async function keyFromSeed(
  prefix: Uint8Array,
  seed: Uint8Array,
  algorithm: { name: 'Ed25519' | 'X25519' },
): Promise<KeyMaterial> {
  const usages: KeyUsage[] = algorithm.name === 'Ed25519' ? ['sign'] : ['deriveBits'];
  const der = new Uint8Array(prefix.length + seed.length);
  der.set(prefix);
  der.set(seed, prefix.length);
  const privateKey = await crypto.subtle.importKey('pkcs8', der, algorithm, true, usages);
  const jwk = (await crypto.subtle.exportKey('jwk', privateKey)) as JsonWebKey & { x: string };
  return { seed, pub: b64urlToU8(jwk.x), privateKey };
}

/** مفتاح هوية Ed25519 جديد (بذرة 32B + عام 32B). */
export function generateIdentityKey(): Promise<KeyMaterial> {
  return keyFromSeed(ED25519_PKCS8_PREFIX, randomBytes(32), { name: 'Ed25519' });
}

/** يعيد بناء مادة مفتاح من بذرة محفوظة (مسار الاستعادة §3.6). */
export function identityFromSeed(seed: Uint8Array): Promise<KeyMaterial> {
  return keyFromSeed(ED25519_PKCS8_PREFIX, seed, { name: 'Ed25519' });
}

/** يعيد بناء مفاتيح جهاز من بذور محفوظة (مسار الاستعادة §3.6). */
export function deviceFromSeeds(signSeed: Uint8Array, kemSeed: Uint8Array): Promise<DeviceKeyMaterial> {
  return Promise.all([
    keyFromSeed(ED25519_PKCS8_PREFIX, signSeed, { name: 'Ed25519' }),
    keyFromSeed(X25519_PKCS8_PREFIX, kemSeed, { name: 'X25519' }),
  ]).then(([sign, kem]) => ({ sign, kem }));
}

/** مفاتيح جهاز: توقيع Ed25519 + KEM X25519 — كلاهما ببذور 32B. */
export interface DeviceKeyMaterial {
  sign: KeyMaterial;
  kem: KeyMaterial;
}

export function generateDeviceKeyMaterial(): Promise<DeviceKeyMaterial> {
  return Promise.all([
    keyFromSeed(ED25519_PKCS8_PREFIX, randomBytes(32), { name: 'Ed25519' }),
    keyFromSeed(X25519_PKCS8_PREFIX, randomBytes(32), { name: 'X25519' }),
  ]).then(([sign, kem]) => ({ sign, kem }));
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function ed25519Sign(privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, data);
  return new Uint8Array(sig);
}

export interface StoredIdentity {
  userId: number | string;
  /** null إذا أُنشئت الهوية على جهاز آخر — هذا الجهاز يملك pub فقط. */
  seed: Uint8Array | null;
  pub: Uint8Array;
  createdAt: string;
}

export interface StoredDeviceKeys {
  deviceId: number | string;
  userId: number | string;
  label: string;
  platform: string;
  signSeed: Uint8Array;
  kemSeed: Uint8Array;
  signPub: Uint8Array;
  kemPub: Uint8Array;
  status: string;
  createdAt: string;
}

export type BootstrapResult =
  | { state: 'ready'; identity: StoredIdentity; device: StoredDeviceKeys }
  | { state: 'pending_approval'; identity: StoredIdentity; device: StoredDeviceKeys };

export async function loadIdentity(userId: number | string): Promise<StoredIdentity | undefined> {
  return getRecord<StoredIdentity>('identity', `identity:${userId}`);
}

export async function listDeviceKeys(userId: number | string): Promise<StoredDeviceKeys[]> {
  const all = await getAllRecords<StoredDeviceKeys>('deviceKeys');
  return all.filter((d) => String(d.userId) === String(userId));
}

/** أحدث جهاز مفاتيحه محفوظة لهذا المستخدم (الجهاز الحالي عمليًا). */
export async function loadCurrentDevice(
  userId: number | string,
): Promise<StoredDeviceKeys | undefined> {
  const mine = await listDeviceKeys(userId);
  return mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function deviceLabel(): { label: string; platform: string } {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = String(nav.userAgentData?.platform ?? navigator.platform ?? 'web');
  const ua = navigator.userAgent;
  const browser = ua.includes('Edg/')
    ? 'Edge'
    : ua.includes('Chrome/')
      ? 'Chrome'
      : ua.includes('Firefox/')
        ? 'Firefox'
        : ua.includes('Safari/')
          ? 'Safari'
          : 'متصفح';
  return { label: `${browser} — ${platform}`, platform };
}

/**
 * بعد bootstrap نأخذ device_id من ردّ الـbackend مباشرة (201 يتضمن device_id
 * وdevice_status). بقيت هذه الدالة احتياطًا ضيقًا لحالات غير متوقعة فقط.
 */
async function resolveOwnDeviceId(label: string): Promise<number | string | undefined> {
  const devices = await cryptoApi.listDevices();
  const mine = devices.filter((d) => d.label === label);
  const pool = mine.length > 0 ? mine : devices.filter((d) => d.status === 'active');
  return pool.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]?.id;
}

/**
 * بوتستراب كامل للمستخدم الحالي:
 * 1) هوية محلية موجودة → جاهزون (تفعيل الـKP عبر mls.ensureKeyPackage لاحقًا).
 * 2) لا هوية → نولّد هوية+جهاز ونرفع identity/. عند 409 (الهوية وُجدت من
 *    جهاز آخر) نسجّل هذا الجهاز كجهاز إضافي → pending حتى الاعتماد من جهاز
 *    موثّق (§3.3).
 */
export async function bootstrapUserCrypto(user: { id: number | string }): Promise<BootstrapResult> {
  const existing = await loadIdentity(user.id);
  if (existing) {
    const device = await loadCurrentDevice(user.id);
    if (!device) throw new Error('بيانات الهوية موجودة لكن مفاتيح الجهاز مفقودة محليًا');
    return device.status === 'active'
      ? { state: 'ready', identity: existing, device }
      : { state: 'pending_approval', identity: existing, device };
  }

  const identityKey = await generateIdentityKey();
  const material = await generateDeviceKeyMaterial();
  const uidBytes = userIdBytes(user.id);
  const { label, platform } = deviceLabel();

  const identityPub = identityKey.pub;
  const signPub = material.sign.pub;
  const kemPub = material.kem.pub;

  const bootstrapSig = await ed25519Sign(
    identityKey.privateKey,
    concatBytes(identityPub, signPub, kemPub, uidBytes),
  );
  const deviceSig = await ed25519Sign(
    material.sign.privateKey,
    concatBytes(identityPub, signPub, kemPub, uidBytes),
  );

  const identity: StoredIdentity = {
    userId: user.id,
    seed: identityKey.seed,
    pub: identityPub,
    createdAt: new Date().toISOString(),
  };
  const baseDevice: Omit<StoredDeviceKeys, 'deviceId' | 'status'> = {
    userId: user.id,
    label,
    platform,
    signSeed: material.sign.seed,
    kemSeed: material.kem.seed,
    signPub,
    kemPub,
    createdAt: identity.createdAt,
  };

  try {
    const boot = await cryptoApi.bootstrapIdentity({
      identity_pub: u8ToB64(identityPub),
      bootstrap_sig: u8ToB64(bootstrapSig),
      device: { label, platform, sign_pub: u8ToB64(signPub), kem_pub: u8ToB64(kemPub), sig: u8ToB64(deviceSig) },
    });
    // الرد يحمل device_id مباشرة — الجهاز الأول active فورًا (§3.3).
    const serverId = boot.device_id ?? (await resolveOwnDeviceId(label)) ?? 'unresolved';
    const device: StoredDeviceKeys = {
      ...baseDevice,
      deviceId: serverId,
      status: boot.device_status ?? 'active',
    };
    await putRecord('identity', `identity:${user.id}`, identity);
    await putRecord('deviceKeys', `${user.id}:${serverId}`, device);
    return { state: 'ready', identity, device };
  } catch (err) {
    if ((err as { status?: number }).status !== 409) throw err;
    // هوية موجودة على السيرفر (أُنشئت على جهاز آخر). نجلب identity_pub العام
    // من الدليل ويوقّع الجهاز الجديد على رسالة البوتستراب الكاملة بمفتاحه —
    // الخادم يتحقق بهذه الصيغة حرفيًا (services.verify_device_signature).
    const selfDir = await cryptoApi.queryKeys([user.id]);
    const existingPubB64 = selfDir.users.find((u) => String(u.user_id) === String(user.id))?.identity_pub;
    if (!existingPubB64) throw new Error('الهوية موجودة على السيرفر لكن تعذر جلب مفتاحها العام من الدليل');
    const existingIdentityPub = b64ToU8(existingPubB64);
    const deviceSigForRegister = await ed25519Sign(
      material.sign.privateKey,
      concatBytes(existingIdentityPub, signPub, kemPub, uidBytes),
    );
    const registered = await cryptoApi.registerDevice({
      label,
      platform,
      sign_pub: u8ToB64(signPub),
      kem_pub: u8ToB64(kemPub),
      sig: u8ToB64(deviceSigForRegister),
    });
    const serverIdentity: StoredIdentity = {
      userId: user.id,
      seed: null,
      pub: existingIdentityPub,
      createdAt: new Date().toISOString(),
    };
    const device: StoredDeviceKeys = { ...baseDevice, deviceId: registered.id, status: registered.status };
    await putRecord('identity', `identity:${user.id}`, serverIdentity);
    await putRecord('deviceKeys', `${user.id}:${registered.id}`, device);
    return { state: 'pending_approval', identity: serverIdentity, device };
  }
}

/** بعد اعتماد جهاز pending: نطابق device_id من السيرفر ونفعّل محليًا. */
/**
 * توقيع بمفتاح جهازنا الحالي (Ed25519) — يستخدمه توقيع قرارات الاعتماد. المفتاح
 * نفسه يوقّع اعتماد MLS، لكن كل استخدام بسياق مختلف (MLS يضيف وسم «MLS 1.0»،
 * والاعتماد يضيف SIGNING_CONTEXT)، فلا يصلح توقيع أحدهما للآخر.
 */
export async function signWithCurrentDevice(
  userId: number | string,
  data: Uint8Array,
): Promise<{ signature: Uint8Array; deviceId: number | string; signPub: Uint8Array }> {
  const device = await loadCurrentDevice(userId);
  // حالة الجهاز (معتمد/معلّق) يفرضها الخادم عند التحقق من التوقيع.
  if (!device) throw new Error('لا توجد مفاتيح جهاز على هذا المتصفح');
  const material = await deviceFromSeeds(device.signSeed, device.kemSeed);
  const signature = await ed25519Sign(material.sign.privateKey, data);
  return { signature, deviceId: device.deviceId, signPub: device.signPub };
}

export async function refreshDeviceStatus(userId: number | string): Promise<StoredDeviceKeys | undefined> {
  const device = await loadCurrentDevice(userId);
  if (!device) return undefined;
  const servers = await cryptoApi.listDevices();
  const match =
    servers.find((s) => String(s.id) === String(device.deviceId)) ??
    servers.find((s) => s.label === device.label && s.status === 'active');
  if (!match) return device;
  if (String(match.id) !== String(device.deviceId) || match.status !== device.status) {
    const updated: StoredDeviceKeys = { ...device, deviceId: match.id, status: match.status };
    await deleteRecord('deviceKeys', `${userId}:${device.deviceId}`);
    await putRecord('deviceKeys', `${userId}:${match.id}`, updated);
    return updated;
  }
  return device;
}
