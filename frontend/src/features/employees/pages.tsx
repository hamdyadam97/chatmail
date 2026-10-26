import { useState } from 'react';
import { externalApi } from '../external/service';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Contact, KeyRound, LogOut, Plus, Search, ShieldOff, UserCheck, UserX, Globe } from 'lucide-react';
import { Button, Card, EmptyState, Input, Label, Spinner } from '../../shared/ui';
import { ApiError, toUserMessage } from '../../shared/api';
import { cn } from '../../shared/lib/cn';
import {
  adminApi,
  EMPLOYMENT_LABELS,
  unitLabel,
  type EmploymentType,
  type ManagedUser,
  type UnitChoice,
} from '../admin/api';
import { Modal, UnitPicker } from '../admin/components';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

/** كلمة المرور المؤقتة تُعرض مرة واحدة ولا تُخزن في أي مكان. */
function TempPassword({ value }: { value: string }) {
  return (
    <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
      <p className="font-medium text-amber-900">كلمة مرور مؤقتة — تُعرض الآن فقط:</p>
      <div className="flex items-center gap-2">
        <code dir="ltr" className="flex-1 rounded bg-white px-2 py-1 font-mono text-base">
          {value}
        </code>
        <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(value)}>
          نسخ
        </Button>
      </div>
      <p className="text-xs text-amber-800">
        سلّمها للموظف بقناة آمنة؛ سيُطلب منه تغييرها عند أول دخول. إعادة كلمة المرور تمنح الدخول فقط ولا تمس مفاتيح التشفير: لقراءة
        مراسلاته يحتاج أحد أجهزته الموثوقة أو مفتاح الاستعادة.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// إنشاء موظف
// ---------------------------------------------------------------------------

function CreateEmployee({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ username: '', first_name: '', last_name: '', phone: '', optional_email: '', job_title: '' });
  const [unit, setUnit] = useState<UnitChoice | null>(null);
  const [employment, setEmployment] = useState<EmploymentType>('full_time');
  const [error, setError] = useState<string | null>(null);
  const [temp, setTemp] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const create = useMutation({
    mutationFn: async () => {
      if (!form.username.trim()) throw new Error('اسم المستخدم مطلوب');
      if (!unit?.institute) throw new Error('حدد جهة العمل');
      const user = await adminApi.createUser({
        username: form.username.trim(),
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        phone: form.phone.trim(),
        optional_email: form.optional_email.trim() || null,
        membership: {
          institute_id: unit.institute,
          branch_id: unit.branch ?? null,
          department_id: unit.department ?? null,
          job_title: form.job_title.trim(),
          employment_type: employment,
        },
      });
      return adminApi.resetPassword(user.id);
    },
    onSuccess: (r) => {
      setTemp(r.temp_password);
      onCreated();
    },
    onError: (err) => setError(err instanceof ApiError ? toUserMessage(err, 'تعذر إنشاء الحساب') : (err as Error).message),
  });

  return (
    <Modal title="موظف جديد" onClose={onClose} wide>
      {temp ? (
        <div className="space-y-4">
          <p className="text-sm text-gray-700">أُنشئ الحساب. لا يحتاج الموظف بريدًا إلكترونيًا.</p>
          <TempPassword value={temp} />
          <div className="flex justify-end">
            <Button onClick={onClose}>تم</Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            create.mutate();
          }}
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <Label htmlFor="u-username">اسم المستخدم</Label>
              <Input id="u-username" dir="ltr" value={form.username} onChange={set('username')} autoComplete="off" />
            </div>
            <div>
              <Label htmlFor="u-phone">الجوال</Label>
              <Input id="u-phone" dir="ltr" value={form.phone} onChange={set('phone')} />
            </div>
            <div>
              <Label htmlFor="u-first">الاسم الأول</Label>
              <Input id="u-first" value={form.first_name} onChange={set('first_name')} />
            </div>
            <div>
              <Label htmlFor="u-last">اسم العائلة</Label>
              <Input id="u-last" value={form.last_name} onChange={set('last_name')} />
            </div>
            <div>
              <Label htmlFor="u-email">بريد إلكتروني (اختياري)</Label>
              <Input id="u-email" dir="ltr" type="email" value={form.optional_email} onChange={set('optional_email')} />
            </div>
            <div>
              <Label htmlFor="u-job">المسمى الوظيفي</Label>
              <Input id="u-job" value={form.job_title} onChange={set('job_title')} />
            </div>
          </div>
          <UnitPicker idPrefix="u-unit" value={unit} onChange={setUnit} />
          <div className="md:w-1/3">
            <Label htmlFor="u-emp">نوع التوظيف</Label>
            <select id="u-emp" value={employment} onChange={(e) => setEmployment(e.target.value as EmploymentType)} className="h-10 w-full rounded-lg border border-gray-300 bg-white px-2 text-sm">
              {(Object.keys(EMPLOYMENT_LABELS) as EmploymentType[]).map((k) => (
                <option key={k} value={k}>
                  {EMPLOYMENT_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              إلغاء
            </Button>
            <Button type="submit" loading={create.isPending}>
              إنشاء الحساب وإصدار كلمة مرور مؤقتة
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// تفاصيل موظف
// ---------------------------------------------------------------------------

/** البريد الخارجي للموظف: العنوان واسم البريد والاستقبال والإرسال (لا يمس أي محتوى). */
function ExternalMailboxSection({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const { data, error } = useQuery({ queryKey: ['admin', 'external-mailbox', userId], queryFn: () => externalApi.mailbox(userId), retry: false });
  const [localPart, setLocalPart] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const update = useMutation({
    mutationFn: (body: Parameters<typeof externalApi.updateMailbox>[1]) => externalApi.updateMailbox(userId, body),
    onSuccess: (mb) => {
      queryClient.setQueryData(['admin', 'external-mailbox', userId], mb);
      setLocalPart(null);
      setMessage({ tone: 'ok', text: 'حُفظ.' });
    },
    onError: (err) => setMessage({ tone: 'err', text: toUserMessage(err, 'تعذر الحفظ') }),
  });
  if (error || !data || !data.receiving_configured) return null;
  return (
    <div className="space-y-3 border-t border-gray-100 pt-4">
      <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
        <Globe className="h-4 w-4" />
        البريد الخارجي
      </h4>
      <p className="text-sm">
        <span className="text-gray-500">العنوان: </span>
        <span dir="ltr" className="font-mono">{data.address ?? '— (اسم المستخدم لا يصلح عنوانًا؛ حدّد اسم بريد)'}</span>
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor="mb-local">اسم البريد (فارغ = اسم المستخدم)</Label>
          <Input
            id="mb-local"
            dir="ltr"
            value={localPart ?? data.local_part ?? ''}
            onChange={(e) => setLocalPart(e.target.value)}
            placeholder="a.alotaibi"
            className="w-56 font-mono"
          />
        </div>
        <Button size="sm" variant="outline" disabled={localPart === null} loading={update.isPending} onClick={() => update.mutate({ local_part: localPart || null })}>
          حفظ الاسم
        </Button>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" className="accent-primary-600" checked={data.receiving_enabled} onChange={(e) => update.mutate({ receiving_enabled: e.target.checked })} />
          يستقبل من الخارج
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="accent-primary-600"
            checked={data.sending_enabled}
            disabled={!data.sending_configured}
            onChange={(e) => update.mutate({ sending_enabled: e.target.checked })}
          />
          يرسل للخارج {!data.sending_configured && <span className="text-xs text-gray-400">(الإرسال غير مُعد على الخادم)</span>}
        </label>
      </div>
      {message && <p className={cn('text-xs', message.tone === 'ok' ? 'text-emerald-700' : 'text-red-600')}>{message.text}</p>}
    </div>
  );
}

function EmployeeDetail({ user, onClose, onChanged }: { user: ManagedUser; onClose: () => void; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const { data: memberships } = useQuery({ queryKey: ['admin', 'memberships', user.id], queryFn: () => adminApi.memberships(user.id) });
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [temp, setTemp] = useState<string | null>(null);
  const [mode, setMode] = useState<'none' | 'add' | 'transfer' | 'deactivate'>('none');
  const [unit, setUnit] = useState<UnitChoice | null>(null);
  const [jobTitle, setJobTitle] = useState('');
  const [reason, setReason] = useState('');

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'memberships', user.id] });
    onChanged();
  };
  const fail = (err: unknown) => setMessage({ tone: 'err', text: toUserMessage(err, 'تعذرت العملية') });

  const action = useMutation({
    mutationFn: async (kind: string) => {
      switch (kind) {
        case 'reset':
          return setTemp((await adminApi.resetPassword(user.id)).temp_password);
        case 'sessions': {
          const r = await adminApi.revokeSessions(user.id);
          return setMessage({ tone: 'ok', text: `أُلغيت ${r.revoked} جلسة دخول. الأجهزة ومفاتيحها لم تُمس.` });
        }
        case 'activate':
          await adminApi.setActive(user.id, true);
          return setMessage({ tone: 'ok', text: 'فُعّل الحساب.' });
        case 'deactivate':
          await adminApi.setActive(user.id, false, reason);
          setMode('none');
          return setMessage({ tone: 'ok', text: 'عُطّل الحساب وأُلغيت جلساته.' });
        case 'add':
          if (!unit) throw new Error('حدد الوحدة');
          await adminApi.addMembership(user.id, { ...unit, job_title: jobTitle });
          setMode('none');
          return setMessage({ tone: 'ok', text: 'أُضيفت عضوية إضافية.' });
        case 'transfer':
          if (!unit) throw new Error('حدد الوحدة');
          await adminApi.transfer(user.id, { ...unit, job_title: jobTitle });
          setMode('none');
          return setMessage({ tone: 'ok', text: 'نُقل الموظف؛ أُنهيت العضوية السابقة اليوم.' });
      }
    },
    onSuccess: refresh,
    onError: fail,
  });
  const membershipOp = useMutation({
    mutationFn: ({ mid, body }: { mid: string; body: { make_primary?: boolean; end?: boolean } }) =>
      adminApi.updateMembership(user.id, mid, body),
    onSuccess: refresh,
    onError: fail,
  });

  return (
    <Modal title={user.full_name || user.username} onClose={onClose} wide>
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-3">
          <p><span className="text-gray-500">المستخدم: </span><span dir="ltr">{user.username}</span></p>
          <p><span className="text-gray-500">الجوال: </span><span dir="ltr">{user.phone || '—'}</span></p>
          <p><span className="text-gray-500">الحالة: </span>{user.is_active ? 'نشط' : `معطّل منذ ${formatDate(user.deactivated_at)}`}</p>
          <p><span className="text-gray-500">آخر دخول: </span>{formatDate(user.last_login_at)}</p>
          <p><span className="text-gray-500">التحقق الثنائي: </span>{user.mfa_enabled ? 'مفعّل' : 'غير مفعّل'}</p>
          <p><span className="text-gray-500">جلسات نشطة: </span>{user.active_sessions ?? '—'}</p>
        </div>
        <p className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
          إدارة الحساب لا تمنح أي اطلاع على مراسلات الموظف أو محادثاته أو مفاتيحه — لا توجد هذه القدرة في النظام.
        </p>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-sm font-semibold text-gray-900">العضويات التنظيمية</h4>
            <span className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setMode(mode === 'add' ? 'none' : 'add')}>
                عضوية إضافية
              </Button>
              <Button size="sm" variant="outline" onClick={() => setMode(mode === 'transfer' ? 'none' : 'transfer')}>
                نقل
              </Button>
            </span>
          </div>
          <ul className="space-y-1.5">
            {(memberships ?? user.memberships).map((m) => (
              <li key={m.id} className={cn('flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm', m.is_current ? 'border-gray-200' : 'border-dashed border-gray-200 text-gray-400')}>
                <span>
                  {unitLabel(m)}
                  {m.job_title && <span className="text-gray-500"> — {m.job_title}</span>}
                  {m.is_primary && <span className="ms-2 rounded-full bg-primary-50 px-2 py-0.5 text-xs text-primary-700">رئيسية</span>}
                  {!m.is_current && <span className="ms-2 text-xs">انتهت {m.ended_on}</span>}
                </span>
                {m.is_current && !m.is_primary && (
                  <span className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => membershipOp.mutate({ mid: m.id, body: { make_primary: true } })}>
                      اجعلها رئيسية
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => membershipOp.mutate({ mid: m.id, body: { end: true } })}>
                      إنهاء
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          {(mode === 'add' || mode === 'transfer') && (
            <div className="mt-3 space-y-3 rounded-lg border border-gray-200 p-3">
              <p className="text-xs text-gray-500">
                {mode === 'add'
                  ? 'عضوية إضافية (موظف يعمل بأكثر من فرع) — تتطلب صلاحية إدارة الهيكل في الوحدة الجديدة.'
                  : 'النقل يُنهي العضوية الرئيسية الحالية اليوم ويفتح عضوية رئيسية جديدة — يتطلب الصلاحية في الوحدتين.'}
              </p>
              <UnitPicker idPrefix={`m-${mode}`} value={unit} onChange={setUnit} />
              <div className="md:w-1/2">
                <Label htmlFor="m-job">المسمى الوظيفي</Label>
                <Input id="m-job" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
              </div>
              <div className="flex justify-end">
                <Button size="sm" loading={action.isPending} onClick={() => action.mutate(mode)}>
                  {mode === 'add' ? 'إضافة' : 'تنفيذ النقل'}
                </Button>
              </div>
            </div>
          )}
        </div>

        <ExternalMailboxSection userId={user.id} />

        <div className="flex flex-wrap gap-2 border-t border-gray-100 pt-4">
          <Button size="sm" variant="outline" onClick={() => action.mutate('reset')} loading={action.isPending && action.variables === 'reset'}>
            <KeyRound className="h-4 w-4" />
            إصدار كلمة مرور مؤقتة
          </Button>
          <Button size="sm" variant="outline" onClick={() => action.mutate('sessions')}>
            <LogOut className="h-4 w-4" />
            تسجيل خروجه من كل الجلسات
          </Button>
          {user.is_active ? (
            <Button size="sm" variant="danger" onClick={() => setMode(mode === 'deactivate' ? 'none' : 'deactivate')}>
              <UserX className="h-4 w-4" />
              تعطيل الحساب
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => action.mutate('activate')}>
              <UserCheck className="h-4 w-4" />
              إعادة التفعيل
            </Button>
          )}
        </div>
        {mode === 'deactivate' && (
          <div className="space-y-2 rounded-lg border border-red-200 bg-red-50/50 p-3">
            <Label htmlFor="d-reason">سبب التعطيل</Label>
            <Input id="d-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            <p className="text-xs text-gray-600">
              يمنع الدخول ويلغي الجلسات. لا تُنقل مفاتيحه أو رسائله لأحد؛ يُنصح الموظف (أو مسؤول الأمن مع الموظف) بإبطال أجهزته من
              صفحة الأجهزة عند المغادرة.
            </p>
            <div className="flex justify-end">
              <Button size="sm" variant="danger" onClick={() => action.mutate('deactivate')}>
                <ShieldOff className="h-4 w-4" />
                تأكيد التعطيل
              </Button>
            </div>
          </div>
        )}
        {temp && <TempPassword value={temp} />}
        {message && <p className={cn('text-sm', message.tone === 'ok' ? 'text-emerald-700' : 'text-red-600')}>{message.text}</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// القائمة
// ---------------------------------------------------------------------------

export function Employees() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('active');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<ManagedUser | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'managed', query, status, page],
    queryFn: () => adminApi.managed({ q: query, status, page }),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'managed'] });

  if (error instanceof ApiError && error.status === 403) {
    return (
      <EmptyState
        icon={Contact}
        title="إدارة الموظفين تتطلب صلاحية accounts.manage_users"
        description="يمكنك تصفح دليل الزملاء من اختيار المستلمين عند إنشاء مراسلة."
        className="mx-auto mt-8 max-w-lg"
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-gray-900">الموظفون</h2>
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          موظف جديد
        </Button>
      </div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQuery(q.trim());
        }}
      >
        <div className="relative min-w-[16rem] flex-1">
          <Search className="pointer-events-none absolute start-3 top-3 h-4 w-4 text-gray-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="الاسم أو اسم المستخدم أو الجوال" className="ps-9" aria-label="بحث" />
        </div>
        <select value={status} onChange={(e) => { setStatus(e.target.value as typeof status); setPage(1); }} className="h-10 rounded-lg border border-gray-300 bg-white px-2 text-sm" aria-label="الحالة">
          <option value="active">النشطون</option>
          <option value="inactive">المعطّلون</option>
          <option value="all">الكل</option>
        </select>
        <Button type="submit" variant="outline">
          بحث
        </Button>
      </form>
      {isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : error ? (
        <Card className="p-6 text-sm text-red-600">{toUserMessage(error)}</Card>
      ) : !data?.results.length ? (
        <EmptyState icon={Contact} title="لا موظفين" />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2 text-start font-medium">الاسم</th>
                <th className="px-4 py-2 text-start font-medium">جهة العمل الرئيسية</th>
                <th className="px-4 py-2 text-start font-medium">آخر دخول</th>
                <th className="px-4 py-2 text-start font-medium">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {data.results.map((u) => {
                const primary = u.memberships.find((m) => m.is_primary);
                return (
                  <tr key={u.id} onClick={() => setSelected(u)} className="cursor-pointer border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-2">
                      <div className="font-medium text-gray-900">{u.full_name || u.username}</div>
                      <div className="text-xs text-gray-500" dir="ltr">{u.username}</div>
                    </td>
                    <td className="px-4 py-2 text-gray-700">
                      {primary ? unitLabel(primary) : '—'}
                      {u.memberships.filter((m) => m.is_current).length > 1 && <span className="ms-1 text-xs text-gray-400">(+ عضويات أخرى)</span>}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500">{formatDate(u.last_login_at)}</td>
                    <td className="px-4 py-2">
                      <span className={cn('rounded-full px-2 py-0.5 text-xs', u.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500')}>
                        {u.is_active ? (u.must_change_password ? 'بانتظار تغيير كلمة المرور' : 'نشط') : 'معطّل'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-gray-100 px-4 py-2 text-xs text-gray-500">
            <span>{data.count} موظف</span>
            <span className="flex gap-2">
              <Button size="sm" variant="outline" disabled={!data.previous} onClick={() => setPage((p) => p - 1)}>
                السابق
              </Button>
              <Button size="sm" variant="outline" disabled={!data.next} onClick={() => setPage((p) => p + 1)}>
                التالي
              </Button>
            </span>
          </div>
        </Card>
      )}
      {creating && <CreateEmployee onClose={() => setCreating(false)} onCreated={refresh} />}
      {selected && (
        <EmployeeDetail
          key={selected.id}
          user={selected}
          onClose={() => setSelected(null)}
          onChanged={() => {
            void refresh();
          }}
        />
      )}
    </div>
  );
}

export const EmployeesPages = { Employees };
