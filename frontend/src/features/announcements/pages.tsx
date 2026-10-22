import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, CheckCircle2, Lock, Megaphone, Plus, ShieldAlert, Users } from 'lucide-react';
import { Button, Card, EmptyState, Input, Label, Spinner } from '../../shared/ui';
import { cn } from '../../shared/lib/cn';
import { toUserMessage } from '../../shared/api';
import { useAuth } from '../auth/AuthContext';
import { CryptoGate, E2EENote, RecipientPicker, formatDate } from '../correspondence/components';
import {
  announcementsApi,
  PRIORITY_LABELS,
  TARGET_LABELS,
  type Announcement,
  type AnnouncementPriority,
  type TargetType,
  type UserRef,
} from './api';
import {
  acknowledgeAnnouncement,
  openAnnouncement,
  prepareAnnouncement,
  publishAnnouncement,
  type OpenAnnouncement,
} from './service';

/** رسائل أخطاء العميل (Error عادي) كما هي، وأخطاء الخادم عبر toUserMessage. */
function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && !('status' in err)) return err.message;
  return toUserMessage(err, fallback);
}

// ---------------------------------------------------------------------------
// القائمة
// ---------------------------------------------------------------------------

function StatusLine({ a }: { a: Announcement }) {
  if (a.status === 'withdrawn') return <span className="text-xs text-gray-500">مسحوب</span>;
  if (a.status === 'draft') return <span className="text-xs text-gray-500">لم يُنشر</span>;
  if (a.mine) {
    if (a.mine.acknowledged_at) return <span className="text-xs text-emerald-700">أقررتَ بالاطلاع</span>;
    if (a.requires_ack) {
      const overdue = a.ack_due_at && new Date(a.ack_due_at) < new Date();
      return (
        <span className={cn('text-xs font-medium', overdue ? 'text-red-600' : 'text-amber-700')}>
          {overdue ? 'تجاوز موعد الإقرار' : 'بانتظار إقرارك'}
        </span>
      );
    }
  }
  return null;
}

function AnnouncementList({ box }: { box: 'received' | 'published' }) {
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useQuery({
    queryKey: ['announcements', box, page],
    queryFn: () => announcementsApi.list(box, page),
  });
  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }
  if (error) return <Card className="p-6 text-sm text-red-600">{toUserMessage(error)}</Card>;
  if (!data?.results.length) return <EmptyState icon={Megaphone} title="لا تعاميم" />;
  return (
    <div className="space-y-3">
      <Card className="overflow-hidden">
        {data.results.map((a) => (
          <Link
            key={a.id}
            to={`/announcements/${a.id}`}
            className={cn(
              'flex items-center gap-3 border-b border-gray-100 px-4 py-3 text-sm last:border-0 hover:bg-gray-50',
              a.mine && !a.mine.read_at && 'bg-primary-50/40',
            )}
          >
            <span dir="ltr" className="w-44 shrink-0 font-mono text-xs text-gray-600">
              {a.reference_number ?? '—'}
            </span>
            <span className="flex-1 truncate text-gray-800">
              {box === 'received' ? a.publisher.full_name : `${TARGET_LABELS[a.target.type]}${a.target.name ? `: ${a.target.name}` : ''}`}
              <span className="ms-2 text-xs text-gray-500">({a.recipient_count} مستلم)</span>
            </span>
            {a.priority !== 'normal' && (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">{PRIORITY_LABELS[a.priority]}</span>
            )}
            <StatusLine a={a} />
            <span className="w-36 text-end text-xs text-gray-500">{formatDate(a.published_at ?? a.created_at)}</span>
          </Link>
        ))}
      </Card>
      {(data.next || data.previous) && (
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

export function Announcements() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<'received' | 'published'>('received');
  return (
    <CryptoGate>
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">التعاميم</h2>
          <Button onClick={() => navigate('/announcements/new')}>
            <Plus className="h-4 w-4" />
            تعميم جديد
          </Button>
        </div>
        <div className="flex gap-1 border-b border-gray-200">
          {(
            [
              ['received', 'الواردة إليّ'],
              ['published', 'التي أصدرتُها'],
            ] as const
          ).map(([key, label]) => (
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
        <AnnouncementList key={tab} box={tab} />
      </div>
    </CryptoGate>
  );
}

// ---------------------------------------------------------------------------
// الإنشاء: إعداد ← مراجعة الجمهور ← تشفير ونشر
// ---------------------------------------------------------------------------

function ComposeForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [targetType, setTargetType] = useState<TargetType>('branch');
  const [targetId, setTargetId] = useState('');
  const [users, setUsers] = useState<string[]>([]);
  const [priority, setPriority] = useState<AnnouncementPriority>('normal');
  const [requiresAck, setRequiresAck] = useState(true);
  const [dueAt, setDueAt] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<{ prepared: Announcement; recipients: UserRef[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: institutes } = useQuery({ queryKey: ['org', 'institutes'], queryFn: announcementsApi.institutes });
  const { data: branches } = useQuery({ queryKey: ['org', 'branches'], queryFn: announcementsApi.branches });
  const { data: departments } = useQuery({ queryKey: ['org', 'departments'], queryFn: announcementsApi.departments });
  const units = useMemo(
    () => ({ institute: institutes ?? [], branch: branches ?? [], department: departments ?? [] }),
    [institutes, branches, departments],
  );

  const onPrepare = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!subject.trim()) return setError('العنوان مطلوب');
    if (targetType === 'users' && users.length === 0) return setError('اختر موظفًا واحدًا على الأقل');
    if (['department', 'branch', 'institute'].includes(targetType) && !targetId) return setError('اختر الوحدة');
    setBusy(true);
    try {
      const prepared = await prepareAnnouncement({
        target_type: targetType,
        target_id: targetType === 'users' || targetType === 'all' ? null : targetId,
        user_ids: targetType === 'users' ? users : [],
        priority,
        requires_ack: requiresAck,
        ack_due_at: requiresAck && dueAt ? new Date(dueAt).toISOString() : null,
      });
      const audience = await announcementsApi.audience(prepared.id);
      setReview({ prepared, recipients: audience.recipients });
    } catch (err) {
      setError(getErrorMessage(err, 'تعذر إعداد التعميم'));
    } finally {
      setBusy(false);
    }
  };

  const onPublish = async () => {
    if (!review) return;
    setBusy(true);
    setError(null);
    try {
      const published = await publishAnnouncement(
        review.prepared,
        review.recipients.map((u) => u.id),
        subject.trim(),
        body,
      );
      await queryClient.invalidateQueries({ queryKey: ['announcements'] });
      navigate(`/announcements/${published.id}`, { replace: true });
    } catch (err) {
      const unreachable = (err as { unreachableUserIds?: string[] }).unreachableUserIds;
      if (unreachable?.length) {
        const names = review.recipients.filter((u) => unreachable.includes(u.id)).map((u) => u.full_name);
        setError(
          `لا يمكن النشر: ${unreachable.length} مستلم لم يفعّل التشفير على أي جهاز بعد (${names.slice(0, 10).join('، ')}${names.length > 10 ? '…' : ''}). يجب أن يسجّلوا الدخول مرة واحدة على الأقل، أو اختر نطاقًا آخر.`,
        );
      } else {
        setError(getErrorMessage(err, 'تعذر نشر التعميم'));
      }
    } finally {
      setBusy(false);
    }
  };

  const onCancelReview = async () => {
    if (review) await announcementsApi.discard(review.prepared.id).catch(() => undefined);
    setReview(null);
  };

  if (review) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <h2 className="text-lg font-semibold text-gray-900">مراجعة الجمهور قبل النشر</h2>
        <Card className="space-y-3 p-6">
          <p className="flex items-center gap-2 text-sm text-gray-800">
            <Users className="h-4 w-4" />
            سيُشفَّر التعميم لـ <strong>{review.recipients.length}</strong> مستلمًا فقط — ولا يملك أي طرف آخر مفتاح فكه. هذه
            القائمة معلنة لكل المستلمين.
          </p>
          <div className="max-h-72 overflow-y-auto rounded-lg border border-gray-200 p-3 text-sm text-gray-700">
            {review.recipients.map((u) => u.full_name).join('، ')}
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => void onCancelReview()} disabled={busy}>
              رجوع وإلغاء
            </Button>
            <Button onClick={() => void onPublish()} loading={busy}>
              {busy ? 'جارٍ التشفير والنشر…' : 'تشفير ونشر'}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <form onSubmit={onPrepare} className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">تعميم جديد</h2>
        <E2EENote />
      </div>
      <Card className="space-y-4 p-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="target">الجمهور</Label>
            <select
              id="target"
              value={targetType}
              onChange={(e) => {
                setTargetType(e.target.value as TargetType);
                setTargetId('');
              }}
              className="h-10 w-full rounded-lg border border-gray-300 bg-white px-2 text-sm"
            >
              {(Object.keys(TARGET_LABELS) as TargetType[]).map((t) => (
                <option key={t} value={t}>
                  {TARGET_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          {(targetType === 'department' || targetType === 'branch' || targetType === 'institute') && (
            <div>
              <Label htmlFor="unit">الوحدة</Label>
              <select
                id="unit"
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                className="h-10 w-full rounded-lg border border-gray-300 bg-white px-2 text-sm"
              >
                <option value="">اختر…</option>
                {units[targetType].map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.code})
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        {targetType === 'users' && <RecipientPicker id="ann-users" label="الموظفون" value={users} onChange={setUsers} />}
        <p className="text-xs text-gray-500">
          يحدد الخادم المستلمين من الهيكل التنظيمي الحالي (العضويات السارية)، ويتحقق من صلاحيتك للنشر في هذا النطاق. ستراجع
          القائمة قبل النشر.
        </p>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <Label htmlFor="ann-priority">الأهمية</Label>
            <select
              id="ann-priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as AnnouncementPriority)}
              className="h-10 w-full rounded-lg border border-gray-300 bg-white px-2 text-sm"
            >
              {(Object.keys(PRIORITY_LABELS) as AnnouncementPriority[]).map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
          <label className="mt-7 flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={requiresAck} onChange={(e) => setRequiresAck(e.target.checked)} className="accent-primary-600" />
            يتطلب تأكيد الاطلاع
          </label>
          {requiresAck && (
            <div>
              <Label htmlFor="ann-due">الموعد النهائي للإقرار</Label>
              <Input id="ann-due" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
            </div>
          )}
        </div>

        <div>
          <Label htmlFor="ann-subject">العنوان</Label>
          <Input id="ann-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={500} />
        </div>
        <div>
          <Label htmlFor="ann-body">نص التعميم</Label>
          <textarea
            id="ann-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={10}
            maxLength={100_000}
            className="w-full rounded-lg border border-gray-300 p-3 text-sm leading-7 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
          />
        </div>
      </Card>
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <div className="flex justify-end">
        <Button type="submit" loading={busy}>
          متابعة لمراجعة الجمهور
        </Button>
      </div>
    </form>
  );
}

export function ComposeAnnouncement() {
  return (
    <CryptoGate>
      <ComposeForm />
    </CryptoGate>
  );
}

// ---------------------------------------------------------------------------
// التفاصيل: المحتوى، الإقرار الموقّع، الالتزام والتذكير
// ---------------------------------------------------------------------------

function ComplianceCard({ a }: { a: Announcement }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['announcements', 'compliance', a.id], queryFn: () => announcementsApi.compliance(a.id) });
  const [message, setMessage] = useState<string | null>(null);
  const remind = useMutation({
    mutationFn: () => announcementsApi.remind(a.id),
    onSuccess: (r) => {
      setMessage(`أُرسل تذكير إلى ${r.reminded} مستلم.`);
      void queryClient.invalidateQueries({ queryKey: ['announcements', 'compliance', a.id] });
    },
    onError: (err) => setMessage(toUserMessage(err, 'تعذر إرسال التذكير')),
  });
  if (!data) return null;
  const stat = (label: string, value: number, tone = 'text-gray-900') => (
    <div className="rounded-lg bg-gray-50 p-3 text-center">
      <div className={cn('text-xl font-semibold', tone)}>{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">تقرير الالتزام</h3>
        {a.requires_ack && a.status === 'published' && (
          <Button variant="outline" size="sm" loading={remind.isPending} onClick={() => remind.mutate()}>
            <BellRing className="h-4 w-4" />
            تذكير من لم يقر
          </Button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {stat('المستلمون', data.total)}
        {stat('استلموا', data.delivered)}
        {stat('اطّلعوا', data.read)}
        {stat('أقرّوا', data.acknowledged, 'text-emerald-700')}
        {stat('متأخرون', data.overdue, data.overdue ? 'text-red-600' : 'text-gray-900')}
      </div>
      {message && <p className="text-sm text-gray-700">{message}</p>}
      <div className="max-h-96 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white text-xs text-gray-500">
            <tr>
              <th className="py-2 text-start font-medium">الموظف</th>
              <th className="py-2 text-start font-medium">الاستلام</th>
              <th className="py-2 text-start font-medium">الاطلاع</th>
              <th className="py-2 text-start font-medium">الإقرار</th>
              <th className="py-2 text-start font-medium">التذكيرات</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.user.id} className={cn('border-t border-gray-100', r.overdue && 'bg-red-50/50')}>
                <td className="py-2">{r.user.full_name}</td>
                <td className="py-2 text-xs text-gray-600">{formatDate(r.delivered_at)}</td>
                <td className="py-2 text-xs text-gray-600">{formatDate(r.read_at)}</td>
                <td className={cn('py-2 text-xs', r.acknowledged_at ? 'text-emerald-700' : r.overdue ? 'text-red-600' : 'text-gray-400')}>
                  {r.acknowledged_at ? formatDate(r.acknowledged_at) : r.overdue ? 'متأخر' : '—'}
                </td>
                <td className="py-2 text-xs text-gray-600">{r.reminder_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500">بيانات وصفية فقط — التقرير لا يكشف محتوى التعميم لمن ليس من مستلميه.</p>
    </Card>
  );
}

function Detail({ id }: { id: string }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: a, isLoading, error } = useQuery({ queryKey: ['announcements', 'detail', id], queryFn: () => announcementsApi.get(id) });
  const [opened, setOpened] = useState<OpenAnnouncement | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!a || a.status === 'draft') return;
    let cancelled = false;
    openAnnouncement(a)
      .then((r) => {
        if (cancelled) return;
        setOpened(r);
        if (r.state === 'ok' && a.mine && !a.mine.read_at) {
          void announcementsApi.markRead(a.id).then(() => queryClient.invalidateQueries({ queryKey: ['announcements'] }));
        }
      })
      .catch(() => !cancelled && setOpened({ state: 'unavailable', reason: 'تعذر فك التشفير' }));
    return () => {
      cancelled = true;
    };
  }, [a, queryClient]);

  const ack = useMutation({
    mutationFn: () => acknowledgeAnnouncement(a!, String(user!.id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['announcements'] }),
    onError: (err) => setActionError(getErrorMessage(err, 'تعذر تسجيل الإقرار')),
  });
  const withdraw = useMutation({
    mutationFn: () => announcementsApi.withdraw(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['announcements'] }),
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }
  if (error || !a) {
    return (
      <Card className="mx-auto mt-10 max-w-md p-8 text-center text-sm text-gray-600">
        {toUserMessage(error, 'لا تملك صلاحية الاطلاع على هذا التعميم')}
      </Card>
    );
  }

  const ok = opened?.state === 'ok' ? opened.stored : null;
  const trustworthy = ok && ok.senderVerified && ok.bound && ok.undeclaredMembers.length === 0;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Card className="space-y-4 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-xl font-semibold text-gray-900">
              {ok ? ok.content.subject : (
                <span className="flex items-center gap-2 text-gray-400">
                  <Lock className="h-5 w-5" />
                  مشفّر
                </span>
              )}
            </h2>
            <p className="text-xs text-gray-500">
              <span dir="ltr" className="font-mono">{a.reference_number ?? 'غير منشور'}</span> — من {a.publisher.full_name} —{' '}
              {TARGET_LABELS[a.target.type]}
              {a.target.name ? `: ${a.target.name}` : ''} ({a.recipient_count} مستلم) — {formatDate(a.published_at)}
            </p>
            {a.requires_ack && (
              <p className="text-xs text-gray-600">
                يتطلب تأكيد الاطلاع{a.ack_due_at ? ` قبل ${formatDate(a.ack_due_at)}` : ''}
              </p>
            )}
          </div>
          {a.is_publisher && a.status === 'published' && (
            <Button variant="outline" size="sm" loading={withdraw.isPending} onClick={() => withdraw.mutate()}>
              سحب التعميم
            </Button>
          )}
        </div>
        {a.status === 'withdrawn' && (
          <p className="rounded-lg bg-gray-100 p-3 text-sm text-gray-700">
            سُحب هذا التعميم في {formatDate(a.withdrawn_at)}. لا يمكن استرجاع النسخ التي سبق فكها على أجهزة المستلمين.
          </p>
        )}

        {ok && (ok.undeclaredMembers.length > 0 || !ok.senderVerified || !ok.bound) && (
          <div className="flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            {ok.undeclaredMembers.length > 0
              ? `مجموعة التشفير تضم ${ok.undeclaredMembers.length} عضوًا غير معلن في قائمة المستلمين — أبلغ مسؤول الأمن ولا تعتمد على سرية هذا التعميم.`
              : 'تعذر التحقق من أن المحتوى صادر من الناشر المعروض ومربوط بهذا التعميم.'}
          </div>
        )}

        {opened === null && a.status !== 'draft' ? (
          <span className="flex items-center gap-2 text-sm text-gray-500">
            <Spinner size="sm" />
            جارٍ فك التشفير على جهازك…
          </span>
        ) : opened?.state === 'unavailable' ? (
          <p className="flex items-center gap-2 rounded-lg bg-gray-50 p-4 text-sm text-gray-600">
            <Lock className="h-4 w-4" />
            {opened.reason}
          </p>
        ) : ok ? (
          <div className="whitespace-pre-wrap break-words text-sm leading-7 text-gray-800">{ok.content.body || '—'}</div>
        ) : null}

        {a.mine && a.requires_ack && a.status === 'published' && (
          <div className="rounded-lg border border-gray-200 p-4">
            {a.mine.acknowledged_at ? (
              <p className="flex items-center gap-2 text-sm text-emerald-700">
                <CheckCircle2 className="h-4 w-4" />
                أقررتَ بالاطلاع في {formatDate(a.mine.acknowledged_at)} (موقّع من جهازك).
              </p>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-gray-700">
                  الإقرار يُوقَّع بمفتاح جهازك ويرتبط بنسخة التعميم التي اطلعت عليها (دليل سلامة داخل النظام، لا توقيع نظامي
                  قانوني).
                </p>
                <Button onClick={() => ack.mutate()} loading={ack.isPending} disabled={!trustworthy}>
                  أقر بالاطلاع
                </Button>
              </div>
            )}
          </div>
        )}
        {actionError && <p className="text-sm text-red-600">{actionError}</p>}
        <E2EENote />
      </Card>
      {a.can_track && a.status !== 'draft' && <ComplianceCard a={a} />}
    </div>
  );
}

export function AnnouncementDetail() {
  const { id } = useParams<{ id: string }>();
  return <CryptoGate>{id ? <Detail key={id} id={id} /> : null}</CryptoGate>;
}

export const AnnouncementsPages = { Announcements, Compose: ComposeAnnouncement, Detail: AnnouncementDetail };
