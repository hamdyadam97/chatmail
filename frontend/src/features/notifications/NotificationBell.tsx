import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { ChatSocket } from '../chat/ws';
import { notificationsApi, notificationsWsUrl, type AppNotification } from './api';

/** ما يجب إعادة جلبه عند وصول إشعار حي من كل نوع. */
const INVALIDATES: Record<string, string[][]> = {
  new_correspondence: [['correspondences'], ['correspondence-counts']],
  correspondence_reply: [['correspondences'], ['correspondence-counts'], ['correspondence']],
  correspondence_forward: [['correspondences'], ['correspondence-counts']],
  approval_requested: [['approvals']],
  approval_decided: [['approvals']],
  device_alert: [['devices']],
  announcement: [['announcements']],
  announcement_reminder: [['announcements']],
  correspondence_due_soon: [['correspondences'], ['correspondence-counts']],
  correspondence_overdue: [['correspondences'], ['correspondence-counts']],
  correspondence_overdue_sender: [['correspondences']],
  external_mail: [['external-messages'], ['external-mailbox']],
};

/**
 * جرس الإشعارات + اتصال WS واحد على مستوى التطبيق (/ws/notifications/ بتذكرة
 * لمرة واحدة، وإعادة اتصال بتباعد أسّي). الإطارات عامة الصياغة؛ لا محتوى.
 */
export function NotificationBell() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: notificationsApi.unreadCount,
    refetchInterval: 60_000,
  });

  useEffect(() => {
    const socket = new ChatSocket(
      'notifications',
      async () => (await notificationsApi.wsTicket()).ticket,
      (_id, ticket) => notificationsWsUrl(ticket),
      {
        onEvent: (raw) => {
          const frame = raw as unknown as { type?: string; notification?: AppNotification };
          if (frame.type !== 'notification' || !frame.notification) return;
          void queryClient.invalidateQueries({ queryKey: ['notifications'] });
          for (const key of INVALIDATES[frame.notification.kind] ?? []) {
            void queryClient.invalidateQueries({ queryKey: key });
          }
        },
        onResync: () => void queryClient.invalidateQueries({ queryKey: ['notifications'] }),
        onRemoved: () => undefined,
      },
    );
    socket.connect();
    return () => socket.close();
  }, [queryClient]);

  const unread = data?.unread ?? 0;
  // العدد في عنوان التبويب يظهر حتى والتبويب في الخلفية.
  useEffect(() => {
    const base = 'نظام المراسلات الداخلية';
    document.title = unread > 0 ? `(${unread > 99 ? '99+' : unread}) ${base}` : base;
  }, [unread]);
  return (
    <Link
      to="/notifications"
      className="relative rounded-lg p-2 text-gray-600 hover:bg-gray-100"
      aria-label={unread ? `الإشعارات — ${unread} غير مقروء` : 'الإشعارات'}
    >
      <Bell className="h-5 w-5" />
      {unread > 0 && (
        <span className="absolute -end-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-xs font-semibold text-white">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Link>
  );
}
