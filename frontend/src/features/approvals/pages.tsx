import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, CheckCheck, Clock, Download, FilePlus2, FileSignature, Lock, PenLine, RotateCcw } from 'lucide-react';
import { Button, Card, EmptyState, Input, Label, Spinner } from '../../shared/ui';
import { cn } from '../../shared/lib/cn';
import { toUserMessage } from '../../shared/api';
import { useAuth } from '../auth/AuthContext';
import { correspondenceApi } from '../correspondence/api';
import { RecipientPicker } from '../correspondence/components';
import { approvalsApi, DECISION_LABELS, type ApprovalRequest, type Decision, type FileRef } from './api';
import { SignatureManager } from './SignaturePad';
import { SignPlacer, type Placement } from './SignPlacer';
import { saveBlob } from '../../shared/lib/download';
import { NoteBanner, StatusBadge, StepsView, Timeline, formatDate } from './components';

type Tab = 'pending_mine' | 'received' | 'requested_by_me' | 'delegations';

function RequestRow({ r, disabled = false }: { r: ApprovalRequest; disabled?: boolean }) {
  const body = <RowBody r={r} />;
  // طلب أُلغي وكان بانتظاري: يبقى ظاهرًا للعلم، ولا يُفتح.
  if (disabled) {
    return (
      <div
        aria-disabled="true"
        title="أُلغي هذا الطلب — لا يمكن اعتماده"
        data-testid="cancelled-request-row"
        className="flex cursor-not-allowed select-none items-center gap-3 border-b border-gray-100 bg-gray-50/70 px-4 py-3 text-sm text-gray-400 opacity-70 last:border-0"
      >
        {body}
      </div>
    );
  }
  return (
    <Link
      to={`/approvals/${r.id}`}
      className="flex items-center gap-3 border-b border-gray-100 px-4 py-3 text-sm last:border-0 hover:bg-gray-50"
    >
      {body}
    </Link>
  );
}

function RowBody({ r }: { r: ApprovalRequest }) {
  return (
    <>
      <span dir="ltr" className="w-48 shrink-0 font-mono text-xs text-gray-600">
        {r.correspondence.reference_number}
      </span>
      <span className="min-w-0 flex-1 text-gray-800">
        {r.signable && (
          <span className="me-2 inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700">
            <PenLine className="h-3 w-3" />
            {r.workflow_name}
          </span>
        )}
        {r.signable && r.title ? <span className="font-medium">{r.title.replace(`${r.workflow_name}: `, '')} — </span> : null}
        مقدّم الطلب: {r.requested_by.full_name}
      </span>
      <span className="text-xs text-gray-500">
        الخطوة {r.current_step_order}/{r.steps.length}
      </span>
      {r.my_slot?.delegated && <span className="text-xs text-purple-700">بالتفويض</span>}
      {r.my_early_step != null && (
        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800" data-testid="awaiting-manager-chip">
          بانتظار المدير المباشر
        </span>
      )}
      {r.status === 'pending' &&
        r.steps.some((s) => s.status === 'active' && s.approvers.some((a) => a.deferred_at && !a.decision)) && (
          <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs text-sky-700">مؤجَّل</span>
        )}
      <StatusBadge status={r.status} />
      <span className="w-36 text-end text-xs text-gray-500">{formatDate(r.created_at)}</span>
    </>
  );
}

function RequestList({ box }: { box: 'pending_mine' | 'received' | 'requested_by_me' }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['approvals', box],
    queryFn: () => approvalsApi.list(box),
    refetchInterval: 60_000,
  });
  const { data: cancelled } = useQuery({
    queryKey: ['approvals', 'cancelled_mine'],
    queryFn: () => approvalsApi.list('cancelled_mine'),
    enabled: box === 'pending_mine',
  });
  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }
  if (error) return <Card className="p-6 text-sm text-red-600">{toUserMessage(error)}</Card>;
  const greyed = box === 'pending_mine' ? cancelled ?? [] : [];
  return (
    <div className="space-y-3">
      {!data?.length ? (
        <EmptyState
          icon={CheckCheck}
          title={box === 'pending_mine' ? 'لا طلبات بانتظار قرارك' : box === 'received' ? 'لم يصلك أي طلب اعتماد' : 'لم تقدّم طلبات اعتماد'}
        />
      ) : (
        <Card className="overflow-hidden">
          {data.map((r) => (
            <RequestRow key={r.id} r={r} disabled={r.status === 'cancelled'} />
          ))}
        </Card>
      )}
      {greyed.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-gray-500">طلبات أُلغيت (آخر 30 يومًا) — للعلم فقط، لا يمكن اعتمادها:</p>
          <Card className="overflow-hidden">
            {greyed.map((r) => (
              <RequestRow key={r.id} r={r} disabled />
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}

function Delegations() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['approvals', 'delegations'], queryFn: approvalsApi.delegations });
  const [delegate, setDelegate] = useState<string[]>([]);
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['approvals', 'delegations'] });
  const create = useMutation({
    mutationFn: () =>
      approvalsApi.createDelegation({
        delegate_id: delegate[0],
        starts_at: new Date(startsAt || Date.now()).toISOString(),
        ends_at: new Date(endsAt).toISOString(),
      }),
    onSuccess: () => {
      setDelegate([]);
      setEndsAt('');
      setError(null);
      void refresh();
    },
    onError: (err) => setError(toUserMessage(err, 'تعذر إنشاء التفويض')),
  });
  const revoke = useMutation({ mutationFn: approvalsApi.revokeDelegation, onSuccess: refresh });
  const now = Date.now();
  const live = (d: { revoked_at: string | null; starts_at: string; ends_at: string }) =>
    !d.revoked_at && new Date(d.starts_at).getTime() <= now && new Date(d.ends_at).getTime() > now;

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-5">
        <h3 className="text-sm font-semibold text-gray-900">تفويض مؤقت لصلاحية الاعتماد</h3>
        <p className="text-xs text-gray-500">
          يستطيع المفوَّض اتخاذ القرار نيابة عنك فقط في الطلبات التي هو أصلًا من مستلمي مراسلتها — التفويض لا يمنح أي
          اطلاع على المحتوى. الحد الأقصى 90 يومًا، ويُسجّل كل قرار بالتفويض مع هوية المفوَّض.
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <RecipientPicker
            id="delegate"
            label="المفوَّض"
            value={delegate}
            onChange={(ids) => setDelegate(ids.slice(-1))}
          />
          <div>
            <Label htmlFor="d-start">من (اختياري — الآن)</Label>
            <Input id="d-start" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="d-end">إلى</Label>
            <Input id="d-end" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
          </div>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end">
          <Button size="sm" disabled={!delegate.length || !endsAt} loading={create.isPending} onClick={() => create.mutate()}>
            إنشاء التفويض
          </Button>
        </div>
      </Card>
      {(['given', 'received'] as const).map((side) => (
        <Card key={side} className="p-5">
          <h3 className="mb-2 text-sm font-semibold text-gray-900">{side === 'given' ? 'تفويضات منحتُها' : 'تفويضات ممنوحة لي'}</h3>
          {(data?.[side] ?? []).length === 0 ? (
            <p className="text-sm text-gray-400">لا شيء</p>
          ) : (
            <ul className="space-y-2">
              {data![side].map((d) => (
                <li key={d.id} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm">
                  <span>
                    {side === 'given' ? d.delegate.full_name : d.delegator.full_name} — {formatDate(d.starts_at)} ←{' '}
                    {formatDate(d.ends_at)}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={cn('text-xs', live(d) ? 'text-emerald-700' : 'text-gray-400')}>
                      {d.revoked_at ? 'ملغى' : live(d) ? 'سارٍ' : 'غير سارٍ'}
                    </span>
                    {side === 'given' && !d.revoked_at && (
                      <Button variant="ghost" size="sm" onClick={() => revoke.mutate(d.id)}>
                        إلغاء
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}
    </div>
  );
}

/** «طلب جديد»: نوع ثابت يحدده المسؤول (صرف، إجازة…) + ملف الطلب. */
function NewRequest({ onDone, onCancel }: { onDone: (id: string) => void; onCancel: () => void }) {
  const { data: types } = useQuery({ queryKey: ['approvals', 'request-types'], queryFn: approvalsApi.requestTypes });
  const [typeId, setTypeId] = useState('');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [deliverTo, setDeliverTo] = useState<string[]>([]);
  const [deliverCc, setDeliverCc] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const submit = useMutation({
    mutationFn: () => approvalsApi.fileRequest({ workflow_id: typeId, title, note, file: file!, deliver_to: deliverTo, deliver_cc: deliverCc }),
    onSuccess: (r) => onDone(r.id),
    onError: (err) => setError(toUserMessage(err, 'تعذر تقديم الطلب')),
  });
  const chosen = types?.find((t) => t.id === typeId);
  return (
    <Card className="space-y-3 p-5" data-testid="new-request">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
        <FilePlus2 className="h-4 w-4" />
        طلب جديد
      </h3>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <Label htmlFor="req-type">نوع الطلب</Label>
          <select id="req-type" value={typeId} onChange={(e) => setTypeId(e.target.value)} className="h-10 w-full rounded-lg border border-gray-300 bg-white px-2 text-sm">
            <option value="">اختر…</option>
            {(types ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="req-title">عنوان الطلب</Label>
          <Input id="req-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثال: صرف مستلزمات مكتبية" />
        </div>
      </div>
      {chosen && (
        <p className="text-xs text-gray-500">يمر الطلب على {chosen.steps.length} خطوة اعتماد، وكل معتمد يوقّع على الملف.</p>
      )}
      <div>
        <Label htmlFor="req-file">ملف الطلب (PDF أو صورة)</Label>
        <input
          id="req-file"
          type="file"
          accept="application/pdf,image/png,image/jpeg"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-gray-700 file:me-3 file:rounded-md file:border-0 file:bg-primary-50 file:px-3 file:py-1.5 file:text-primary-700"
        />
      </div>
      <div className="space-y-2 rounded-lg border border-dashed border-gray-300 p-3" data-testid="deliver-after">
        <p className="text-sm font-medium text-gray-800">يُرسل بعد الاعتماد إلى (اختياري)</p>
        <p className="text-xs text-gray-500">
          لخطاب موجّه لأشخاص: بعد اعتماده يصلهم الملف الموقّع مباشرة باسم آخر معتمد (مثل المدير التنفيذي)، وأنت نسخة.
          لا يرونه قبل الاعتماد، ولا يُرسل إن رُفض.
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <RecipientPicker id="deliver-to" label="إلى" value={deliverTo} onChange={setDeliverTo} />
          <RecipientPicker id="deliver-cc" label="نسخة" value={deliverCc} onChange={setDeliverCc} />
        </div>
      </div>
      <div>
        <Label htmlFor="req-note">ملاحظة (اختياري)</Label>
        <textarea id="req-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="w-full rounded-lg border border-gray-300 p-2 text-sm" />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onCancel}>
          إلغاء
        </Button>
        <Button size="sm" disabled={!typeId || !title.trim() || !file} loading={submit.isPending} onClick={() => submit.mutate()}>
          تقديم الطلب
        </Button>
      </div>
    </Card>
  );
}

export function Approvals() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('pending_mine');
  // «طلب جديد» من الرئيسية: /approvals?new=1
  const [creating, setCreating] = useState(() => new URLSearchParams(window.location.search).get('new') === '1');
  const { data: types } = useQuery({ queryKey: ['approvals', 'request-types'], queryFn: approvalsApi.requestTypes });
  const tabs: Array<[Tab, string]> = [
    ['pending_mine', 'بانتظار قراري'],
    ['received', 'وصلتني'],
    ['requested_by_me', 'طلباتي'],
    ['delegations', 'التفويضات'],
  ];
  return (
    <>
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-gray-900">الموافقات</h2>
          <Link to="/verify-signature" className="me-auto ms-3 text-sm text-primary-700 hover:underline">
            التحقق من توقيع
          </Link>
          {(types?.length ?? 0) > 0 && !creating && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <FilePlus2 className="h-4 w-4" />
              طلب جديد
            </Button>
          )}
        </div>
        {creating && <NewRequest onCancel={() => setCreating(false)} onDone={(id) => navigate(`/approvals/${id}`)} />}
        <div className="flex gap-1 border-b border-gray-200">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                '-mb-px border-b-2 px-4 py-2 text-sm font-medium',
                tab === key ? 'border-primary-600 text-primary-700' : 'border-transparent text-gray-500 hover:text-gray-800',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === 'delegations' ? <Delegations /> : <RequestList key={tab} box={tab} />}
      </div>
    </>
  );
}

function ApprovalDetail({ id }: { id: string }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: request, isLoading, error } = useQuery({
    queryKey: ['approvals', 'detail', id],
    queryFn: () => approvalsApi.get(id),
  });
  const { data: detail } = useQuery({
    queryKey: ['correspondence', request?.correspondence.id],
    queryFn: () => correspondenceApi.get(request!.correspondence.id),
    enabled: Boolean(request),
  });
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Decision | 'deferred' | null>(null);
  const [note, setNote] = useState('');
  const [password, setPassword] = useState('');
  const [signPage, setSignPage] = useState('');
  const [placement, setPlacement] = useState<Placement | null>(null);
  const { data: mySignature } = useQuery({
    queryKey: ['my-signature'],
    queryFn: approvalsApi.signature,
    enabled: Boolean(request?.signable && (request.my_slot || request.my_early_step != null)),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['approvals'] });
  const decide = useMutation({
    mutationFn: (decision: Decision | 'deferred') =>
      decision === 'deferred'
        ? approvalsApi.defer(id, note)
        : approvalsApi.decide(
            id,
            decision,
            note,
            decision === 'approved' && request?.signable
              ? { password, page: Number(signPage), ...(placement ? { x: placement.x, y: placement.y } : {}) }
              : undefined,
          ),
    onSuccess: () => {
      setConfirming(null);
      setNote('');
      setPassword('');
      setSignPage('');
      setPlacement(null);
      setActionError(null);
      void refresh();
    },
    onError: (err) => {
      setConfirming(null);
      setActionError(toUserMessage(err));
    },
  });
  const cancel = useMutation({ mutationFn: () => approvalsApi.cancel(id), onSuccess: refresh });
  const [removingUser, setRemovingUser] = useState<{ id: string; name: string } | null>(null);
  const removeApprover = useMutation({
    mutationFn: (approverId: string) => approvalsApi.removeApprover(id, approverId),
    onSuccess: () => {
      setRemovingUser(null);
      setActionError(null);
      void refresh();
    },
    onError: (err) => {
      setRemovingUser(null);
      setActionError(toUserMessage(err, 'تعذرت الإزالة'));
    },
  });
  const complete = useMutation({ mutationFn: () => approvalsApi.complete(id), onSuccess: refresh });
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const withdraw = useMutation({
    mutationFn: () => approvalsApi.withdraw(id),
    onSuccess: () => {
      setConfirmWithdraw(false);
      void refresh();
    },
    onError: (err) => setActionError(toUserMessage(err, 'تعذر سحب الاعتماد')),
  });
  const [remindNote, setRemindNote] = useState<string | null>(null);
  const remind = useMutation({
    mutationFn: () => approvalsApi.remind(id),
    onSuccess: (r) => {
      setRemindNote(`أُرسل التذكير إلى ${r.reminded} من المعتمدين.`);
      void refresh();
    },
    onError: (err) => setRemindNote(toUserMessage(err, 'تعذر إرسال التذكير')),
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }
  if (error || !request) {
    return (
      <Card className="mx-auto mt-10 max-w-md p-8 text-center text-sm text-gray-600">
        {toUserMessage(error, 'لا تملك صلاحية الاطلاع على هذا الطلب')}
      </Card>
    );
  }
  // طلب ملغى: لا يُفتح لأحد (من رابط أو إشعار قديم) — رسالة فقط.
  if (request.status === 'cancelled') {
    return (
      <Card className="mx-auto mt-10 max-w-md space-y-3 p-8 text-center" data-testid="cancelled-request">
        <p className="text-base font-semibold text-gray-900">هذا الطلب ملغى</p>
        <p className="text-sm text-gray-500">أُلغي في {formatDate(request.decided_at)} ولم يعد متاحًا.</p>
        <Link to="/approvals" className="inline-block text-sm text-primary-700 hover:underline">
          العودة إلى الموافقات
        </Link>
      </Card>
    );
  }

  const isRequester = request.requested_by.id === String(user?.id);
  const contentReady = Boolean(detail?.content);
  // المدير التنفيذي قبل وصول دوره: اعتماد أو رفض مباشر فقط.
  const early = !request.my_slot && request.my_early_step != null;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Card className="space-y-4 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
              <FileSignature className="h-5 w-5 text-gray-500" />
              طلب اعتماد
            </h2>
            <p className="text-sm text-gray-600">
              المراسلة{' '}
              <Link to={`/correspondence/${request.correspondence.id}`} className="font-mono text-primary-700 hover:underline" dir="ltr">
                {request.correspondence.reference_number}
              </Link>{' '}
              — مقدّم الطلب {request.requested_by.full_name} — {formatDate(request.created_at)}
            </p>
          </div>
          <StatusBadge status={request.status} />
        </div>

        <NoteBanner request={request} meId={user ? String(user.id) : undefined} />

        <div className="rounded-lg bg-gray-50 p-4">
          {!detail ? (
            <span className="flex items-center gap-2 text-sm text-gray-500">
              <Spinner size="sm" />
              جارٍ تحميل المحتوى…
            </span>
          ) : detail.content ? (
            <div className="space-y-1">
              <p className="font-medium text-gray-900">{detail.content.subject}</p>
              <p className="line-clamp-6 whitespace-pre-wrap break-words text-sm text-gray-700">{detail.content.body}</p>
            </div>
          ) : (
            <span className="flex items-center gap-2 text-sm text-gray-600">
              <Lock className="h-4 w-4" />
              تعذر عرض محتوى المراسلة.
            </span>
          )}
        </div>

        {request.signable && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-indigo-100 bg-indigo-50/40 p-3 text-sm" data-testid="request-files">
            <PenLine className="h-4 w-4 text-indigo-700" />
            <span className="font-medium text-indigo-900">{request.workflow_name}</span>
            <span className="text-gray-500">—</span>
            {request.source_file && <FileButton file={request.source_file} label="الملف الأصلي" />}
            {request.signed_file && (
              <FileButton file={request.signed_file} label={`النسخة الموقّعة (${request.signature_count} توقيع)`} primary />
            )}
          </div>
        )}

        <StepsView
          request={request}
          onRemove={isRequester ? (uid, name) => setRemovingUser({ id: uid, name }) : undefined}
          removing={removeApprover.isPending ? removeApprover.variables : null}
        />
        {(request.deliver_to?.length ?? 0) > 0 && (
          <div className="rounded-lg border border-sky-100 bg-sky-50/60 p-3 text-sm" data-testid="deliver-info">
            {request.delivered_correspondence ? (
              <p className="text-sky-900">
                أُرسل الخطاب المعتمد إلى {request.deliver_to!.map((u) => u.full_name).join('، ')}
                {request.deliver_cc?.length ? ` (نسخة: ${request.deliver_cc.map((u) => u.full_name).join('، ')})` : ''} —{' '}
                <Link to={`/correspondence/${request.delivered_correspondence.id}`} className="font-mono text-primary-700 hover:underline" dir="ltr">
                  {request.delivered_correspondence.reference_number}
                </Link>
              </p>
            ) : (
              <p className="text-sky-900">
                بعد الاعتماد يُرسل إلى: {request.deliver_to!.map((u) => u.full_name).join('، ')}
                {request.deliver_cc?.length ? ` — نسخة: ${request.deliver_cc.map((u) => u.full_name).join('، ')}` : ''}
              </p>
            )}
          </div>
        )}
        {request.can_resubmit && <ResubmitPanel request={request} onDone={() => void refresh()} />}
        {request.can_withdraw && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm" data-testid="withdraw-box">
            <span className="text-gray-700">
              {confirmWithdraw
                ? `سحب اعتمادك${request.signable ? ' وتوقيعك' : ''}؟ يعود الطلب لأوله${request.signable ? ' على الملف الأصلي' : ''} لتعتمده من جديد.`
                : `اعتمدت هذا الطلب ولم يعتمده أحد بعدك — يمكنك سحب اعتمادك${request.signable ? ' (مثلًا لتغيير توقيعك ثم التوقيع من جديد)' : ''}.`}
            </span>
            {confirmWithdraw ? (
              <>
                <Button size="sm" variant="danger" loading={withdraw.isPending} onClick={() => withdraw.mutate()} data-testid="withdraw-confirm">
                  نعم، اسحب اعتمادي
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmWithdraw(false)}>
                  إلغاء
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setConfirmWithdraw(true)} data-testid="withdraw-approval">
                سحب اعتمادي
              </Button>
            )}
          </div>
        )}
        {removingUser && (
          <div className="space-y-2 rounded-lg border border-red-200 bg-red-50/60 p-3 text-sm" data-testid="remove-approver-box">
            <p className="text-gray-800">
              إزالة <strong>{removingUser.name}</strong> من معتمدي الطلب؟ لن يستطيع اعتماده
              {request.signable ? '، ويختفي الطلب من عنده (الوارد والإشعارات) — إلا إن كان قد فتحه من قبل فقد اطّلع عليه.' : '.'}
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="danger" loading={removeApprover.isPending} onClick={() => removeApprover.mutate(removingUser.id)}>
                تأكيد الإزالة
              </Button>
              <Button size="sm" variant="outline" onClick={() => setRemovingUser(null)}>
                تراجع
              </Button>
            </div>
          </div>
        )}

        {(request.my_slot || early) && (
          <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/50 p-4" data-testid={early ? 'early-decision' : undefined}>
            {early && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-amber-900">
                  الطلب بانتظار موافقة المدير المباشر. يمكنك الانتظار حتى يصلك دورك، أو اعتماده أو رفضه مباشرة الآن — تُتخطى
                  الخطوات السابقة ويُبلَّغ أصحابها.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" loading={remind.isPending} onClick={() => remind.mutate()} data-testid="remind-approvers">
                    <BellRing className="h-4 w-4" />
                    تذكير بالتوقيع
                  </Button>
                  <span className="text-xs text-gray-600" data-testid="remind-note">
                    {remindNote ?? (request.reminded_at ? `آخر تذكير ${formatDate(request.reminded_at)} — مرة كل ساعة` : 'يُرسل إشعارًا لمن لم يوقّع بعد في الخطوة الحالية.')}
                  </span>
                </div>
              </div>
            )}
            <p className="text-sm text-gray-800">
              {early ? '' : request.my_slot?.delegated ? 'تتخذ القرار بالتفويض نيابة عن معتمد آخر.' : 'دورك في اتخاذ القرار.'} يُسجَّل القرار
              باسمك ووقته ونسخة المراسلة التي اطلعت عليها. هذا سجل داخل النظام وليس توقيعًا إلكترونيًا نظاميًا معتمدًا قانونيًا.
            </p>
            {confirming === 'approved' && request.signable ? (
              <div className="space-y-3 rounded-lg border border-indigo-200 bg-white p-3" data-testid="sign-panel">
                <p className="text-sm font-medium text-gray-900">التوقيع على الطلب</p>
                <SignatureManager compact />
                {mySignature?.has_signature && (
                  <>
                    <div className="md:w-1/2">
                      <Label htmlFor="sign-password">كلمة المرور للتأكيد</Label>
                      <Input
                        id="sign-password"
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                    </div>
                    <div className="md:w-1/2">
                      <Label htmlFor="sign-page">الصفحة التي توقّع عليها</Label>
                      <select
                        id="sign-page"
                        value={signPage}
                        onChange={(e) => {
                          setSignPage(e.target.value);
                          setPlacement(null);
                        }}
                        className="h-10 w-full rounded-lg border border-gray-300 bg-white px-2 text-sm"
                      >
                        <option value="">اختر الصفحة…</option>
                        {Array.from({ length: request.page_count ?? 1 }, (_, i) => String(i + 1)).map((n) => (
                          <option key={n} value={n}>
                            صفحة {n} من {request.page_count}
                            {request.page_signatures[n] ? ` — عليها ${request.page_signatures[n]} توقيع` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    {signPage && request.signature_box && (request.signed_file ?? request.source_file) && (
                      <SignPlacer
                        fileId={(request.signed_file ?? request.source_file)!.id}
                        page={Number(signPage)}
                        box={request.signature_box}
                        taken={request.signature_boxes}
                        value={placement}
                        onChange={setPlacement}
                      />
                    )}
                    <NoteField value={note} onChange={setNote} />
                    <div className="flex gap-2">
                      <Button size="sm" disabled={!password || !signPage} loading={decide.isPending} onClick={() => decide.mutate('approved')}>
                        <PenLine className="h-4 w-4" />
                        توقيع واعتماد
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setConfirming(null)}>
                        تراجع
                      </Button>
                    </div>
                  </>
                )}
              </div>
            ) : confirming ? (
              <div className="space-y-2" data-testid="decision-confirm">
                <NoteField
                  value={note}
                  onChange={setNote}
                  label={
                    confirming === 'returned'
                      ? 'ما المطلوب تعديله؟ (يظهر لمقدّم الطلب)'
                      : confirming === 'rejected'
                        ? 'سبب الرفض (اختياري، يظهر لمقدّم الطلب)'
                        : confirming === 'deferred'
                          ? 'سبب التأجيل أو موعد البتّ (اختياري)'
                          : undefined
                  }
                />
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm">
                    {confirming === 'deferred'
                      ? 'تأجيل: يبقى الطلب عندك لتقرر لاحقًا، ويُبلَّغ مقدّمه.'
                      : `تأكيد «${DECISION_LABELS[confirming]}»${early ? ' مباشرة دون انتظار المدير المباشر' : ''}؟ لا يمكن التراجع عن القرار.`}
                  </span>
                  <Button size="sm" loading={decide.isPending} onClick={() => decide.mutate(confirming)}>
                    تأكيد
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setConfirming(null)}>
                    تراجع
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={!contentReady} onClick={() => setConfirming('approved')}>
                  {early ? 'اعتماد مباشر' : 'اعتماد'}
                </Button>
                {!early && (
                  <>
                    <Button size="sm" variant="outline" disabled={!contentReady} onClick={() => setConfirming('returned')}>
                      إعادة للمراجعة
                    </Button>
                    <Button size="sm" variant="outline" disabled={!contentReady} onClick={() => setConfirming('deferred')}>
                      <Clock className="h-4 w-4" />
                      تأجيل
                    </Button>
                  </>
                )}
                <Button size="sm" variant="danger" disabled={!contentReady} onClick={() => setConfirming('rejected')}>
                  رفض
                </Button>
              </div>
            )}
          </div>
        )}
        {actionError && <p className="text-sm text-red-600">{actionError}</p>}

        <Timeline request={request} />

        {isRequester && (
          <div className="flex justify-end gap-2">
            {request.status === 'pending' && (
              <Button variant="outline" size="sm" loading={cancel.isPending} onClick={() => cancel.mutate()}>
                إلغاء الطلب
              </Button>
            )}
            {request.status === 'approved' && (
              <Button size="sm" loading={complete.isPending} onClick={() => complete.mutate()}>
                تعليم المعاملة كمكتملة
              </Button>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function NoteField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <div>
      <Label htmlFor="decision-note">{label ?? 'ملاحظة لمقدّم الطلب (اختياري)'}</Label>
      <textarea
        id="decision-note"
        value={value}
        maxLength={1000}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        className="w-full rounded-lg border border-gray-300 bg-white p-2 text-sm"
      />
    </div>
  );
}

/** مقدّم طلب أُعيد إليه: يكتب ما عدّله، ويرفق ملفًا جديدًا إن لزم (طلب بتوقيع). */
function ResubmitPanel({ request, onDone }: { request: ApprovalRequest; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const returnedAt = request.steps.find((s) => s.status === 'returned')?.step_order;
  const send = useMutation({
    mutationFn: () => approvalsApi.resubmit(request.id, { note, file }),
    onSuccess: () => {
      setNote('');
      setFile(null);
      setError(null);
      onDone();
    },
    onError: (err) => setError(toUserMessage(err, 'تعذرت إعادة الإرسال')),
  });
  return (
    <div className="space-y-3 rounded-lg border border-orange-200 bg-orange-50/50 p-4" data-testid="resubmit-panel">
      <p className="flex items-center gap-2 text-sm font-medium text-gray-900">
        <RotateCcw className="h-4 w-4 text-orange-700" />
        أُعيد إليك الطلب للمراجعة — عدّله وأعد إرساله
      </p>
      <div>
        <Label htmlFor="resubmit-note">ما الذي عدّلته؟ (يظهر للمعتمدين)</Label>
        <textarea
          id="resubmit-note"
          value={note}
          maxLength={1000}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          className="w-full rounded-lg border border-gray-300 bg-white p-2 text-sm"
        />
      </div>
      {request.signable && (
        <div>
          <Label htmlFor="resubmit-file">ملف جديد بدل الحالي (اختياري — PDF أو صورة)</Label>
          <input
            id="resubmit-file"
            type="file"
            accept="application/pdf,image/png,image/jpeg"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-gray-700 file:me-3 file:rounded-md file:border-0 file:bg-primary-50 file:px-3 file:py-1.5 file:text-primary-700"
          />
        </div>
      )}
      <p className="text-xs text-gray-600">
        {file
          ? 'ملف جديد: يبدأ الطلب من الخطوة الأولى ويوقّع كل المعتمدين على الملف الجديد، لأن أحدًا لم يوقّع عليه بعد.'
          : `بلا ملف جديد: يعود الطلب إلى الخطوة ${returnedAt ?? ''} التي أعادته، وتبقى الاعتمادات والتوقيعات السابقة.`}
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex justify-end">
        <Button size="sm" loading={send.isPending} onClick={() => send.mutate()}>
          إعادة الإرسال
        </Button>
      </div>
    </div>
  );
}

function FileButton({ file, label, primary = false }: { file: FileRef; label: string; primary?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant={primary ? 'primary' : 'outline'}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          saveBlob(await correspondenceApi.download(file.id), file.name);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Download className="h-4 w-4" />
      {label}
    </Button>
  );
}

export function ApprovalDetailPage() {
  const { id } = useParams<{ id: string }>();
  return id ? <ApprovalDetail key={id} id={id} /> : null;
}

export const ApprovalsPages = { Approvals, Detail: ApprovalDetailPage };
