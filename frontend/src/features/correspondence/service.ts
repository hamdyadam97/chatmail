/**
 * تنسيق المراسلات على العميل: رفع المرفقات ثم نداء واحد للإرسال أو الحفظ
 * كمسودة (المسودات على الخادم فتظهر من أي جهاز).
 */
import {
  correspondenceApi,
  type AttachmentMeta,
  type Classification,
  type CorrespondenceDetail,
  type Priority,
} from './api';

export interface ComposeInput {
  to: string[];
  cc: string[];
  priority: Priority;
  classification: Classification;
  dueDate: string | null;
  subject: string;
  body: string;
  /** مرفقات مرفوعة سابقًا (مسودة محفوظة). */
  attachments: AttachmentMeta[];
  /** ملفات جديدة تُرفع الآن. */
  files: File[];
}

async function uploadAll(files: File[]): Promise<AttachmentMeta[]> {
  const out: AttachmentMeta[] = [];
  for (const file of files) out.push(await correspondenceApi.upload(file));
  return out;
}

async function bodyOf(input: ComposeInput) {
  const uploaded = await uploadAll(input.files);
  return {
    to_user_ids: input.to,
    cc_user_ids: input.cc,
    priority: input.priority,
    classification: input.classification,
    due_date: input.dueDate,
    subject: input.subject,
    body: input.body,
    attachment_ids: [...input.attachments, ...uploaded].map((a) => a.id),
  };
}

/** إرسال جديد، أو إحالة (forwardOfId)، أو حفظ مسودة (send=false). */
export async function sendCorrespondence(
  input: ComposeInput,
  { forwardOfId, send = true, clientRef = crypto.randomUUID() }: { forwardOfId?: string; send?: boolean; clientRef?: string } = {},
): Promise<CorrespondenceDetail> {
  const body = { ...(await bodyOf(input)), client_ref: clientRef, send };
  return forwardOfId ? correspondenceApi.forward(forwardOfId, body) : correspondenceApi.compose(body);
}

/** تحديث مسودة محفوظة، ثم إرسالها إن طُلب. */
export async function saveDraft(id: string, input: ComposeInput, send = false): Promise<CorrespondenceDetail> {
  const saved = await correspondenceApi.updateDraft(id, await bodyOf(input));
  return send ? correspondenceApi.sendDraft(id) : saved;
}

export interface ReplyInput {
  subject: string;
  body: string;
  priority: Priority;
  dueDate: string | null;
  files: File[];
}

export async function replyToCorrespondence(parent: CorrespondenceDetail, input: ReplyInput): Promise<CorrespondenceDetail> {
  const uploaded = await uploadAll(input.files);
  return correspondenceApi.reply(parent.id, {
    client_ref: crypto.randomUUID(),
    priority: input.priority,
    due_date: input.dueDate,
    subject: input.subject,
    body: input.body,
    attachment_ids: uploaded.map((a) => a.id),
  });
}
