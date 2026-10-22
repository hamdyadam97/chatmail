/**
 * تنسيق المراسلات على العميل — كل التشفير/الفك هنا وفي crypto/mls.
 *
 * - إرسال جديد/إحالة: رفع المرفقات المشفّرة ← إعداد الصف والخيط على الخادم ←
 *   مجموعة MLS للخيط (Welcome + Commit) ← تشفير المحتوى ← send (يُجمَّد الصف
 *   ويُصدر الرقم المرجعي).
 * - الرد: داخل مجموعة الخيط نفسها بنداء واحد (reply).
 * - الفتح: فك MLS لمرة واحدة، لذا يُغذّى الخيط كاملًا بالترتيب ويُخزَّن محتوى
 *   كل عنصر فيه مغلّفًا بالـKEK في مخزن `mail` (لا localStorage، لا سجلات).
 * - كل محتوى مفكوك يُتحقق من: ربطه بالصف (correspondence_id/reply_to_id)،
 *   وأن مرسله الموثّق في MLS هو المستخدم والجهاز اللذان يدّعيهما الخادم.
 */
import { chatApi, type Message } from '../chat/api';
import {
  encryptMessage,
  feedMessages,
  getChatSeq,
  getCurrentDeviceId,
  initThreadGroup,
  verifyMlsSender,
} from '../../crypto/mls';
import { getRecord, putRecord } from '../../crypto/keystore';
import { randomBytes, u8ToB64, uuid4 } from '../../crypto/encoding';
import { ApiError } from '../../shared/api';
import {
  correspondenceApi,
  type Classification,
  type CorrespondenceDetail,
  type Priority,
} from './api';
import {
  contentMatchesRow,
  decodeContent,
  encodeContent,
  encryptAttachment,
  type AttachmentKey,
  type CorrespondenceContent,
  type ForwardedQuote,
} from './content';

export interface StoredContent {
  content: CorrespondenceContent;
  /** هل طابق مرسل MLS الموثّق ما يدّعيه الخادم؟ (المرسلة من هذا الجهاز: true). */
  senderVerified: boolean;
  /** هل المحتوى مربوط بهذا الصف؟ */
  bound: boolean;
  decrypted_at: string;
  /** بيانات وصفية محلية للبحث المحلي (لا تُطلب من الخادم عند البحث). */
  meta?: ContentMeta;
}

export interface ContentMeta {
  reference_number: string | null;
  sender_name: string;
  sent_at: string | null;
}

function metaOf(detail: CorrespondenceDetail): ContentMeta {
  return { reference_number: detail.reference_number, sender_name: detail.sender.full_name, sent_at: detail.sent_at };
}

export type OpenResult =
  | { state: 'ok'; stored: StoredContent }
  | { state: 'unavailable'; reason: string };

// --- تسلسل العمليات لكل خيط -------------------------------------------------------
// تغذية الخيط تتقدم بمؤشر last_processed_seq؛ تشغيلان متزامنان على الخيط نفسه
// يعالجان الرسالة مرتين فيفشل الثاني ويتلف العرض. كل عمليات الخيط تمر بطابور.
const threadQueues = new Map<string, Promise<unknown>>();

export function serialized<T>(threadId: string, op: () => Promise<T>): Promise<T> {
  const previous = threadQueues.get(threadId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(op);
  threadQueues.set(threadId, next);
  return next;
}

// --- كاش المحتوى المحلي (مغلّف) --------------------------------------------------

export function getStoredContent(correspondenceId: string): Promise<StoredContent | undefined> {
  return getRecord<StoredContent>('mail', correspondenceId);
}

function storeContent(correspondenceId: string, stored: StoredContent): Promise<void> {
  return putRecord('mail', correspondenceId, stored);
}

// --- المرفقات -----------------------------------------------------------------------

async function uploadAttachments(files: File[]): Promise<AttachmentKey[]> {
  const keys: AttachmentKey[] = [];
  for (const file of files) {
    const { blob, meta } = await encryptAttachment(file);
    const uploaded = await correspondenceApi.uploadBlob(blob);
    if (uploaded.ciphertext_sha256 !== meta.sha256) {
      throw new Error('بصمة الملف على الخادم لا تطابق ما رُفع — أُلغي الإرسال');
    }
    keys.push({ id: uploaded.id, ...meta });
  }
  return keys;
}

// --- إرسال جديد / إحالة ---------------------------------------------------------------

export interface ComposeInput {
  to: string[];
  cc: string[];
  priority: Priority;
  classification: Classification;
  dueDate: string | null;
  subject: string;
  body: string;
  files: File[];
}

export interface ForwardSource {
  detail: CorrespondenceDetail;
  stored: StoredContent;
}

export async function sendCorrespondence(
  input: ComposeInput,
  forwardOf?: ForwardSource,
): Promise<CorrespondenceDetail> {
  const deviceId = String(await getCurrentDeviceId());
  const newKeys = await uploadAttachments(input.files);
  // الإحالة تعيد مشاركة مفاتيح مرفقات الأصل داخل المحتوى الجديد (المستلم الجديد
  // لا ينضم لخيط الأصل) ويربطها الخادم بالمراسلة الجديدة لصلاحية التنزيل.
  const reshared = forwardOf ? forwardOf.stored.content.attachments : [];
  const attachments = [...reshared, ...newKeys];

  const body = {
    to_user_ids: input.to,
    cc_user_ids: input.cc,
    priority: input.priority,
    classification: input.classification,
    due_date: input.dueDate,
    mls_group_id: u8ToB64(randomBytes(16)),
    client_ref: uuid4(),
  };
  const prepared = forwardOf
    ? await correspondenceApi.forward(forwardOf.detail.id, body)
    : await correspondenceApi.prepare(body);

  try {
    await serialized(prepared.thread.id, () =>
      initThreadGroup(prepared.thread, [...input.to, ...input.cc]),
    );
  } catch (err) {
    await correspondenceApi.discard(prepared.id).catch(() => undefined);
    throw err;
  }

  let forwarded: ForwardedQuote | undefined;
  if (forwardOf) {
    forwarded = {
      reference_number: forwardOf.detail.reference_number,
      sender_name: forwardOf.detail.sender.full_name,
      sent_at: forwardOf.detail.sent_at,
      subject: forwardOf.stored.content.subject,
      body: forwardOf.stored.content.body,
    };
  }
  const content = decodeContent(
    encodeContent({
      correspondence_id: prepared.id,
      subject: input.subject,
      body: input.body,
      attachments,
      forwarded,
    }),
  );

  const sent = await serialized(prepared.thread.id, async () => {
    const encrypted = await encryptMessage(
      { id: prepared.thread.id, mls_group_id: prepared.thread.mls_group_id },
      JSON.stringify(content),
    );
    return correspondenceApi.send(prepared.id, {
      mls_payload: encrypted.mls_payload_b64,
      client_msg_id: uuid4(),
      epoch: encrypted.epoch,
      sender_device_id: deviceId,
      attachment_ids: attachments.map((a) => a.id),
    });
  });
  // MLS لا يفك ما أرسلناه من هذا الجهاز — نسختنا المحلية هي المرجع.
  await storeContent(sent.id, {
    content,
    senderVerified: true,
    bound: true,
    decrypted_at: new Date().toISOString(),
    meta: metaOf(sent),
  });
  return sent;
}

// --- الرد ---------------------------------------------------------------------------------

export interface ReplyInput {
  subject: string;
  body: string;
  priority: Priority;
  dueDate: string | null;
  files: File[];
}

function isEpochConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}

export async function replyToCorrespondence(
  parent: CorrespondenceDetail,
  input: ReplyInput,
): Promise<CorrespondenceDetail> {
  const deviceId = String(await getCurrentDeviceId());
  const attachments = await uploadAttachments(input.files);
  const content = decodeContent(
    encodeContent({
      correspondence_id: null,
      reply_to_id: parent.id,
      subject: input.subject,
      body: input.body,
      attachments,
    }),
  );
  const clientRef = uuid4();
  const thread = { id: parent.thread.id, mls_group_id: parent.thread.mls_group_id };

  const attempt = () =>
    serialized(thread.id, async () => {
      await catchUpThread(thread, deviceId); // نصل لآخر جيل قبل التشفير
      const encrypted = await encryptMessage(thread, JSON.stringify(content));
      return correspondenceApi.reply(parent.id, {
        client_ref: clientRef,
        priority: input.priority,
        due_date: input.dueDate,
        mls_payload: encrypted.mls_payload_b64,
        client_msg_id: uuid4(),
        epoch: encrypted.epoch,
        sender_device_id: deviceId,
        attachment_ids: attachments.map((a) => a.id),
      });
    });

  let sent: CorrespondenceDetail;
  try {
    sent = await attempt();
  } catch (err) {
    if (!isEpochConflict(err)) throw err;
    sent = await attempt(); // نفس client_ref: الخادم يعيد استخدام صف الرد غير المرسل
  }
  await storeContent(sent.id, {
    content,
    senderVerified: true,
    bound: true,
    decrypted_at: new Date().toISOString(),
    meta: metaOf(sent),
  });
  return sent;
}

// --- الفتح والفك --------------------------------------------------------------------------

async function fetchAllThreadMessages(threadId: string, afterSeq: number): Promise<Message[]> {
  const out: Message[] = [];
  let cursor = afterSeq;
  for (;;) {
    const page = await chatApi.getMessages(threadId, cursor, 200);
    out.push(...page.messages);
    if (page.messages.length < 200) return out;
    cursor = page.messages[page.messages.length - 1].seq;
  }
}

/** ما فُك من رسالة في الخيط — يُخزن بمفتاح (الخيط، seq) قبل ربطه بأي صف. */
interface DecryptedThreadMessage {
  content: CorrespondenceContent;
  sender_user_id: string;
  sender_device_id: string;
  /** ورقة MLS الموثّقة = (sender_user_id|sender_device_id)؟ */
  mls_sender_ok: boolean;
}

const seqKey = (threadId: string, seq: number) => `seq:${threadId}:${seq}`;

/**
 * يغذي رسائل الخيط الجديدة بالترتيب ويخزّن كل محتوى مفكوك بمفتاح seq — لا
 * محتوى العنصر المطلوب فقط، فالفك لمرة واحدة وما لا يُخزن الآن يضيع. يُستدعى
 * داخل serialized.
 */
async function catchUpThread(thread: { id: string; mls_group_id: string }, deviceId: string): Promise<void> {
  const { last_processed_seq } = await getChatSeq(thread.id);
  const messages = await fetchAllThreadMessages(thread.id, last_processed_seq);
  if (messages.length === 0) return;
  const feed = await feedMessages(thread, messages, deviceId, { epochFilter: true });
  const bySeq = new Map(messages.map((m) => [m.seq, m]));
  for (const [seq, result] of feed.decrypted) {
    const message = bySeq.get(seq);
    if (!message || result.failed || result.plaintext === undefined) continue;
    let content: CorrespondenceContent;
    try {
      content = decodeContent(result.plaintext);
    } catch {
      continue; // ليس محتوى مراسلة صالحًا — لا نعرضه
    }
    const record: DecryptedThreadMessage = {
      content,
      sender_user_id: String(message.sender_user_id),
      sender_device_id: String(message.sender_device_id),
      mls_sender_ok: await verifyMlsSender(
        thread,
        message.sender_user_id,
        message.sender_device_id,
        result.senderIndex,
      ),
    };
    await putRecord('mail', seqKey(thread.id, seq), record);
  }
}

export interface ThreadRow {
  id: string;
  sender_id: string;
  reply_to_id: string | null;
  content_seq: number;
}

/** يربط صفًا بمحتواه المفكوك (كاش بالمعرف أولًا ثم بالـseq) ويثبّته بالمعرف. */
async function resolveRow(threadId: string, row: ThreadRow, meta?: ContentMeta): Promise<StoredContent | undefined> {
  const cached = await getStoredContent(row.id);
  if (cached) {
    if (meta && !cached.meta) await storeContent(row.id, { ...cached, meta });
    return cached;
  }
  const record = await getRecord<DecryptedThreadMessage>('mail', seqKey(threadId, row.content_seq));
  if (!record) return undefined;
  const stored: StoredContent = {
    content: record.content,
    senderVerified: record.mls_sender_ok && record.sender_user_id === String(row.sender_id),
    bound: contentMatchesRow(record.content, row),
    decrypted_at: new Date().toISOString(),
    meta,
  };
  await storeContent(row.id, stored);
  return stored;
}

function threadOf(detail: CorrespondenceDetail) {
  return { id: detail.thread.id, mls_group_id: detail.thread.mls_group_id };
}

export function openCorrespondence(detail: CorrespondenceDetail): Promise<OpenResult> {
  return serialized(detail.thread.id, async () => {
    const cached = await getStoredContent(detail.id);
    if (cached) {
      if (!cached.meta && detail.content) await storeContent(detail.id, { ...cached, meta: metaOf(detail) });
      return { state: 'ok', stored: cached } as const;
    }
    if (!detail.content) return { state: 'unavailable', reason: 'لم تُرسل المراسلة بعد' } as const;

    const deviceId = String(await getCurrentDeviceId());
    await catchUpThread(threadOf(detail), deviceId);
    const stored = await resolveRow(detail.thread.id, {
      id: detail.id,
      sender_id: detail.sender.id,
      reply_to_id: detail.reply_to_id,
      content_seq: detail.content.seq,
    }, metaOf(detail));
    if (stored) return { state: 'ok', stored } as const;
    if (String(detail.content.sender_device_id) === deviceId) {
      return {
        state: 'unavailable',
        reason: 'أُرسلت من هذا الجهاز ولم تعد نسختها المحلية متاحة (مُسح المخزن المحلي)',
      } as const;
    }
    return {
      state: 'unavailable',
      reason:
        'تعذر فك التشفير على هذا الجهاز — غالبًا أُرسلت قبل إضافة هذا الجهاز إلى الخيط، ولا يُمنح الجهاز الجديد التاريخ تلقائيًا',
    } as const;
  });
}

/** محتوى عناصر الخيط كلها (لعرض سلسلة المراسلة)؛ العناصر غير المتاحة تُعاد undefined. */
export function openThreadItems(
  detail: CorrespondenceDetail,
): Promise<Map<string, StoredContent | undefined>> {
  return serialized(detail.thread.id, async () => {
    await catchUpThread(threadOf(detail), String(await getCurrentDeviceId()));
    const out = new Map<string, StoredContent | undefined>();
    const names = new Map<string, string>([[detail.sender.id, detail.sender.full_name]]);
    for (const p of detail.participants) names.set(p.user.id, p.user.full_name);
    for (const item of detail.thread_items) {
      const meta = { reference_number: item.reference_number, sender_name: names.get(item.sender_id) ?? '', sent_at: item.sent_at };
      out.set(item.id, await resolveRow(detail.thread.id, item, meta));
    }
    return out;
  });
}
