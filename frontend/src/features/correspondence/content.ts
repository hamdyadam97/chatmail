/**
 * صيغة محتوى المراسلة (الإصدار 1) — تُشفَّر كاملةً كرسالة MLS واحدة في خيط
 * المراسلة، فلا يرى الخادم العنوان ولا النص ولا أسماء المرفقات ولا مفاتيحها.
 * (نفس الصيغة يستخدمها frontend/scripts/e2e-correspondence.mjs.)
 *
 * المرفقات: AES-256-GCM (WebCrypto) بمفتاح عشوائي لكل ملف وIV عشوائي،
 * والـblob المرفوع = IV(12) ‖ ciphertext+tag مع AAD ثابت يربطه بهذا الغرض.
 * بصمة SHA-256 للـblob تسافر داخل المحتوى المشفّر، فيكشف العميل أي استبدال
 * للملف على الخادم قبل محاولة فكه.
 */
import { saveBlob } from '../../shared/lib/download';
import { b64ToU8, u8ToB64, utf8ToU8 } from '../../crypto/encoding';

export const CONTENT_VERSION = 1;
const ATTACHMENT_AAD = utf8ToU8('corr-attachment-v1');
const IV_BYTES = 12;
const MAX_SUBJECT = 500;
const MAX_BODY = 100_000;

export interface AttachmentKey {
  /** معرف الـblob على الخادم (stored file). */
  id: string;
  name: string;
  mime: string;
  size: number;
  /** مفتاح AES-256 الخام (base64) — لا يغادر المحتوى المشفّر أبدًا. */
  key: string;
  /** SHA-256 للـblob المشفّر (base64). */
  sha256: string;
}

export interface ForwardedQuote {
  reference_number: string | null;
  sender_name: string;
  sent_at: string | null;
  subject: string;
  body: string;
}

export interface CorrespondenceContent {
  v: typeof CONTENT_VERSION;
  kind: 'correspondence';
  /** يربط المحتوى بصف المراسلة (null للرد: معرفه لا يُعرف قبل الإرسال). */
  correspondence_id: string | null;
  /** للرد: المراسلة التي يرد عليها (ربط بديل). */
  reply_to_id?: string | null;
  subject: string;
  body: string;
  attachments: AttachmentKey[];
  forwarded?: ForwardedQuote;
}

export function encodeContent(content: Omit<CorrespondenceContent, 'v' | 'kind'>): string {
  const full: CorrespondenceContent = { v: CONTENT_VERSION, kind: 'correspondence', ...content };
  return JSON.stringify(full);
}

function isString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

/** يفك ويتحقق من البنية؛ أي حقل غير متوقع = محتوى مرفوض (لا عرض جزئي). */
export function decodeContent(plaintext: string): CorrespondenceContent {
  const parsed = JSON.parse(plaintext) as Partial<CorrespondenceContent>;
  if (parsed.v !== CONTENT_VERSION || parsed.kind !== 'correspondence') {
    throw new Error('صيغة محتوى غير مدعومة');
  }
  if (!isString(parsed.subject, MAX_SUBJECT) || !isString(parsed.body, MAX_BODY)) {
    throw new Error('محتوى غير صالح');
  }
  const attachments = Array.isArray(parsed.attachments) ? parsed.attachments : [];
  for (const a of attachments) {
    if (
      !isString(a.id, 64) ||
      !isString(a.name, 255) ||
      !isString(a.mime, 255) ||
      typeof a.size !== 'number' ||
      !isString(a.key, 64) ||
      !isString(a.sha256, 64)
    ) {
      throw new Error('بيانات مرفق غير صالحة');
    }
  }
  return {
    v: CONTENT_VERSION,
    kind: 'correspondence',
    correspondence_id: parsed.correspondence_id ?? null,
    reply_to_id: parsed.reply_to_id ?? null,
    subject: parsed.subject,
    body: parsed.body,
    attachments,
    forwarded: parsed.forwarded,
  };
}

/** هل المحتوى مربوط فعلًا بهذا الصف؟ (يمنع خادمًا من تبديل محتوى بآخر). */
export function contentMatchesRow(
  content: CorrespondenceContent,
  row: { id: string; reply_to_id: string | null },
): boolean {
  if (content.correspondence_id) return content.correspondence_id === row.id;
  return Boolean(row.reply_to_id) && content.reply_to_id === row.reply_to_id;
}

async function sha256B64(data: Uint8Array): Promise<string> {
  return u8ToB64(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

export async function encryptAttachment(
  file: File,
): Promise<{ blob: Uint8Array; meta: Omit<AttachmentKey, 'id'> }> {
  const plain = new Uint8Array(await file.arrayBuffer());
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ATTACHMENT_AAD }, key, plain),
  );
  const blob = new Uint8Array(IV_BYTES + ct.length);
  blob.set(iv, 0);
  blob.set(ct, IV_BYTES);
  return {
    blob,
    meta: {
      name: file.name.slice(0, 255),
      mime: (file.type || 'application/octet-stream').slice(0, 255),
      size: file.size,
      key: u8ToB64(rawKey),
      sha256: await sha256B64(blob),
    },
  };
}

export class AttachmentIntegrityError extends Error {}

/** يتحقق من البصمة ثم يفك. فشل GCM = تعديل أثناء النقل/التخزين (SEC-17). */
export async function decryptAttachment(blob: Uint8Array, meta: AttachmentKey): Promise<Uint8Array> {
  if ((await sha256B64(blob)) !== meta.sha256) {
    throw new AttachmentIntegrityError('بصمة الملف لا تطابق ما أرسله المرسل — رُفض الملف');
  }
  const key = await crypto.subtle.importKey('raw', b64ToU8(meta.key), 'AES-GCM', false, ['decrypt']);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: blob.slice(0, IV_BYTES), additionalData: ATTACHMENT_AAD },
      key,
      blob.slice(IV_BYTES),
    );
    return new Uint8Array(plain);
  } catch {
    throw new AttachmentIntegrityError('تعذر فك المرفق — الملف تالف أو معدّل');
  }
}

/**
 * يحفظ الملف المفكوك كتنزيل. النوع دائمًا octet-stream كي لا يعرضه المتصفح
 * داخل أصل التطبيق (HTML/SVG مفكوك قد يحمل سكربتًا — حماية XSS، §21).
 */
export function saveDecryptedFile(plain: Uint8Array, name: string): void {
  saveBlob(new Blob([plain], { type: 'application/octet-stream' }), name || 'attachment');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} بايت`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} ك.ب`;
  return `${(n / 1024 / 1024).toFixed(1)} م.ب`;
}
