/**
 * البريد الخارجي (الإنترنت): يصل عبر Postfix ويخرج عبر Brevo، ويُحفظ على
 * الخادم مشفّرًا بمفتاحه ويُعاد لصاحبه فقط.
 */
import { apiFetch } from '../../shared/api';
import type { AttachmentMeta } from '../correspondence/api';

export interface MailboxInfo {
  address: string | null;
  local_part: string | null;
  receiving_enabled: boolean;
  sending_enabled: boolean;
  receiving_configured: boolean;
  sending_configured: boolean;
  unread: number;
}

export interface ExternalSummary {
  id: string;
  subject: string;
  preview: string;
  from_name: string;
  direction: 'in' | 'out';
  from: string;
  recipients: string[];
  auth: 'pass' | 'fail' | 'none';
  size: number;
  attachment_count: number;
  in_reply_to_id: string | null;
  /** المحادثة التي تنتمي إليها (= أول رسالة فيها). */
  thread_id?: string;
  /** في قائمة المحادثات فقط: عدد رسائلها وغير المقروء منها. */
  thread_count?: number;
  thread_unread?: number;
  created_at: string;
  read_at: string | null;
}

interface Address {
  name: string;
  address: string;
}

export interface ExternalContact {
  address: string;
  name: string;
  use_count: number;
  last_used_at: string | null;
}

/** مستلم خارجي في المحرر. */
export interface ExternalRecipient {
  address: string;
  name: string;
}

const EMAIL_RE = /^[^@\s<>"']{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;

/** «الاسم <a@b.com>» أو «a@b.com» ← مستلم؛ وإلا null. */
export function parseRecipient(text: string): ExternalRecipient | null {
  const t = text.trim().replace(/[,;]+$/, '');
  const m = t.match(/^(.*?)\s*<\s*([^<>\s]+)\s*>$/);
  const address = (m ? m[2] : t).trim();
  if (!EMAIL_RE.test(address)) return null;
  return { address, name: m ? m[1].replace(/^["']|["']$/g, '').trim() : '' };
}

/** {عنوان: اسم} للعناوين التي لها اسم. */
export function namesOf(list: ExternalRecipient[]): Record<string, string> {
  return Object.fromEntries(list.filter((r) => r.name).map((r) => [r.address.toLowerCase(), r.name]));
}

export interface ExternalContent {
  v: 1;
  kind: 'external';
  direction: 'in' | 'out';
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  date: string;
  body: string;
  /** HTML منظّف على الخادم (قائمة سماح)؛ فارغ للرسائل النصية والصادرة. */
  html?: string;
  html_converted: boolean;
  auth: 'pass' | 'fail' | 'none';
  attachments: AttachmentMeta[];
  removed_infected: string[];
  virus_scan: 'on' | 'off';
}

export interface StoredExternal {
  content: ExternalContent;
  meta: { from: string; created_at: string; direction: 'in' | 'out'; images_allowed: boolean; thread: ExternalSummary[] };
}

interface Page<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export const externalApi = {
  me: () => apiFetch<MailboxInfo>('/external-mail/me/'),
  list: (page: number, box: 'all' | 'in' | 'out') =>
    apiFetch<Page<ExternalSummary>>(`/external-mail/messages/?threads=1&page=${page}${box === 'all' ? '' : `&box=${box}`}`),
  detail: (id: string) =>
    apiFetch<ExternalSummary & { content: ExternalContent | null; images_allowed: boolean; thread?: ExternalSummary[] }>(
      `/external-mail/messages/${id}/`,
    ),
  /** إظهار صور مرسل موثّق تلقائيًا (أو إيقافه). */
  imageSender: (address: string, allow: boolean) =>
    apiFetch<{ image_senders: string[] }>('/external-mail/image-senders/', { method: 'POST', body: { address, allow } }),
  markRead: (id: string) => apiFetch<null>(`/external-mail/messages/${id}/read/`, { method: 'POST' }),
  send: (body: {
    to: string[];
    cc: string[];
    subject: string;
    body: string;
    attachments: Array<{ name: string; mime: string; data: string }>;
    reply_to_id: string | null;
    /** اسم العرض لكل عنوان (يُحفظ في دفتر العناوين). */
    names?: Record<string, string>;
  }) => apiFetch<ExternalSummary>('/external-mail/send/', { method: 'POST', body }),
  /** دفتر العناوين: كل عنوان أرسلتَ إليه يُحفظ تلقائيًا. */
  contacts: () => apiFetch<ExternalContact[]>('/external-mail/contacts/'),
  forgetContact: (address: string) =>
    apiFetch<null>(`/external-mail/contacts/?address=${encodeURIComponent(address)}`, { method: 'DELETE' }),
  mailbox: (userId: string) => apiFetch<MailboxInfo>(`/external-mail/mailboxes/${userId}/`),
  updateMailbox: (userId: string, body: Partial<Pick<MailboxInfo, 'local_part' | 'receiving_enabled' | 'sending_enabled'>>) =>
    apiFetch<MailboxInfo>(`/external-mail/mailboxes/${userId}/`, { method: 'PATCH', body }),
};

export type ExternalOpen = { state: 'ok'; stored: StoredExternal } | { state: 'unavailable'; reason: string };

export async function openExternal(id: string): Promise<ExternalOpen> {
  const detail = await externalApi.detail(id);
  if (!detail.content) return { state: 'unavailable', reason: 'تعذر عرض محتوى هذه الرسالة.' };
  return {
    state: 'ok',
    stored: {
      content: detail.content,
      meta: {
        from: detail.from,
        created_at: detail.created_at,
        direction: detail.direction,
        images_allowed: detail.images_allowed,
        thread: detail.thread ?? [],
      },
    },
  };
}

export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
