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
  created_at: string;
  read_at: string | null;
}

interface Address {
  name: string;
  address: string;
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
  html_converted: boolean;
  auth: 'pass' | 'fail' | 'none';
  attachments: AttachmentMeta[];
  removed_infected: string[];
  virus_scan: 'on' | 'off';
}

export interface StoredExternal {
  content: ExternalContent;
  meta: { from: string; created_at: string; direction: 'in' | 'out' };
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
    apiFetch<Page<ExternalSummary>>(`/external-mail/messages/?page=${page}${box === 'all' ? '' : `&box=${box}`}`),
  detail: (id: string) => apiFetch<ExternalSummary & { content: ExternalContent | null }>(`/external-mail/messages/${id}/`),
  markRead: (id: string) => apiFetch<null>(`/external-mail/messages/${id}/read/`, { method: 'POST' }),
  send: (body: {
    to: string[];
    cc: string[];
    subject: string;
    body: string;
    attachments: Array<{ name: string; mime: string; data: string }>;
    reply_to_id: string | null;
  }) => apiFetch<ExternalSummary>('/external-mail/send/', { method: 'POST', body }),
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
    stored: { content: detail.content, meta: { from: detail.from, created_at: detail.created_at, direction: detail.direction } },
  };
}

export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
