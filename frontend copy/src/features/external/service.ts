/**
 * البريد الخارجي (الإنترنت) — ليس مشفّرًا طرفًا لطرف من مصدره: الخادم يراه لحظة
 * وصوله أو خروجه، ثم يختمه فورًا لأجهزة صاحبه. هنا نفك الختم بمفتاح KEM الجهاز،
 * ونحفظ المحتوى مغلّفًا محليًا (`mail` بمفتاح `ext:<id>`) فيدخل النسخ الاحتياطي والبحث.
 */
import { apiFetch } from '../../shared/api';
import { EXTERNAL_SEAL_INFO, unseal, type Sealed } from '../../crypto/archive';
import { deviceFromSeeds, loadCurrentDevice } from '../../crypto/identity';
import { getRecord, putRecord } from '../../crypto/keystore';
import { useAuthUser } from '../../crypto/authBridge';
import type { AttachmentKey } from '../correspondence/content';

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
  attachments: AttachmentKey[];
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
  detail: (id: string, deviceId: string) =>
    apiFetch<ExternalSummary & { sealed: Sealed | null }>(
      `/external-mail/messages/${id}/?device_id=${encodeURIComponent(deviceId)}`,
    ),
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

const cacheKey = (id: string) => `ext:${id}`;

export async function getCachedExternal(id: string): Promise<StoredExternal | undefined> {
  return getRecord<StoredExternal>('mail', cacheKey(id));
}

export type ExternalOpen = { state: 'ok'; stored: StoredExternal } | { state: 'unavailable'; reason: string };

/** يفك نسخة الرسالة المختومة لهذا الجهاز (مرة واحدة ثم من الكاش المحلي المغلّف). */
export async function openExternal(id: string): Promise<ExternalOpen> {
  const cached = await getCachedExternal(id);
  if (cached) return { state: 'ok', stored: cached };
  const device = await loadCurrentDevice(useAuthUser().id);
  if (!device) return { state: 'unavailable', reason: 'لا مفاتيح جهاز على هذا المتصفح' };
  const detail = await externalApi.detail(id, String(device.deviceId));
  if (!detail.sealed) {
    return {
      state: 'unavailable',
      reason: 'هذه الرسالة وصلت قبل اعتماد هذا الجهاز، فلم تُختم له. افتحها من جهازك الذي كان معتمدًا وقتها.',
    };
  }
  const kem = (await deviceFromSeeds(device.signSeed, device.kemSeed)).kem;
  const plain = await unseal(
    { privateKey: kem.privateKey, pub: kem.pub },
    detail.sealed,
    `corr-external-v1|${id}|${device.deviceId}`,
    EXTERNAL_SEAL_INFO,
  );
  const content = JSON.parse(new TextDecoder().decode(plain)) as ExternalContent;
  const stored: StoredExternal = {
    content,
    meta: { from: detail.from, created_at: detail.created_at, direction: detail.direction },
  };
  await putRecord('mail', cacheKey(id), stored);
  return { state: 'ok', stored };
}

export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
