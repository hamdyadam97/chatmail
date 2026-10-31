import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { Button, Card, EmptyState, Spinner } from '../../shared/ui';
import { apiFetch, toUserMessage } from '../../shared/api';

interface PendingLogin {
  id: string;
  user: { id: string; full_name: string; username: string };
  device_label: string;
  ip: string | null;
  code: string;
  attempts: number;
  created_at: string;
  expires_at: string;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });

/** طلبات الدخول من أجهزة جديدة: الكود يُعطى للموظف بعد التأكد من هويته. */
export function LoginApprovalsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['login-approvals'],
    queryFn: () => apiFetch<PendingLogin[]>('/auth/login-approvals/'),
    refetchInterval: 10_000,
  });
  const reject = useMutation({
    mutationFn: (id: string) => apiFetch<null>(`/auth/login-approvals/${id}/reject/`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['login-approvals'] }),
  });

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">طلبات الدخول من أجهزة جديدة</h2>
        <p className="mt-1 text-sm text-gray-500">
          تأكد أن الشخص هو صاحب الحساب فعلًا (اتصال أو حضوريًا) قبل أن تعطيه الكود. إن لم يكن هو، ارفض الطلب وغيّر كلمة مروره.
        </p>
      </div>
      {isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : error ? (
        <Card className="p-6 text-sm text-red-600">{toUserMessage(error, 'تعذر تحميل الطلبات')}</Card>
      ) : !data?.length ? (
        <EmptyState icon={KeyRound} title="لا طلبات بانتظار كود" />
      ) : (
        <Card className="divide-y divide-gray-100">
          {data.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-4 p-4" data-testid="login-approval">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-gray-900">
                  {r.user.full_name} <span className="text-xs text-gray-500">({r.user.username})</span>
                </p>
                <p className="text-xs text-gray-500">
                  {r.device_label}
                  {r.ip && ` · ${r.ip}`} · {time(r.created_at)} — صالح حتى {time(r.expires_at)}
                  {r.attempts > 0 && ` · محاولات خاطئة: ${r.attempts}`}
                </p>
              </div>
              <span dir="ltr" className="rounded-lg bg-gray-100 px-3 py-1.5 font-mono text-xl tracking-[0.3em] text-gray-900">
                {r.code}
              </span>
              <Button variant="outline" size="sm" loading={reject.isPending && reject.variables === r.id} onClick={() => reject.mutate(r.id)}>
                رفض
              </Button>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
