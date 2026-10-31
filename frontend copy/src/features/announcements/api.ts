/** `/api/v1/announcements/*` — التعاميم: البيانات الوصفية والـciphertext فقط. */
import { apiFetch } from '../../shared/api';

export type TargetType = 'users' | 'department' | 'branch' | 'institute' | 'all';
export type AnnouncementPriority = 'normal' | 'high' | 'urgent';

export interface UserRef {
  id: string;
  full_name: string;
  username: string;
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
  thread: { id: string; mls_group_id: string; current_epoch: number };
  content_hash: string | null;
  content: {
    seq: number;
    epoch: number;
    sender_device_id: string | null;
    client_msg_id: string;
    mls_payload: string;
  } | null;
  mine: { delivered_at: string | null; read_at: string | null; acknowledged_at: string | null } | null;
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

export interface PrepareBody {
  target_type: TargetType;
  target_id: string | null;
  user_ids: string[];
  priority: AnnouncementPriority;
  requires_ack: boolean;
  ack_due_at: string | null;
  mls_group_id: string;
  client_ref: string;
}

export interface OrgUnit {
  id: string;
  name: string;
  code: string;
  institute?: string;
  branch?: string | null;
}

export const announcementsApi = {
  list: (box: 'received' | 'published', page = 1, pendingAck = false) =>
    apiFetch<Page<Announcement>>(`/announcements/?box=${box}&page=${page}${pendingAck ? '&pending_ack=1' : ''}`),
  get: (id: string) => apiFetch<Announcement>(`/announcements/${id}/`),
  audience: (id: string) => apiFetch<{ publisher: UserRef; recipients: UserRef[] }>(`/announcements/${id}/audience/`),
  prepare: (body: PrepareBody) => apiFetch<Announcement>('/announcements/', { method: 'POST', body }),
  discard: (id: string) => apiFetch<null>(`/announcements/${id}/`, { method: 'DELETE' }),
  publish: (id: string, body: { mls_payload: string; client_msg_id: string; epoch: number; sender_device_id: string }) =>
    apiFetch<Announcement>(`/announcements/${id}/publish/`, { method: 'POST', body }),
  markRead: (id: string) => apiFetch<null>(`/announcements/${id}/read/`, { method: 'POST' }),
  ack: (id: string, body: { payload: string; signature: string; device_id: string }) =>
    apiFetch<{ acknowledged_at: string }>(`/announcements/${id}/ack/`, { method: 'POST', body }),
  compliance: (id: string) => apiFetch<Compliance>(`/announcements/${id}/compliance/`),
  remind: (id: string) => apiFetch<{ reminded: number }>(`/announcements/${id}/remind/`, { method: 'POST' }),
  withdraw: (id: string) => apiFetch<Announcement>(`/announcements/${id}/withdraw/`, { method: 'POST' }),
  institutes: () => apiFetch<OrgUnit[]>('/org/institutes/'),
  branches: () => apiFetch<OrgUnit[]>('/org/branches/'),
  departments: () => apiFetch<OrgUnit[]>('/org/departments/'),
};

export const TARGET_LABELS: Record<TargetType, string> = {
  users: 'موظفون محددون',
  department: 'قسم',
  branch: 'فرع',
  institute: 'معهد',
  all: 'جميع المعاهد',
};

export const PRIORITY_LABELS: Record<AnnouncementPriority, string> = {
  normal: 'عادي',
  high: 'مهم',
  urgent: 'عاجل',
};
