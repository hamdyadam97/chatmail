/** `/api/v1/announcements/*` — التعاميم. المحتوى محفوظ مشفّرًا على الخادم ويُعاد للناشر والمستلمين. */
import { apiFetch } from '../../shared/api';

export type TargetType = 'users' | 'department' | 'branch' | 'branches' | 'institute' | 'all';
export type AnnouncementPriority = 'normal' | 'high' | 'urgent';

export interface UserRef {
  id: string;
  full_name: string;
  username: string;
  /** فرع الموظف الرئيسي ومعهده (في التقرير وقوائم الجمهور). */
  branch?: string | null;
  institute?: string | null;
}

export interface Announcement {
  id: string;
  reference_number: string | null;
  publisher: UserRef;
  target: { type: TargetType; id: string | null; name: string | null };
  priority: AnnouncementPriority;
  requires_ack: boolean;
  ack_due_at: string | null;
  status: 'draft' | 'published' | 'withdrawn';
  created_at: string;
  published_at: string | null;
  withdrawn_at: string | null;
  recipient_count: number;
  is_publisher: boolean;
  can_track: boolean;
  content_hash: string | null;
  /** null للمستلم بعد سحب التعميم. */
  content: { title: string; body: string } | null;
  mine: { delivered_at: string | null; read_at: string | null; acknowledged_at: string | null; /** نسخة المدير التنفيذي: اطلاع فقط بلا إقرار. */ observer?: boolean } | null;
  /** تبويب «متابعة التعاميم» فقط. */
  counts?: { recipients: number; read: number; acknowledged: number };
}

export interface Page<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface ComplianceRow {
  user: UserRef;
  delivered_at: string | null;
  read_at: string | null;
  acknowledged_at: string | null;
  overdue: boolean;
  reminder_count: number;
}

export interface Compliance {
  total: number;
  delivered: number;
  read: number;
  acknowledged: number;
  overdue: number;
  rows: ComplianceRow[];
}

export interface AudienceTarget {
  target_type: TargetType;
  target_id: string | null;
  user_ids: string[];
  branch_ids?: string[];
}

/** أين يحق لي النشر: الكل، ومعاهد، وفروع (حسب دوري). */
export interface PublishTargets {
  all: boolean;
  institutes: Array<{ id: string; name: string; code: string }>;
  branches: Array<{ id: string; name: string; code: string; institute: string }>;
  /** يتابع اطلاع التعاميم في نطاقه (تبويب «متابعة التعاميم»). */
  can_track?: boolean;
}

export interface PublishBody extends AudienceTarget {
  priority: AnnouncementPriority;
  requires_ack: boolean;
  ack_due_at: string | null;
  client_ref: string;
  title: string;
  body: string;
}

export interface OrgUnit {
  id: string;
  name: string;
  code: string;
  institute?: string;
  branch?: string | null;
}

export const announcementsApi = {
  list: (box: 'received' | 'published' | 'tracking', page = 1, pendingAck = false) =>
    apiFetch<Page<Announcement>>(`/announcements/?box=${box}&page=${page}${pendingAck ? '&pending_ack=1' : ''}`),
  /** آخر 100 تعميم في نطاق متابعتي (لاختيار تعميم في فلتر الموظفين). */
  trackingOptions: () => apiFetch<Page<Announcement>>('/announcements/?box=tracking&page_size=100'),
  get: (id: string) => apiFetch<Announcement>(`/announcements/${id}/`),
  audience: (id: string) => apiFetch<{ publisher: UserRef; recipients: UserRef[] }>(`/announcements/${id}/audience/`),
  previewAudience: (body: AudienceTarget) =>
    apiFetch<{ recipients: UserRef[] }>('/announcements/audience-preview/', { method: 'POST', body }),
  publish: (body: PublishBody) => apiFetch<Announcement>('/announcements/', { method: 'POST', body }),
  markRead: (id: string) => apiFetch<null>(`/announcements/${id}/read/`, { method: 'POST' }),
  ack: (id: string) => apiFetch<{ acknowledged_at: string }>(`/announcements/${id}/ack/`, { method: 'POST' }),
  compliance: (id: string) => apiFetch<Compliance>(`/announcements/${id}/compliance/`),
  newMembers: (id: string) =>
    apiFetch<{ can_add: boolean; users: { id: string; full_name: string; username: string; branch?: string | null; institute?: string | null }[] }>(
      `/announcements/${id}/new-members/`,
    ),
  addNewMembers: (id: string) => apiFetch<{ added: number }>(`/announcements/${id}/new-members/`, { method: 'POST' }),
  remind: (id: string) => apiFetch<{ reminded: number }>(`/announcements/${id}/remind/`, { method: 'POST' }),
  withdraw: (id: string) => apiFetch<Announcement>(`/announcements/${id}/withdraw/`, { method: 'POST' }),
  targets: () => apiFetch<PublishTargets>('/announcements/targets/'),
  institutes: () => apiFetch<OrgUnit[]>('/org/institutes/'),
  branches: () => apiFetch<OrgUnit[]>('/org/branches/'),
  departments: () => apiFetch<OrgUnit[]>('/org/departments/'),
};

export const TARGET_LABELS: Record<TargetType, string> = {
  users: 'موظفون محددون',
  department: 'قسم',
  branch: 'فرع',
  branches: 'عدة فروع',
  institute: 'معهد',
  all: 'جميع المعاهد',
};

export const PRIORITY_LABELS: Record<AnnouncementPriority, string> = {
  normal: 'عادي',
  high: 'مهم',
  urgent: 'عاجل',
};
