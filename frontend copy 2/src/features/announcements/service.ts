/**
 * التعاميم على العميل: التشفير والفك والإقرار الموقّع.
 *
 * - النشر: إعداد (الخادم يحل الجمهور من الهيكل التنظيمي) ← يرى الناشر العدد
 *   والأسماء ويؤكد ← مجموعة MLS بمستلمين = الجمهور المعلن فقط (Welcome واحد)
 *   ← تشفير {عنوان، نص} ← publish.
 * - الفتح: فك لمرة واحدة ويُخزن مغلّفًا في `mail`؛ نتحقق من مرسل MLS (الناشر
 *   وجهازه)، ومن ربط المحتوى بالتعميم، ومن أن روستر MLS لا يضم أحدًا خارج
 *   الجمهور المعلن (لا مستلم خفي يملك المفتاح — §10).
 * - الإقرار: توقيع Ed25519 بمفتاح الجهاز على حمولة قانونية مربوطة ببصمة
 *   الـciphertext الذي فككناه (دليل سلامة، لا توقيع نظامي قانوني).
 */
import { chatApi } from '../chat/api';
import {
  encryptMessage,
  feedMessages,
  getChatSeq,
  getCurrentDeviceId,
  initThreadGroup,
  rosterUserIds,
  verifyMlsSender,
} from '../../crypto/mls';
import { getRecord, putRecord } from '../../crypto/keystore';
import { b64ToU8, randomBytes, u8ToB64, utf8ToU8, uuid4 } from '../../crypto/encoding';
import { loadCurrentDevice, signWithCurrentDevice } from '../../crypto/identity';
import { serialized } from '../correspondence/service';
import { announcementsApi, type Announcement, type PrepareBody } from './api';

const ACK_CONTEXT = 'announcement-ack-v1\n';

export interface AnnouncementContent {
  v: 1;
  kind: 'announcement';
  announcement_id: string;
  subject: string;
  body: string;
}

export interface StoredAnnouncement {
  content: AnnouncementContent;
  senderVerified: boolean;
  bound: boolean;
  /** مستخدمون في روستر MLS خارج الجمهور المعلن (يجب أن تكون فارغة). */
  undeclaredMembers: string[];
  /** بيانات وصفية محلية للبحث المحلي. */
  meta?: { reference_number: string | null; publisher_name: string; published_at: string | null };
}

export type OpenAnnouncement = { state: 'ok'; stored: StoredAnnouncement } | { state: 'unavailable'; reason: string };

const cacheKey = (id: string) => `ann:${id}`;

function decode(plaintext: string): AnnouncementContent | undefined {
  try {
    const parsed = JSON.parse(plaintext) as Partial<AnnouncementContent>;
    if (
      parsed.v === 1 &&
      parsed.kind === 'announcement' &&
      typeof parsed.subject === 'string' &&
      typeof parsed.body === 'string' &&
      parsed.subject.length <= 500 &&
      parsed.body.length <= 100_000
    ) {
      return parsed as AnnouncementContent;
    }
  } catch {
    // ليس محتوى تعميم
  }
  return undefined;
}

// --- النشر -----------------------------------------------------------------------------

export function prepareAnnouncement(input: Omit<PrepareBody, 'mls_group_id' | 'client_ref'>): Promise<Announcement> {
  return announcementsApi.prepare({ ...input, mls_group_id: u8ToB64(randomBytes(16)), client_ref: uuid4() });
}

export async function publishAnnouncement(
  prepared: Announcement,
  recipientIds: string[],
  subject: string,
  body: string,
): Promise<Announcement> {
  const deviceId = String(await getCurrentDeviceId());
  const thread = { id: prepared.thread.id, mls_group_id: prepared.thread.mls_group_id };
  await serialized(thread.id, () => initThreadGroup(thread, recipientIds));
  const content: AnnouncementContent = { v: 1, kind: 'announcement', announcement_id: prepared.id, subject, body };
  const published = await serialized(thread.id, async () => {
    const encrypted = await encryptMessage(thread, JSON.stringify(content));
    return announcementsApi.publish(prepared.id, {
      mls_payload: encrypted.mls_payload_b64,
      client_msg_id: uuid4(),
      epoch: encrypted.epoch,
      sender_device_id: deviceId,
    });
  });
  await putRecord('mail', cacheKey(published.id), {
    content,
    senderVerified: true,
    bound: true,
    undeclaredMembers: [],
    meta: { reference_number: published.reference_number, publisher_name: published.publisher.full_name, published_at: published.published_at },
  } satisfies StoredAnnouncement);
  return published;
}

// --- الفتح ---------------------------------------------------------------------------------

export function openAnnouncement(detail: Announcement): Promise<OpenAnnouncement> {
  return serialized(detail.thread.id, async () => {
    const cached = await getRecord<StoredAnnouncement>('mail', cacheKey(detail.id));
    if (cached) return { state: 'ok', stored: cached } as const;
    if (!detail.content) return { state: 'unavailable', reason: 'لم يُنشر التعميم بعد' } as const;

    const deviceId = String(await getCurrentDeviceId());
    const thread = { id: detail.thread.id, mls_group_id: detail.thread.mls_group_id };
    const { last_processed_seq } = await getChatSeq(thread.id);
    const page = await chatApi.getMessages(thread.id, last_processed_seq, 200);
    const feed = await feedMessages(thread, page.messages, deviceId, { epochFilter: true });
    const result = feed.decrypted.get(detail.content.seq);
    const content = result?.plaintext ? decode(result.plaintext) : undefined;
    if (!content) {
      return {
        state: 'unavailable',
        reason: 'تعذر فك التعميم على هذا الجهاز — قد يكون نُشر قبل إضافة هذا الجهاز، ولا يُمنح الجهاز الجديد التاريخ تلقائيًا',
      } as const;
    }
    const senderVerified =
      detail.content.sender_device_id !== null &&
      (await verifyMlsSender(thread, detail.publisher.id, detail.content.sender_device_id, result?.senderIndex));
    const audience = await announcementsApi.audience(detail.id);
    const declared = new Set([audience.publisher.id, ...audience.recipients.map((u) => u.id)]);
    const roster = (await rosterUserIds(thread)).map(String);
    const stored: StoredAnnouncement = {
      content,
      senderVerified,
      bound: content.announcement_id === detail.id,
      undeclaredMembers: roster.filter((u) => !declared.has(u)),
      meta: { reference_number: detail.reference_number, publisher_name: detail.publisher.full_name, published_at: detail.published_at },
    };
    await putRecord('mail', cacheKey(detail.id), stored);
    return { state: 'ok', stored } as const;
  });
}

// --- الإقرار الموقّع ------------------------------------------------------------------------

async function sha256B64(bytes: Uint8Array): Promise<string> {
  return u8ToB64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

export async function acknowledgeAnnouncement(detail: Announcement, userId: string): Promise<void> {
  if (!detail.content || !detail.content_hash) throw new Error('التعميم غير منشور');
  if ((await sha256B64(b64ToU8(detail.content.mls_payload))) !== detail.content_hash) {
    throw new Error('بصمة النسخة التي فككتها لا تطابق بصمة التعميم — لن يُوقَّع الإقرار');
  }
  const device = await loadCurrentDevice(userId);
  if (!device) throw new Error('لا توجد مفاتيح جهاز على هذا المتصفح');
  // مفاتيح مرتبة أبجديًا وقيم ASCII — مطابق لـ canonical_bytes على الخادم.
  const payload = JSON.stringify({
    acknowledged_at: new Date().toISOString(),
    announcement_id: detail.id,
    content_hash: detail.content_hash,
    device_id: String(device.deviceId),
    user_id: userId,
  });
  const payloadBytes = utf8ToU8(payload);
  const context = utf8ToU8(ACK_CONTEXT);
  const message = new Uint8Array(context.length + payloadBytes.length);
  message.set(context);
  message.set(payloadBytes, context.length);
  const { signature } = await signWithCurrentDevice(userId, message);
  await announcementsApi.ack(detail.id, {
    payload: u8ToB64(payloadBytes),
    signature: u8ToB64(signature),
    device_id: String(device.deviceId),
  });
}
