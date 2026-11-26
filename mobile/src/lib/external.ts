/** البريد الخارجي (الإنترنت) — نفس عقد الموقع `/external-mail/*`. */
import { File } from 'expo-file-system';

import { api } from './api';
import type { AttachmentMeta, Page } from './types';
import type { LocalFile } from './upload';

export interface MailboxInfo {
  address: string | null;
  sending_enabled: boolean;
  sending_configured: boolean;
  receiving_configured: boolean;
  unread: number;
}

export interface Address {
  name: string;
  address: string;
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
  attachment_count: number;
  thread_id?: string;
  thread_count?: number;
  thread_unread?: number;
  created_at: string;
  read_at: string | null;
}

export interface ExternalContent {
  direction: 'in' | 'out';
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  body: string;
  auth: 'pass' | 'fail' | 'none';
  attachments: AttachmentMeta[];
  removed_infected: string[];
}

export interface ExternalDetail extends ExternalSummary {
  content: ExternalContent | null;
  thread?: ExternalSummary[];
}

export interface ExternalContact {
  address: string;
  name: string;
}

export const externalApi = {
  me: () => api<MailboxInfo>('/external-mail/me/'),
  /** صف لكل محادثة (أحدث رسالة + عدد رسائلها وغير المقروء). */
  list: (page = 1, q = '') =>
    api<Page<ExternalSummary>>(`/external-mail/messages/?threads=1&page=${page}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  get: (id: string) => api<ExternalDetail>(`/external-mail/messages/${id}/`),
  read: (id: string) => api(`/external-mail/messages/${id}/read/`, { method: 'POST' }),
  contacts: () => api<ExternalContact[]>('/external-mail/contacts/'),
  send: (body: {
    to: string[];
    cc: string[];
    subject: string;
    body: string;
    attachments: { name: string; mime: string; data: string }[];
    reply_to_id: string | null;
    names?: Record<string, string>;
  }) => api<ExternalSummary>('/external-mail/send/', { method: 'POST', body }),
};

/** المرفقات الحقيقية (بلا نسخة .eml الأصلية المحفوظة للأرشفة). */
export function realAttachments(c: ExternalContent): AttachmentMeta[] {
  return c.attachments.filter((a) => a.name !== 'original.eml' || a.mime !== 'message/rfc822');
}

export function addressLine(a: Address): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

const EMAIL_RE = /^[^@\s<>"']{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;

/** «a@b.com, الاسم <c@d.com>» ← عناوين صالحة + ما لم يُفهم. */
export function parseAddresses(text: string): { ok: Address[]; bad: string[] } {
  const ok: Address[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/[,;،\n]+/)) {
    const t = raw.trim();
    if (!t) continue;
    const m = t.match(/^(.*?)\s*<\s*([^<>\s]+)\s*>$/);
    const address = (m ? m[2] : t).trim();
    if (EMAIL_RE.test(address)) ok.push({ address, name: m ? m[1].replace(/^["']|["']$/g, '').trim() : '' });
    else bad.push(t);
  }
  return { ok, bad };
}

/** ملف من الهاتف ← {name, mime, data(base64)} لإرساله في JSON. */
export async function fileForSend(f: LocalFile): Promise<{ name: string; mime: string; data: string }> {
  const data = await new File(f.uri).base64();
  return { name: f.name, mime: f.mime, data };
}
