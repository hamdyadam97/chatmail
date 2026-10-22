/**
 * عقد المراسلات — `/api/v1/correspondences/*` و`/api/v1/attachments/*`.
 * الخادم لا يستقبل ولا يعيد إلا بيانات وصفية وciphertext؛ المحتوى (العنوان
 * والنص ومفاتيح المرفقات) يسافر داخل رسالة MLS واحدة في `content.mls_payload`.
 */
import { API_BASE_URL, ApiError, apiFetch, getAccessToken } from '../../shared/api';

export type Folder = 'inbox' | 'sent' | 'drafts' | 'archived' | 'important' | 'pending_replies';
export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export type Classification = 'normal' | 'confidential' | 'institutional_archive_eligible';

export interface UserRef {
  id: string;
  full_name: string;
  username: string;
}

export interface Participant {
  user: UserRef;
  kind: 'to' | 'cc' | 'bcc';
  added_via: 'original' | 'reply' | 'forward';
  read_at: string | null;
}

export interface CorrespondenceSummary {
  id: string;
  reference_number: string | null;
  sender: UserRef;
  priority: Priority;
  classification: Classification;
  status: 'draft' | 'sent' | 'closed';
  due_date: string | null;
  created_at: string;
  sent_at: string | null;
  thread_id: string;
  thread_root_id: string | null;
  reply_to_id: string | null;
  is_forward: boolean;
  my_kind: 'from' | 'to' | 'cc' | 'bcc' | null;
  read_at: string | null;
  archived: boolean;
  is_important: boolean;
  participants: Participant[];
}

export interface ThreadRef {
  id: string;
  mls_group_id: string;
  current_epoch: number;
}

export interface ContentRef {
  seq: number;
  epoch: number;
  sender_device_id: string | null;
  client_msg_id: string;
  mls_payload: string;
}

export interface AttachmentRef {
  id: string;
  ciphertext_size: number;
  ciphertext_sha256: string;
  algorithm: string;
}

export interface ThreadItem {
  id: string;
  reference_number: string;
  sender_id: string;
  sent_at: string;
  reply_to_id: string | null;
  content_seq: number;
}

export interface CorrespondenceDetail extends CorrespondenceSummary {
  thread: ThreadRef;
  content: ContentRef | null;
  attachments: AttachmentRef[];
  forwarded_from_reference: string | null;
  thread_items: ThreadItem[];
}

export interface Page<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface CorrespondenceEvent {
  event_type: 'created' | 'sent' | 'read' | 'replied' | 'forwarded' | 'closed';
  actor: UserRef | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface PrepareBody {
  to_user_ids: string[];
  cc_user_ids: string[];
  priority: Priority;
  classification: Classification;
  due_date: string | null;
  mls_group_id: string;
  client_ref: string;
}

export interface SendBody {
  mls_payload: string;
  client_msg_id: string;
  epoch: number;
  sender_device_id: string;
  attachment_ids: string[];
}

export interface ListParams {
  folder: Folder;
  page?: number;
  q?: string;
  priority?: Priority | '';
  unread?: boolean;
}

function qs(params: ListParams): string {
  const search = new URLSearchParams({ folder: params.folder, page: String(params.page ?? 1) });
  if (params.q) search.set('q', params.q);
  if (params.priority) search.set('priority', params.priority);
  if (params.unread) search.set('unread', '1');
  return search.toString();
}

const BASE = '/correspondences';

/**
 * طلب بايتات خام (ليس JSON) بنفس توكن الذاكرة؛ عند 401 نمرّ بـapiFetch مرة
 * لتجديد التوكن عبر كوكي التحديث ثم نعيد المحاولة.
 */
async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  const go = () =>
    fetch(`${API_BASE_URL}${path}`, {
      credentials: 'include',
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${getAccessToken() ?? ''}` },
    });
  let res = await go();
  if (res.status === 401) {
    await apiFetch('/users/me/');
    res = await go();
  }
  return res;
}

export const correspondenceApi = {
  list: (params: ListParams) => apiFetch<Page<CorrespondenceSummary>>(`${BASE}/?${qs(params)}`),
  counts: () =>
    apiFetch<{ inbox_unread: number; pending_replies: number; drafts: number }>(`${BASE}/counts/`),
  get: (id: string) => apiFetch<CorrespondenceDetail>(`${BASE}/${id}/`),
  events: (id: string) => apiFetch<CorrespondenceEvent[]>(`${BASE}/${id}/events/`),
  prepare: (body: PrepareBody) => apiFetch<CorrespondenceDetail>(`${BASE}/`, { method: 'POST', body }),
  forward: (id: string, body: PrepareBody) =>
    apiFetch<CorrespondenceDetail>(`${BASE}/${id}/forward/`, { method: 'POST', body }),
  send: (id: string, body: SendBody) =>
    apiFetch<CorrespondenceDetail>(`${BASE}/${id}/send/`, { method: 'POST', body }),
  reply: (id: string, body: SendBody & { client_ref: string; priority: Priority; due_date: string | null }) =>
    apiFetch<CorrespondenceDetail>(`${BASE}/${id}/reply/`, { method: 'POST', body }),
  markRead: (id: string) => apiFetch<null>(`${BASE}/${id}/read/`, { method: 'POST' }),
  setFlags: (id: string, flags: { archived?: boolean; important?: boolean }) =>
    apiFetch<{ archived: boolean; is_important: boolean }>(`${BASE}/${id}/flags/`, {
      method: 'POST',
      body: flags,
    }),
  close: (id: string) => apiFetch<CorrespondenceDetail>(`${BASE}/${id}/close/`, { method: 'POST' }),
  discard: (id: string) => apiFetch<null>(`${BASE}/${id}/`, { method: 'DELETE' }),

  /** رفع blob مشفّر مسبقًا (application/octet-stream) — الخادم يرفض أي ملف صريح. */
  uploadBlob: async (blob: Uint8Array) => {
    const res = await rawFetch('/attachments/', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/octet-stream' },
      body: blob,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, data);
    return data as { id: string; ciphertext_size: number; ciphertext_sha256: string };
  },

  downloadBlob: async (id: string): Promise<Uint8Array> => {
    const res = await rawFetch(`/attachments/${id}/`, {});
    if (!res.ok) throw new ApiError(res.status, null);
    return new Uint8Array(await res.arrayBuffer());
  },
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  low: 'منخفضة',
  normal: 'عادية',
  high: 'عالية',
  urgent: 'عاجلة',
};

export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  normal: 'عادية',
  confidential: 'سرية',
  institutional_archive_eligible: 'قابلة للأرشفة المؤسسية',
};

export const FOLDER_LABELS: Record<Folder, string> = {
  inbox: 'الوارد',
  sent: 'الصادر',
  drafts: 'المسودات',
  archived: 'المؤرشفة',
  important: 'المهمة',
  pending_replies: 'بانتظار ردي',
};
