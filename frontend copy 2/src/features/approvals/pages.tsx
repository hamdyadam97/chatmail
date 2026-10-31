import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCheck, FileSignature, Lock, ShieldAlert } from 'lucide-react';
import { Button, Card, EmptyState, Input, Label, Spinner } from '../../shared/ui';
import { cn } from '../../shared/lib/cn';
import { toUserMessage } from '../../shared/api';
import { useAuth } from '../auth/AuthContext';
import { correspondenceApi } from '../correspondence/api';
import { CryptoGate, RecipientPicker } from '../correspondence/components';
import { openCorrespondence, type OpenResult } from '../correspondence/service';
import { approvalsApi, DECISION_LABELS, type ApprovalRequest, type Decision } from './api';
import { StatusBadge, StepsView, formatDate } from './components';
import { ContentMismatchError, signDecision } from './signing';

type Tab = 'pending_mine' | 'requested_by_me' | 'delegations';

function RequestRow({ r }: { r: ApprovalRequest }) {
  return (
    <Link
      to={`/approvals/${r.id}`}
      className="flex items-center gap-3 border-b border-gray-100 px-4 py-3 text-sm last:border-0 hover:bg-gray-50"
    >
      <span dir="ltr" className="w-48 shrink-0 font-mono text-xs text-gray-600">
        {r.correspondence.reference_number}
      </span>
      <span className="flex-1 text-gray-800">مقدّم الطلب: {r.requested_by.full_name}</span>
      <span className="text-xs text-gray-500">
        الخطوة {r.current_step_order}/{r.steps.length}
      </span>
      {r.my_slot?.delegated && <span className="text-xs text-purple-700">بالتفويض</span>}
      <StatusBadge status={r.status} />
      <span className="w-36 text-end text-xs text-gray-500">{formatDate(r.created_at)}</span>
    </Link>
  );
}

function RequestList({ box }: { box: 'pending_mine' | 'requested_by_me' }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['approvals', box],
    queryFn: () => approvalsApi.list(box),
    refetchInterval: 60_000,
  });
  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }
  if (error) return <Card className="p-6 text-sm text-red-600">{toUserMessage(error)}</Card>;
  if (!data?.length) {
    return (
      <EmptyState
        icon={CheckCheck}
        title={box === 'pending_mine' ? 'لا طلبات بانتظار قرارك' : 'لم تقدّم طلبات اعتماد'}
      />
    );
  }
  return (
    <Card className="overflow-hidden">
      {data.map((r) => (
        <RequestRow key={r.id} r={r} />
      ))}
    </Card>
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
          اطلاع على المحتوى. الحد الأقصى 90 يومًا، ويُسجّل كل قرار بالتفويض مع هوية المفوَّض وتوقيع جهازه.
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

export function Approvals() {
  const [tab, setTab] = useState<Tab>('pending_mine');
  const tabs: Array<[Tab, string]> = [
    ['pending_mine', 'بانتظار قراري'],
    ['requested_by_me', 'طلباتي'],
    ['delegations', 'التفويضات'],
  ];
  return (
    <CryptoGate>
      <div className="mx-auto max-w-5xl space-y-4">
        <h2 className="text-lg font-semibold text-gray-900">الموافقات</h2>
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
    </CryptoGate>
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
  const [opened, setOpened] = useState<OpenResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Decision | null>(null);

  useEffect(() => {
    if (!detail) return;
    let cancelled = false;
    openCorrespondence(detail)
      .then((r) => !cancelled && setOpened(r))
      .catch(() => !cancelled && setOpened({ state: 'unavailable', reason: 'تعذر فك التشفير' }));
    return () => {
      cancelled = true;
    };
  }, [detail]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['approvals'] });
  const decide = useMutation({
    mutationFn: async (decision: Decision) => {
      if (!request || !detail?.content) throw new Error('المحتوى غير متاح');
      const signed = await signDecision({
        request,
        userId: String(user!.id),
        decision,
        reviewedCiphertextB64: detail.content.mls_payload,
      });
      return approvalsApi.decide(request.id, signed);
    },
    onSuccess: () => {
      setConfirming(null);
      void refresh();
    },
    onError: (err) => {
      setConfirming(null);
      setActionError(err instanceof ContentMismatchError || !('status' in (err as object)) ? (err as Error).message : toUserMessage(err));
    },
  });
  const cancel = useMutation({ mutationFn: () => approvalsApi.cancel(id), onSuccess: refresh });
  const complete = useMutation({ mutationFn: () => approvalsApi.complete(id), onSuccess: refresh });

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

  const isRequester = request.requested_by.id === String(user?.id);
  const contentReady = opened?.state === 'ok' && opened.stored.senderVerified && opened.stored.bound;

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

        <div className="rounded-lg bg-gray-50 p-4">
          {opened === null ? (
            <span className="flex items-center gap-2 text-sm text-gray-500">
              <Spinner size="sm" />
              جارٍ فك المحتوى على جهازك…
            </span>
          ) : opened.state === 'ok' ? (
            <div className="space-y-1">
              <p className="font-medium text-gray-900">{opened.stored.content.subject}</p>
              <p className="line-clamp-6 whitespace-pre-wrap break-words text-sm text-gray-700">{opened.stored.content.body}</p>
              {(!opened.stored.senderVerified || !opened.stored.bound) && (
                <p className="flex items-center gap-1 text-sm text-red-700">
                  <ShieldAlert className="h-4 w-4" />
                  تعذر التحقق من سلامة المحتوى — لا يمكن اتخاذ قرار عليه.
                </p>
              )}
            </div>
          ) : (
            <span className="flex items-center gap-2 text-sm text-gray-600">
              <Lock className="h-4 w-4" />
              {opened.reason}
            </span>
          )}
        </div>

        <StepsView request={request} />

        {request.my_slot && (
          <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/50 p-4">
            <p className="text-sm text-gray-800">
              {request.my_slot.delegated ? 'تتخذ القرار بالتفويض نيابة عن معتمد آخر.' : 'دورك في اتخاذ القرار.'} يُوقَّع القرار بمفتاح
              جهازك ويرتبط ببصمة النسخة المشفرة التي اطلعت عليها. هذا توقيع سلامة تشفيري داخل النظام وليس توقيعًا إلكترونيًا
              نظاميًا معتمدًا قانونيًا.
            </p>
            {!contentReady && <p className="text-sm text-red-700">يجب فك المحتوى والتحقق منه على هذا الجهاز قبل القرار.</p>}
            {confirming ? (
              <div className="flex items-center gap-2">
                <span className="text-sm">تأكيد «{DECISION_LABELS[confirming]}»؟ لا يمكن التراجع عن القرار.</span>
                <Button size="sm" loading={decide.isPending} onClick={() => decide.mutate(confirming)}>
                  تأكيد وتوقيع
                </Button>
                <Button size="sm" variant="outline" onClick={() => setConfirming(null)}>
                  تراجع
                </Button>
              </div>
            ) : (
              <div className="flex gap-2">
                <Button size="sm" disabled={!contentReady} onClick={() => setConfirming('approved')}>
                  اعتماد
                </Button>
                <Button size="sm" variant="outline" disabled={!contentReady} onClick={() => setConfirming('returned')}>
                  إعادة للمراجعة
                </Button>
                <Button size="sm" variant="danger" disabled={!contentReady} onClick={() => setConfirming('rejected')}>
                  رفض
                </Button>
              </div>
            )}
            <p className="text-xs text-gray-500">لإبداء ملاحظات، أرسل ردًّا مشفّرًا على المراسلة نفسها.</p>
          </div>
        )}
        {actionError && <p className="text-sm text-red-600">{actionError}</p>}

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

export function ApprovalDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <CryptoGate>{id ? <ApprovalDetail key={id} id={id} /> : null}</CryptoGate>;
}

export const ApprovalsPages = { Approvals, Detail: ApprovalDetailPage };
