/**
 * عقد المراسلات — `/api/v1/correspondences/*` و`/api/v1/attachments/*`.
 * المحتوى يُخزَّن على الخادم مشفّرًا بمفتاحه ويُعاد مفتوحًا للمشاركين فقط
 * (أي دخول للحساب من أي متصفح يرى بريده — مثل Outlook).
 */
import { ApiError, apiFetch, rawFetch } from '../../shared/api';

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
  subject: string;
  /** أول سطر من النص (للقائمة). */
  preview: string;
  has_attachments: boolean;
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
  /** في القائمة فقط: حجم المحادثة كلها (ما أستطيع قراءته، ومنه ردودي) وآخر نشاط فيها. */
  thread_count?: number;
  thread_last_at?: string | null;
}

export interface AttachmentMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface ForwardedQuote {
  reference_number: string | null;
  sender_name: string;
  sent_at: string | null;
  subject: string;
  body: string;
}

export interface CorrespondenceContent {
  subject: string;
  body: string;
  attachments: AttachmentMeta[];
  forwarded: ForwardedQuote | null;
}

export interface ThreadItem {
  id: string;
  reference_number: string;
  sender_id: string;
  sent_at: string;
  reply_to_id: string | null;
  /** لم أقرأها بعد (صفّي أنا فقط). */
  unread: boolean;
  subject: string;
  body: string;
  attachments: AttachmentMeta[];
  forwarded: ForwardedQuote | null;
}

export interface CorrespondenceDetail extends CorrespondenceSummary {
  content: CorrespondenceContent | null;
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

export interface ComposeBody {
  to_user_ids: string[];
  cc_user_ids: string[];
  priority: Priority;
  classification: Classification;
  due_date: string | null;
  subject: string;
  body: string;
  attachment_ids: string[];
  client_ref: string;
  /** false = حفظ كمسودة. */
  send: boolean;
}

export type DraftBody = Omit<ComposeBody, 'client_ref' | 'send'>;

export interface ReplyBody {
  client_ref: string;
  priority: Priority;
  due_date: string | null;
  subject: string;
  body: string;
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

export const correspondenceApi = {
  list: (params: ListParams) => apiFetch<Page<CorrespondenceSummary>>(`${BASE}/?${qs(params)}`),
  counts: () =>
    apiFetch<{ inbox_unread: number; pending_replies: number; drafts: number }>(`${BASE}/counts/`),
  get: (id: string) => apiFetch<CorrespondenceDetail>(`${BASE}/${id}/`),
  events: (id: string) => apiFetch<CorrespondenceEvent[]>(`${BASE}/${id}/events/`),
  compose: (body: ComposeBody) => apiFetch<CorrespondenceDetail>(`${BASE}/`, { method: 'POST', body }),
  updateDraft: (id: string, body: DraftBody) =>
    apiFetch<CorrespondenceDetail>(`${BASE}/${id}/`, { method: 'PATCH', body }),
  sendDraft: (id: string) => apiFetch<CorrespondenceDetail>(`${BASE}/${id}/send/`, { method: 'POST' }),
  forward: (id: string, body: ComposeBody) =>
    apiFetch<CorrespondenceDetail>(`${BASE}/${id}/forward/`, { method: 'POST', body }),
  reply: (id: string, body: ReplyBody) =>
    apiFetch<CorrespondenceDetail>(`${BASE}/${id}/reply/`, { method: 'POST', body }),
  markRead: (id: string) => apiFetch<null>(`${BASE}/${id}/read/`, { method: 'POST' }),
  setFlags: (id: string, flags: { archived?: boolean; important?: boolean }) =>
    apiFetch<{ archived: boolean; is_important: boolean }>(`${BASE}/${id}/flags/`, {
      method: 'POST',
      body: flags,
    }),
  close: (id: string) => apiFetch<CorrespondenceDetail>(`${BASE}/${id}/close/`, { method: 'POST' }),
  discard: (id: string) => apiFetch<null>(`${BASE}/${id}/`, { method: 'DELETE' }),

  /** رفع ملف (multipart) — الخادم يشفّره ويعيد اسمه وحجمه ومعرّفه. */
  upload: async (file: File): Promise<AttachmentMeta> => {
    const form = new FormData();
    form.append('file', file, file.name);
    const res = await rawFetch('/attachments/', { method: 'POST', headers: { Accept: 'application/json' }, body: form });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, data);
    return data as AttachmentMeta;
  },

  download: async (id: string): Promise<Blob> => {
    const res = await rawFetch(`/attachments/${id}/`, {});
    if (!res.ok) throw new ApiError(res.status, null);
    return res.blob();
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
