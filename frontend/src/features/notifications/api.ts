/**
 * `/api/v1/notifications/*` — إشعارات عامة الصياغة فقط (لا محتوى؛ SEC-11).
 */
import { apiFetch } from '../../shared/api';

export type NotificationKind =
  | 'new_correspondence'
  | 'correspondence_reply'
  | 'correspondence_forward'
  | 'approval_requested'
  | 'approval_decided'
  | 'device_alert'
  | 'announcement'
  | 'announcement_reminder'
  | 'correspondence_due_soon'
  | 'correspondence_overdue'
  | 'correspondence_overdue_sender'
  | 'external_mail';

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  ref_type: string;
  ref_id: string | null;
  created_at: string;
  read_at: string | null;
}

export interface NotificationPage {
  count: number;
  next: string | null;
  previous: string | null;
  results: AppNotification[];
}

export const notificationsApi = {
  list: (page = 1, unread = false) =>
    apiFetch<NotificationPage>(`/notifications/?page=${page}${unread ? '&unread=1' : ''}`),
  unreadCount: () => apiFetch<{ unread: number }>('/notifications/unread-count/'),
  markRead: (id: string) => apiFetch<null>(`/notifications/${id}/read/`, { method: 'POST' }),
  markAllRead: () => apiFetch<null>('/notifications/read-all/', { method: 'POST' }),
  wsTicket: () => apiFetch<{ ticket: string }>('/notifications/ws-ticket/'),
};

/** وجهة الإشعار داخل التطبيق (حسب نوع المرجع). */
export function notificationTarget(n: AppNotification): string {
  if (n.ref_type === 'correspondence' && n.ref_id) return `/correspondence/${n.ref_id}`;
  if (n.ref_type === 'approval_request' && n.ref_id) return `/approvals/${n.ref_id}`;
  if (n.ref_type === 'announcement' && n.ref_id) return `/announcements/${n.ref_id}`;
  if (n.ref_type === 'external_message' && n.ref_id) return `/mail/external/${n.ref_id}`;
  if (n.ref_type === 'login_approval') return '/login-approvals';
  return '/notifications';
}

export function notificationsWsUrl(ticket: string): string {
  const base = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:8000/api/v1';
  const wsBase = base.replace(/^http/, 'ws').replace(/\/api\/v1\/?$/, '');
  return `${wsBase}/ws/notifications/?ticket=${encodeURIComponent(ticket)}`;
}
