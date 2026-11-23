import { useState } from 'react';
import { externalApi } from '../external/service';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Contact, Download, FileSpreadsheet, FileText, KeyRound, LogOut, Plus, Search, ShieldOff, Trash2, UserCheck, UserX, Globe } from 'lucide-react';
import { Button, Card, EmptyState, Input, Label, Spinner } from '../../shared/ui';
import { ApiError, toUserMessage } from '../../shared/api';
import { cn } from '../../shared/lib/cn';
import { saveBlob } from '../../shared/lib/download';
import {
  adminApi,
  EMPLOYMENT_LABELS,
  unitLabel,
  type EmploymentType,
  type ManagedUser,
  type UnitChoice,
} from '../admin/api';
import { Modal, UnitPicker, useOrg } from '../admin/components';
import { useAuth } from '../auth/AuthContext';
import { announcementsApi } from '../announcements/api';
import { ImportEmployees } from './ImportEmployees';

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
        سلّمها للموظف بنفسه وبقناة آمنة؛ سيُطلب منه تغييرها عند أول دخول. من يعرفها يدخل الحساب ويقرأ بريده، لذلك تُسجَّل كل
        إعادة تعيين في سجل التدقيق.
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
      // الخادم يعيد الكلمة المؤقتة الموحدة إن كانت مضبوطة، وإلا نُصدر واحدة عشوائية.
      if (user.temp_password) return { temp_password: user.temp_password };
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

/** الاسم الأول + اسم العائلة = الاسم الذي يراه الجميع (مع الفرع). */
function NameEditor({ user, onSaved, onError }: { user: ManagedUser; onSaved: () => void; onError: (e: unknown) => void }) {
  const [first, setFirst] = useState(user.first_name || '');
  const [last, setLast] = useState(user.last_name || '');
  const changed = first.trim() !== (user.first_name || '') || last.trim() !== (user.last_name || '');
  const save = useMutation({
    mutationFn: () => adminApi.rename(user.id, first.trim(), last.trim()),
    onSuccess: onSaved,
    onError,
  });
  const preview = [first.trim(), last.trim()].filter(Boolean).join(' ');
  return (
    <form
      className="grid grid-cols-1 items-end gap-3 rounded-lg border border-gray-200 p-3 md:grid-cols-[1fr_1fr_auto]"
      onSubmit={(e) => {
        e.preventDefault();
        if (first.trim()) save.mutate();
      }}
    >
      <div>
        <Label htmlFor="edit-first">الاسم الأول</Label>
        <Input id="edit-first" value={first} onChange={(e) => setFirst(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="edit-last">اسم العائلة</Label>
        <Input id="edit-last" value={last} onChange={(e) => setLast(e.target.value)} />
      </div>
      <Button type="submit" size="sm" disabled={!changed || !first.trim()} loading={save.isPending}>
        حفظ الاسم
      </Button>
      <p className="text-xs text-gray-500 md:col-span-3">
        يظهر للناس: <strong className="text-gray-800">{preview || user.username}</strong>
      </p>
    </form>
  );
}

function EmployeeDetail({ user, onClose, onChanged }: { user: ManagedUser; onClose: () => void; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const { data: memberships } = useQuery({ queryKey: ['admin', 'memberships', user.id], queryFn: () => adminApi.memberships(user.id) });
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [temp, setTemp] = useState<string | null>(null);
  const [mode, setMode] = useState<'none' | 'add' | 'transfer' | 'deactivate' | 'delete'>('none');
  const [unit, setUnit] = useState<UnitChoice | null>(null);
  const [jobTitle, setJobTitle] = useState('');
  const [reason, setReason] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const { user: me } = useAuth();

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'memberships', user.id] });
    onChanged();
  };
  const fail = (err: unknown) =>
    setMessage({ tone: 'err', text: err instanceof ApiError ? toUserMessage(err, 'تعذرت العملية') : (err as Error).message });

  const action = useMutation({
    mutationFn: async (kind: string) => {
      switch (kind) {
        case 'reset':
          return setTemp((await adminApi.resetPassword(user.id)).temp_password);
        case 'sessions': {
          const r = await adminApi.revokeSessions(user.id);
          return setMessage({ tone: 'ok', text: `أُلغيت ${r.revoked} جلسة دخول — سيُطلب منه الدخول من جديد على كل أجهزته.` });
        }
        case 'activate':
          await adminApi.setActive(user.id, true);
          return setMessage({ tone: 'ok', text: 'أُرجع الموظف من الأرشيف — يدخل ويستقبل من جديد.' });
        case 'deactivate':
          await adminApi.setActive(user.id, false, reason);
          setMode('none');
          return setMessage({ tone: 'ok', text: 'أُرشف الموظف: لا يدخل ولا يُراسَل، ورسائله السابقة باقية.' });
        case 'delete': {
          if (confirmName.trim() !== user.username) throw new Error('اكتب اسم المستخدم كما هو للتأكيد');
          // حساب لم يُستخدم يُحذف كله؛ المستخدم يُحذف بالكامل وتبقى رسائله عند مستلميها باسم «موظف محذوف».
          const unused = !user.last_login_at && (await adminApi.deleteUser(user.id).then(() => true).catch(() => false));
          if (!unused) await adminApi.purgeUser(user.id, confirmName.trim());
          onChanged();
          return onClose();
        }
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
          <p><span className="text-gray-500">الحالة: </span>{user.is_active ? 'نشط' : `مؤرشف منذ ${formatDate(user.deactivated_at)}`}</p>
          <p><span className="text-gray-500">آخر دخول: </span>{formatDate(user.last_login_at)}</p>
          <p><span className="text-gray-500">التحقق الثنائي: </span>{user.mfa_enabled ? 'مفعّل' : 'غير مفعّل'}</p>
          <p><span className="text-gray-500">جلسات نشطة: </span>{user.active_sessions ?? '—'}</p>
        </div>
        <NameEditor
          user={user}
          onSaved={() => {
            setMessage({ tone: 'ok', text: 'حُفظ الاسم — يظهر للجميع بهذا الشكل مع فرعه.' });
            refresh();
            void queryClient.invalidateQueries({ queryKey: ['directory-users'] });
          }}
          onError={fail}
        />
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
                  {m.is_current && m.ended_on && (
                    <span className="ms-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
                      {m.ended_on === new Date().toLocaleDateString('en-CA') ? 'تنتهي اليوم' : `تنتهي ${m.ended_on}`}
                    </span>
                  )}
                </span>
                {m.is_current && !m.is_primary && (
                  <span className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      title={m.ended_on ? 'تُعاد سارية وتصبح الرئيسية (للتراجع عن نقل اليوم)' : undefined}
                      onClick={() => membershipOp.mutate({ mid: m.id, body: { make_primary: true } })}
                    >
                      {m.ended_on ? 'إرجاعها رئيسية' : 'اجعلها رئيسية'}
                    </Button>
                    {!m.ended_on && (
                      <Button size="sm" variant="ghost" onClick={() => membershipOp.mutate({ mid: m.id, body: { end: true } })}>
                        إنهاء
                      </Button>
                    )}
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
              أرشفة الموظف
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => action.mutate('activate')}>
              <UserCheck className="h-4 w-4" />
              إرجاع من الأرشيف
            </Button>
          )}
          {(me?.show_admin || !user.last_login_at) && String(me?.id) !== user.id && (
            <Button size="sm" variant="danger" onClick={() => setMode(mode === 'delete' ? 'none' : 'delete')}>
              <Trash2 className="h-4 w-4" />
              حذف نهائي
            </Button>
          )}
        </div>
        {mode === 'delete' && (
          <div className="space-y-2 rounded-lg border border-red-300 bg-red-50 p-3" data-testid="purge-box">
            <p className="text-sm font-medium text-red-800">
              حذف <span dir="ltr" className="font-mono">{user.username}</span> نهائيًا — لا يمكن التراجع عنه.
            </p>
            <ul className="list-disc space-y-0.5 ps-5 text-xs text-gray-700">
              <li>يُحذف حسابه وبياناته وأدواره وبريده الخارجي ومسوداته ودفتر عناوينه، ويخرج من المحادثات الجماعية.</li>
              <li>ما أرسله لزملائه يبقى في بريدهم باسم «موظف محذوف»، وسجل التدقيق لا يُمس.</li>
              <li>لإيقافه مع الاحتفاظ بكل شيء استخدم «أرشفة الموظف» بدلًا من ذلك.</li>
            </ul>
            <Label htmlFor="purge-confirm">
              للتأكيد اكتب اسم المستخدم: <span dir="ltr" className="font-mono">{user.username}</span>
            </Label>
            <Input id="purge-confirm" dir="ltr" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" />
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="danger"
                disabled={confirmName.trim() !== user.username}
                loading={action.isPending && action.variables === 'delete'}
                onClick={() => action.mutate('delete')}
              >
                <Trash2 className="h-4 w-4" />
                تأكيد الحذف النهائي
              </Button>
            </div>
          </div>
        )}
        {mode === 'deactivate' && (
          <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
            <Label htmlFor="d-reason">سبب الأرشفة</Label>
            <Input id="d-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            <p className="text-xs text-gray-600">
              لا يدخل النظام، ولا يظهر للموظفين ولا يُراسَل، وبريده الخارجي يتوقف. رسائله السابقة تبقى كما هي، ويبقى ظاهرًا لك في
              «المؤرشفون» وتستطيع إرجاعه.
            </p>
            <div className="flex justify-end">
              <Button size="sm" variant="danger" onClick={() => action.mutate('deactivate')}>
                <ShieldOff className="h-4 w-4" />
                تأكيد الأرشفة
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

/** حساب لم يُستخدم يُحذف صفه كله، وإلا الحذف النهائي (يبقى ما أرسله باسم «موظف محذوف»). */
async function deleteEmployee(user: ManagedUser) {
  const unused = !user.last_login_at && (await adminApi.deleteUser(user.id).then(() => true).catch(() => false));
  if (!unused) await adminApi.purgeUser(user.id, user.username);
}

/** حذف عدة موظفين محددين — واحدًا واحدًا بنفس الطلبات، وما يفشل يُعرض سببه. */
function BulkDelete({ users, onClose, onDone }: { users: ManagedUser[]; onClose: () => void; onDone: (deleted: string[]) => void }) {
  const [done, setDone] = useState(0);
  const [failures, setFailures] = useState<{ user: ManagedUser; reason: string }[]>([]);
  const used = users.filter((u) => u.last_login_at).length;
  const run = useMutation({
    mutationFn: async () => {
      const deleted: string[] = [];
      const failed: { user: ManagedUser; reason: string }[] = [];
      for (const u of users) {
        try {
          await deleteEmployee(u);
          deleted.push(u.id);
        } catch (err) {
          failed.push({ user: u, reason: toUserMessage(err, 'تعذر الحذف') });
        }
        setDone((n) => n + 1);
      }
      setFailures(failed);
      onDone(deleted);
      if (!failed.length) onClose();
    },
  });
  return (
    <Modal title="حذف المحددين نهائيًا" onClose={run.isPending ? () => undefined : onClose}>
      <div className="space-y-3" data-testid="bulk-delete">
        <p className="text-sm text-gray-800">
          حذف <span className="font-semibold">{users.length}</span> موظف نهائيًا؟ لا يمكن التراجع عنه.
        </p>
        <ul className="max-h-48 overflow-y-auto rounded-lg border border-gray-200 p-2 text-sm">
          {users.map((u) => (
            <li key={u.id} className="flex justify-between gap-2 py-0.5">
              <span>{u.full_name || u.username}</span>
              <span dir="ltr" className="font-mono text-xs text-gray-500">{u.username}</span>
            </li>
          ))}
        </ul>
        {used > 0 && (
          <p className="text-xs text-gray-600">
            {used} منهم دخل النظام من قبل: ما أرسلوه لزملائهم يبقى عندهم باسم «موظف محذوف».
          </p>
        )}
        {run.isPending && <p className="text-xs text-gray-500">جارٍ الحذف… {done} / {users.length}</p>}
        {failures.length > 0 && (
          <div className="space-y-1 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700">
            <p className="font-medium">لم يُحذف {failures.length}:</p>
            {failures.map((f) => (
              <p key={f.user.id}>
                <span dir="ltr" className="font-mono">{f.user.username}</span> — {f.reason}
              </p>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onClose} disabled={run.isPending}>
            {failures.length ? 'إغلاق' : 'إلغاء'}
          </Button>
          {!failures.length && (
            <Button size="sm" variant="danger" loading={run.isPending} onClick={() => run.mutate()}>
              <Trash2 className="h-4 w-4" />
              حذف {users.length} نهائيًا
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** حذف نهائي مباشر من القائمة (أيقونة الصف) — نفس منطق «حذف نهائي» في تفاصيل الموظف. */
function QuickDelete({ user, onClose, onDone }: { user: ManagedUser; onClose: () => void; onDone: () => void }) {
  const remove = useMutation({
    mutationFn: () => deleteEmployee(user),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Modal title="حذف نهائي" onClose={onClose}>
      <div className="space-y-3" data-testid="quick-delete">
        <p className="text-sm text-gray-800">
          حذف <span className="font-semibold">{user.full_name || user.username}</span>{' '}
          (<span dir="ltr" className="font-mono">{user.username}</span>) نهائيًا؟ لا يمكن التراجع عنه.
        </p>
        <p className="text-xs text-gray-600">
          {user.last_login_at
            ? 'دخل النظام من قبل: يُحذف حسابه وبياناته، وما أرسله لزملائه يبقى عندهم باسم «موظف محذوف». لإيقافه مع الاحتفاظ بكل شيء استخدم «أرشفة الموظف» من تفاصيله.'
            : 'لم يدخل النظام قط: يُحذف حسابه بالكامل.'}
        </p>
        {remove.error && <p className="text-sm text-red-600">{toUserMessage(remove.error, 'تعذر الحذف')}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button size="sm" variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
            <Trash2 className="h-4 w-4" />
            حذف نهائي
          </Button>
        </div>
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
  const [branch, setBranch] = useState('');
  const [login, setLogin] = useState<'' | 'never' | 'must_change' | 'done'>('');
  const [announcement, setAnnouncement] = useState('');
  const [ack, setAck] = useState<'' | 'yes' | 'no' | 'read' | 'unread'>('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<ManagedUser | null>(null);
  const [deleting, setDeleting] = useState<ManagedUser | null>(null);
  const [checked, setChecked] = useState<Map<string, ManagedUser>>(new Map());
  const [bulk, setBulk] = useState(false);
  const { user: me } = useAuth();
  const canDelete = (u: ManagedUser) => (me?.show_admin || !u.last_login_at) && String(me?.id) !== u.id;
  const toggle = (u: ManagedUser, on: boolean) =>
    setChecked((prev) => {
      const next = new Map(prev);
      if (on) next.set(u.id, u);
      else next.delete(u.id);
      return next;
    });
  const org = useOrg();
  const filters = { q: query, status, branch, login, announcement, ack: announcement ? ack : ('' as const) };
  // فلتر التعميم لمن يتابع اطلاع التعاميم فقط (نفس صلاحية تقرير الالتزام).
  const { data: annTargets } = useQuery({ queryKey: ['announcements', 'targets'], queryFn: announcementsApi.targets });
  const { data: annOptions } = useQuery({
    queryKey: ['announcements', 'tracking-options'],
    queryFn: announcementsApi.trackingOptions,
    enabled: !!annTargets?.can_track,
  });
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'managed', filters, page],
    queryFn: () => adminApi.managed({ ...filters, page }),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'managed'] });
  const exporting = useMutation({
    mutationFn: () => adminApi.exportManaged(filters),
    onSuccess: (blob) => saveBlob(blob, `الموظفون-${new Date().toISOString().slice(0, 10)}.xlsx`),
  });
  const exportingPdf = useMutation({
    mutationFn: () => adminApi.exportManagedPdf(filters),
    onSuccess: (blob) => saveBlob(blob, `الموظفون-${new Date().toISOString().slice(0, 10)}.pdf`),
  });

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
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setImporting(true)}>
            <FileSpreadsheet className="h-4 w-4" />
            استيراد من Excel
          </Button>
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            موظف جديد
          </Button>
        </div>
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
          <option value="inactive">المؤرشفون</option>
          <option value="all">الكل</option>
        </select>
        <select value={branch} onChange={(e) => { setBranch(e.target.value); setPage(1); }} className="h-10 max-w-[16rem] rounded-lg border border-gray-300 bg-white px-2 text-sm" aria-label="الفرع">
          <option value="">كل الفروع</option>
          <option value="none">بلا فرع</option>
          {org.institutes.map((inst) => {
            const list = org.branches.filter((b) => b.institute === inst.id);
            return list.length ? (
              <optgroup key={inst.id} label={inst.name}>
                {list.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </optgroup>
            ) : null;
          })}
        </select>
        <select
          value={login}
          onChange={(e) => { setLogin(e.target.value as typeof login); setPage(1); }}
          className="h-10 rounded-lg border border-gray-300 bg-white px-2 text-sm"
          aria-label="الدخول"
        >
          <option value="">كل حالات الدخول</option>
          <option value="never">لم يدخل بعد</option>
          <option value="must_change">لم يغيّر كلمة المرور المؤقتة</option>
          <option value="done">دخل وغيّر كلمة المرور</option>
        </select>
        {annTargets?.can_track && (
          <>
            <select
              value={announcement}
              onChange={(e) => { setAnnouncement(e.target.value); setPage(1); }}
              className="h-10 max-w-[20rem] rounded-lg border border-gray-300 bg-white px-2 text-sm"
              aria-label="التعميم"
            >
              <option value="">كل الموظفين (بلا تعميم)</option>
              {(annOptions?.results ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {[a.reference_number, a.content?.title, a.publisher.full_name, formatDate(a.published_at)].filter(Boolean).join(' — ')}
                </option>
              ))}
            </select>
            {announcement && (
              <select
                value={ack}
                onChange={(e) => { setAck(e.target.value as typeof ack); setPage(1); }}
                className="h-10 rounded-lg border border-gray-300 bg-white px-2 text-sm"
                aria-label="حالة التعميم"
              >
                <option value="">كل المستلمين</option>
                <option value="yes">أقرّوا</option>
                <option value="no">لم يقرّوا</option>
                <option value="read">اطّلعوا</option>
                <option value="unread">لم يطّلعوا</option>
              </select>
            )}
          </>
        )}
        <Button type="submit" variant="outline">
          بحث
        </Button>
        <Button
          type="button"
          variant="outline"
          loading={exporting.isPending}
          onClick={() => exporting.mutate()}
          title="تصدير القائمة المعروضة (بنفس الفلاتر) إلى Excel"
        >
          <Download className="h-4 w-4" />
          تصدير Excel
        </Button>
        <Button
          type="button"
          variant="outline"
          loading={exportingPdf.isPending}
          onClick={() => exportingPdf.mutate()}
          title="PDF للطباعة: الاسم وجهة العمل والحالة (وحالة التعميم المختار)"
        >
          <FileText className="h-4 w-4" />
          تصدير PDF
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
          {checked.size > 0 && (
            <div className="flex flex-wrap items-center gap-3 border-b border-red-100 bg-red-50/60 px-4 py-2 text-sm" data-testid="bulk-bar">
              <span className="font-medium text-gray-800">محدد: {checked.size}</span>
              <Button size="sm" variant="danger" onClick={() => setBulk(true)}>
                <Trash2 className="h-4 w-4" />
                حذف المحددين
              </Button>
              <button type="button" className="text-xs text-gray-500 hover:underline" onClick={() => setChecked(new Map())}>
                إلغاء التحديد
              </button>
            </div>
          )}
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="w-10 px-2 py-2">
                  {(() => {
                    const pageDeletable = data.results.filter(canDelete);
                    const all = pageDeletable.length > 0 && pageDeletable.every((u) => checked.has(u.id));
                    return (
                      <input
                        type="checkbox"
                        aria-label="تحديد كل الصفحة"
                        disabled={!pageDeletable.length}
                        checked={all}
                        onChange={(e) => pageDeletable.forEach((u) => toggle(u, e.target.checked))}
                        className="h-4 w-4 accent-red-600"
                      />
                    );
                  })()}
                </th>
                <th className="px-4 py-2 text-start font-medium">الاسم</th>
                <th className="px-4 py-2 text-start font-medium">جهة العمل الرئيسية</th>
                <th className="px-4 py-2 text-start font-medium">آخر دخول</th>
                <th className="px-4 py-2 text-start font-medium">الحالة</th>
                {announcement && <th className="px-4 py-2 text-start font-medium">التعميم</th>}
                <th className="w-10 px-2 py-2"><span className="sr-only">حذف</span></th>
              </tr>
            </thead>
            <tbody>
              {data.results.map((u) => {
                const primary = u.memberships.find((m) => m.is_primary);
                return (
                  <tr key={u.id} onClick={() => setSelected(u)} className={cn('cursor-pointer border-t border-gray-100 hover:bg-gray-50', checked.has(u.id) && 'bg-red-50/40')}>
                    <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                      {canDelete(u) && (
                        <input
                          type="checkbox"
                          aria-label={`تحديد ${u.username}`}
                          data-testid="row-check"
                          checked={checked.has(u.id)}
                          onChange={(e) => toggle(u, e.target.checked)}
                          className="h-4 w-4 accent-red-600"
                        />
                      )}
                    </td>
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
                        {u.is_active ? (u.must_change_password ? 'بانتظار تغيير كلمة المرور' : 'نشط') : 'مؤرشف'}
                      </span>
                    </td>
                    {announcement && (
                      <td className="px-4 py-2 text-xs" data-testid="announcement-state">
                        {u.announcement_state?.acknowledged_at ? (
                          <span className="text-emerald-700">أقر ✓ {formatDate(u.announcement_state.acknowledged_at)}</span>
                        ) : u.announcement_state?.read_at ? (
                          <span className="text-amber-700">اطّلع ولم يقر</span>
                        ) : (
                          <span className="text-red-600">لم يطّلع</span>
                        )}
                      </td>
                    )}
                    <td className="px-2 py-2">
                      {canDelete(u) && (
                        <button
                          type="button"
                          title="حذف نهائي"
                          aria-label={`حذف ${u.username} نهائيًا`}
                          data-testid="row-delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleting(u);
                          }}
                          className="rounded-md p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
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
      {importing && <ImportEmployees onClose={() => setImporting(false)} onDone={refresh} />}
      {bulk && (
        <BulkDelete
          users={[...checked.values()]}
          onClose={() => setBulk(false)}
          onDone={(deleted) => {
            setChecked((prev) => {
              const next = new Map(prev);
              deleted.forEach((id) => next.delete(id));
              return next;
            });
            void refresh();
          }}
        />
      )}
      {deleting && <QuickDelete user={deleting} onClose={() => setDeleting(null)} onDone={() => void refresh()} />}
      {selected && (
        <EmployeeDetail
          key={selected.id}
          user={data?.results.find((u) => u.id === selected.id) ?? selected}
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
