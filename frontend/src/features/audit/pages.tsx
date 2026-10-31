import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ScrollText, ShieldAlert } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Input, Label, Spinner } from '../../shared/ui';
import { ApiError, toUserMessage } from '../../shared/api';
import { cn } from '../../shared/lib/cn';
import { ACTION_LABELS, auditApi, type AuditFilters, type AuditRow } from './api';

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('ar', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(iso));
}

const label = (action: string) => ACTION_LABELS[action] ?? action;

/** أحداث أمان حسابي — تُعرض في صفحة الأمان لكل مستخدم. */
export function MySecurityEvents() {
  const { data, isLoading } = useQuery({ queryKey: ['audit', 'mine'], queryFn: auditApi.mine });
  return (
    <Card>
      <CardHeader>
        <CardTitle>نشاط الأمان في حسابي</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-sm text-gray-500">
          آخر عمليات الدخول وتغييرات الأمان على حسابك. إن رأيت ما لا تعرفه فغيّر كلمة المرور فورًا وأبلغ مسؤول النظام.
        </p>
        {isLoading ? (
          <Spinner />
        ) : !data?.length ? (
          <p className="text-sm text-gray-400">لا أحداث</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {data.slice(0, 30).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className={cn(['login_failed', 'mfa_verify_failed', 'password_reset'].includes(r.action) && 'text-amber-700')}>
                  {label(r.action)}
                </span>
                <span className="text-xs text-gray-500" dir="ltr">
                  {r.ip ?? ''} · {formatDate(r.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ r }: { r: AuditRow }) {
  const [open, setOpen] = useState(false);
  const denied = r.action === 'unauthorized_access_denied';
  return (
    <>
      <tr
        className={cn('cursor-pointer border-t border-gray-100 hover:bg-gray-50', denied && 'bg-red-50/40')}
        onClick={() => setOpen((v) => !v)}
      >
        <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-500" dir="ltr">{formatDate(r.created_at)}</td>
        <td className="px-3 py-2">
          <span className="flex items-center gap-1.5">
            {denied && <ShieldAlert className="h-3.5 w-3.5 text-red-600" />}
            {label(r.action)}
          </span>
        </td>
        <td className="px-3 py-2">{r.actor ? `${r.actor.full_name} (${r.actor.username})` : '—'}</td>
        <td className="px-3 py-2 text-xs text-gray-600">{r.target_type || '—'}</td>
        <td className="px-3 py-2 text-xs text-gray-500" dir="ltr">{r.ip ?? '—'}</td>
      </tr>
      {open && (
        <tr className="bg-gray-50">
          <td colSpan={5} className="px-3 py-2">
            <pre dir="ltr" className="overflow-x-auto whitespace-pre-wrap text-xs text-gray-700">
              {JSON.stringify(
                { id: r.id, target_id: r.target_id, actor_device_id: r.actor_device_id, org_scope: r.org_scope, user_agent: r.user_agent, metadata: r.metadata },
                null,
                2,
              )}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

export function AuditLogs() {
  const [draft, setDraft] = useState<AuditFilters>({});
  const [filters, setFilters] = useState<AuditFilters>({ page: 1 });
  const { data, isLoading, error } = useQuery({
    queryKey: ['audit', 'list', filters],
    queryFn: () => auditApi.list(filters),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const forbidden = error instanceof ApiError && error.status === 403;
  const { data: actions } = useQuery({ queryKey: ['audit', 'actions'], queryFn: auditApi.actions, enabled: !forbidden, retry: false });

  if (forbidden) {
    return (
      <EmptyState
        icon={ScrollText}
        title="سجل التدقيق متاح لمراقب الأمن المعلن فقط"
        description="يمكنك مراجعة نشاط حسابك من صفحة الأمان."
        className="mx-auto mt-8 max-w-lg"
      />
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">سجل التدقيق</h2>
        <p className="text-xs text-gray-500">
          سجل إلحاقي لا يُعدَّل ولا يُحذف. يحوي معرّفات وأعدادًا فقط — لا كلمات مرور ولا مفاتيح ولا محتوى. كل اطلاع على هذا السجل
          يُسجَّل فيه أيضًا.
        </p>
      </div>
      <Card className="p-4">
        <form
          className="grid grid-cols-2 gap-3 md:grid-cols-6"
          onSubmit={(e) => {
            e.preventDefault();
            setFilters({ ...draft, page: 1 });
          }}
        >
          <div className="col-span-2">
            <Label htmlFor="f-action">الحدث</Label>
            <select
              id="f-action"
              value={draft.action ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, action: e.target.value || undefined }))}
              className="h-10 w-full rounded-lg border border-gray-300 bg-white px-2 text-sm"
            >
              <option value="">الكل</option>
              {(actions ?? []).map((a) => (
                <option key={a} value={a}>
                  {label(a)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="f-actor">اسم المستخدم</Label>
            <Input id="f-actor" dir="ltr" value={draft.actor ?? ''} onChange={(e) => setDraft((d) => ({ ...d, actor: e.target.value || undefined }))} />
          </div>
          <div>
            <Label htmlFor="f-from">من</Label>
            <Input id="f-from" type="date" value={draft.from ?? ''} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value || undefined }))} />
          </div>
          <div>
            <Label htmlFor="f-to">إلى</Label>
            <Input id="f-to" type="date" value={draft.to ?? ''} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value || undefined }))} />
          </div>
          <div className="flex items-end">
            <Button type="submit" className="w-full">
              تصفية
            </Button>
          </div>
        </form>
      </Card>
      {isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : error ? (
        <Card className="p-6 text-sm text-red-600">{toUserMessage(error)}</Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 text-start font-medium">الوقت</th>
                <th className="px-3 py-2 text-start font-medium">الحدث</th>
                <th className="px-3 py-2 text-start font-medium">المنفّذ</th>
                <th className="px-3 py-2 text-start font-medium">الهدف</th>
                <th className="px-3 py-2 text-start font-medium">IP</th>
              </tr>
            </thead>
            <tbody>
              {data?.results.map((r) => <Row key={r.id} r={r} />)}
            </tbody>
          </table>
          {data && (
            <div className="flex items-center justify-between border-t border-gray-100 px-3 py-2 text-xs text-gray-500">
              <span>{data.count} حدث</span>
              <span className="flex gap-2">
                <Button variant="outline" size="sm" disabled={!data.previous} onClick={() => setFilters((f) => ({ ...f, page: (f.page ?? 1) - 1 }))}>
                  السابق
                </Button>
                <Button variant="outline" size="sm" disabled={!data.next} onClick={() => setFilters((f) => ({ ...f, page: (f.page ?? 1) + 1 }))}>
                  التالي
                </Button>
              </span>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

export const AuditPages = { AuditLogs };
