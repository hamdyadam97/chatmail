import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import { Button, Card, EmptyState, Spinner } from '../../shared/ui';
import { cn } from '../../shared/lib/cn';
import { notificationTarget, notificationsApi, type AppNotification } from './api';
import { PushSettingsCard } from './PushControls';

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

export function Notifications() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['notifications', 'list', page, unreadOnly],
    queryFn: () => notificationsApi.list(page, unreadOnly),
    placeholderData: keepPreviousData,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });
  const markAll = useMutation({ mutationFn: notificationsApi.markAllRead, onSuccess: refresh });

  const open = async (n: AppNotification) => {
    if (!n.read_at) await notificationsApi.markRead(n.id).catch(() => undefined);
    void refresh();
    navigate(notificationTarget(n));
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">الإشعارات</h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(e) => {
                setUnreadOnly(e.target.checked);
                setPage(1);
              }}
              className="accent-primary-600"
            />
            غير المقروءة فقط
          </label>
          <Button variant="outline" size="sm" onClick={() => markAll.mutate()} loading={markAll.isPending}>
            <CheckCheck className="h-4 w-4" />
            تعليم الكل كمقروء
          </Button>
        </div>
      </div>
      <p className="text-xs text-gray-500">
        الإشعارات لا تحمل أي محتوى (لا عناوين ولا نصوص) — افتح المراسلة نفسها لقراءتها.
      </p>
      <PushSettingsCard />
      {isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : !data || data.results.length === 0 ? (
        <EmptyState icon={Bell} title="لا إشعارات" />
      ) : (
        <Card className="overflow-hidden">
          {data.results.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => void open(n)}
              className={cn(
                'flex w-full items-center gap-3 border-b border-gray-100 px-4 py-3 text-start text-sm last:border-0 hover:bg-gray-50',
                !n.read_at && 'bg-primary-50/40',
              )}
            >
              <span className={cn('h-2 w-2 shrink-0 rounded-full', n.read_at ? 'bg-transparent' : 'bg-primary-600')} />
              <span className={cn('flex-1', n.read_at ? 'text-gray-700' : 'font-semibold text-gray-900')}>{n.title}</span>
              <span className="text-xs text-gray-500">{formatDate(n.created_at)}</span>
            </button>
          ))}
        </Card>
      )}
      {data && (data.next || data.previous) && (
        <div className="flex justify-center gap-3">
          <Button variant="outline" size="sm" disabled={!data.previous} onClick={() => setPage((p) => p - 1)}>
            السابق
          </Button>
          <Button variant="outline" size="sm" disabled={!data.next} onClick={() => setPage((p) => p + 1)}>
            التالي
          </Button>
        </div>
      )}
    </div>
  );
}

export const NotificationsPages = { Notifications };
