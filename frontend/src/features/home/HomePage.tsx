/**
 * الرئيسية — «مكتب اليوم» (نفس تطبيق الموبايل): ما ينتظر قرارك في بطاقة
 * كحلية واحدة، واختصارات العمل اليومي، و«اليوم»: الطلبات والوارد غير المقروء
 * والتعاميم التي تنتظر إقرارك مرتبة بالأحدث.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCheck, ChevronLeft, FilePlus2, Mail, Megaphone, PenLine, Search, Sun } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import { approvalsApi, type ApprovalRequest } from '../approvals/api';
import { correspondenceApi } from '../correspondence/api';
import { announcementsApi } from '../announcements/api';
import { cn } from '../../shared/lib/cn';

const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const LATE_MS = 48 * 3600 * 1000;
const MAX_ITEMS = 10;

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'صباح الخير';
  if (h < 18) return 'مساء النور';
  return 'مساء الخير';
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 86400000);
  if (diff <= 0) {
    const h = d.getHours() % 12 || 12;
    return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'ص' : 'م'}`;
  }
  if (diff === 1) return 'أمس';
  if (diff < 7) return DAYS[d.getDay()];
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function requestTitle(r: ApprovalRequest): string {
  if (r.title) return r.workflow_name ? r.title.replace(`${r.workflow_name}: `, '') : r.title;
  return r.correspondence.reference_number ?? 'طلب اعتماد';
}

function countWord(n: number): string {
  if (n === 1) return 'طلب';
  if (n === 2) return 'طلبان';
  return n <= 10 ? 'طلبات' : 'طلبًا';
}

type Item =
  | { kind: 'request'; id: string; at: string; title: string; sub: string; late: boolean }
  | { kind: 'mail'; id: string; at: string; title: string; sub: string }
  | { kind: 'announcement'; id: string; at: string; title: string; sub: string; ack: boolean };

const TONE: Record<Item['kind'], { icon: LucideIcon; chip: string }> = {
  request: { icon: PenLine, chip: 'bg-gold-50 text-gold-700' },
  mail: { icon: Mail, chip: 'bg-primary-50 text-primary-700' },
  announcement: { icon: Megaphone, chip: 'bg-emerald-50 text-emerald-700' },
};

export function HomePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const pending = useQuery({ queryKey: ['approvals', 'pending_mine'], queryFn: () => approvalsApi.list('pending_mine') });
  const inbox = useQuery({
    queryKey: ['home', 'inbox'],
    queryFn: () => correspondenceApi.list({ folder: 'inbox', page: 1 }),
  });
  const anns = useQuery({ queryKey: ['home', 'announcements-pending'], queryFn: () => announcementsApi.list('received', 1, true) });
  const targets = useQuery({ queryKey: ['announcements', 'targets'], queryFn: announcementsApi.targets });

  const ack = useMutation({
    mutationFn: (id: string) => announcementsApi.ack(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['home', 'announcements-pending'] });
      void queryClient.invalidateQueries({ queryKey: ['announcements'] });
    },
  });

  const now = Date.now();
  const waiting = (pending.data ?? [])
    .filter((r) => r.status === 'pending')
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const late = waiting.filter((r) => now - new Date(r.created_at).getTime() > LATE_MS).length;
  const byType = new Map<string, number>();
  for (const r of waiting) byType.set(r.workflow_name || 'مراسلة', (byType.get(r.workflow_name || 'مراسلة') ?? 0) + 1);
  const canPublish = !!targets.data && (targets.data.all || targets.data.institutes.length > 0 || targets.data.branches.length > 0);

  const items: Item[] = [
    ...waiting.map<Item>((r) => ({
      kind: 'request',
      id: r.id,
      at: r.created_at,
      title: requestTitle(r),
      sub: `${r.workflow_name || 'طلب اعتماد'} · من ${r.requested_by.full_name}`,
      late: now - new Date(r.created_at).getTime() > LATE_MS,
    })),
    ...(inbox.data?.results ?? [])
      .filter((m) => !m.read_at)
      .map<Item>((m) => ({
        kind: 'mail',
        id: m.id,
        at: m.sent_at || m.created_at,
        title: m.subject || '(بلا عنوان)',
        sub: `مراسلة · من ${m.sender.full_name}`,
      })),
    ...(anns.data?.results ?? []).map<Item>((a) => ({
      kind: 'announcement',
      id: a.id,
      at: a.published_at || a.created_at,
      title: a.content?.title || 'تعميم',
      sub: a.ack_due_at ? `تعميم · الإقرار قبل ${shortDate(a.ack_due_at)}` : `تعميم · من ${a.publisher.full_name}`,
      ack: a.requires_ack,
    })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, MAX_ITEMS);

  const loading = pending.isLoading || inbox.isLoading || anns.isLoading;
  const firstName = (user?.full_name ?? '').trim().split(/\s+/)[0] || user?.username;
  const d = new Date();

  const link = (it: Item) =>
    it.kind === 'request' ? `/approvals/${it.id}` : it.kind === 'mail' ? `/mail/inbox/${it.id}` : `/announcements/${it.id}`;

  return (
    <div className="mx-auto max-w-5xl space-y-6" data-testid="home">
      <div>
        <p className="text-sm text-gray-500">
          {DAYS[d.getDay()]}، {d.getDate()} {MONTHS[d.getMonth()]}
        </p>
        <h1 className="text-2xl font-bold text-gray-900">
          {greeting()}، {firstName}
        </h1>
      </div>

      <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        <div className="space-y-6">
          {/* بانتظار قرارك */}
          {pending.isLoading ? (
            <div className="h-56 animate-pulse rounded-3xl bg-primary-700/90" />
          ) : waiting.length > 0 ? (
            <section aria-label="بانتظار قرارك" className="relative space-y-4 overflow-hidden rounded-3xl bg-primary-700 p-5 text-white" data-testid="home-pending">
              <div aria-hidden="true" className="absolute -left-10 -top-10 h-40 w-40 rounded-full border-[20px] border-white/5" />
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm text-primary-100">بانتظار قرارك</p>
                  <p className="flex items-baseline gap-2">
                    <span className="text-5xl font-bold leading-tight">{waiting.length}</span>
                    <span className="text-base font-semibold">{countWord(waiting.length)}</span>
                  </p>
                </div>
                {late > 0 && (
                  <span className="rounded-full bg-orange-400/15 px-3 py-1 text-xs font-semibold text-orange-200">
                    {late === 1 ? 'واحد ينتظر أكثر من يومين' : `${late} تنتظر أكثر من يومين`}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {[...byType].map(([name, n]) => (
                  <span key={name} className="rounded-full bg-white/10 px-3 py-1 text-xs">
                    {name} · {n}
                  </span>
                ))}
              </div>
              <Link
                to={`/approvals/${waiting[0].id}`}
                className="flex h-12 items-center justify-center gap-2 rounded-2xl bg-gold-400 font-bold text-primary-900 transition hover:bg-gold-100"
              >
                <PenLine className="h-5 w-5" />
                {waiting.length > 1 ? 'ابدأ بالأقدم' : 'افتح الطلب'}
              </Link>
            </section>
          ) : (
            <section className="flex items-center gap-4 rounded-3xl border border-gray-200 bg-white p-5" data-testid="home-pending">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700">
                <CheckCheck className="h-6 w-6" />
              </span>
              <div>
                <p className="font-bold text-gray-900">لا شيء بانتظار قرارك</p>
                <p className="text-sm text-gray-500">كل الطلبات الموجهة إليك تم البت فيها.</p>
              </div>
            </section>
          )}

          {/* اختصارات */}
          <nav aria-label="اختصارات" className="grid grid-cols-4 gap-3 lg:grid-cols-2">
            <Shortcut to="/mail/compose" icon={Mail} label="رسالة جديدة" />
            <Shortcut to="/approvals?new=1" icon={FilePlus2} label="طلب جديد" />
            <Shortcut to={canPublish ? '/announcements/new' : '/announcements'} icon={Megaphone} label={canPublish ? 'تعميم جديد' : 'التعاميم'} />
            <Shortcut to="/search" icon={Search} label="بحث" />
          </nav>
        </div>

        {/* اليوم */}
        <section aria-label="اليوم" className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-bold text-gray-900">اليوم</h2>
            {items.length === MAX_ITEMS && <span className="text-xs text-gray-500">آخر {MAX_ITEMS}</span>}
          </div>
          {loading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-[68px] animate-pulse rounded-2xl bg-white" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-2xl bg-white p-8 text-center" data-testid="home-empty">
              <Sun className="h-8 w-8 text-gold-500" />
              <p className="font-semibold text-gray-900">كل شيء مقروء</p>
              <p className="text-sm text-gray-500">لا رسائل جديدة ولا تعاميم تنتظر إقرارك.</p>
            </div>
          ) : (
            <ul className="space-y-2" data-testid="home-today">
              {items.map((it) => {
                const tone = TONE[it.kind];
                const Icon = tone.icon;
                return (
                  <li key={`${it.kind}-${it.id}`} className="flex items-center gap-3 rounded-2xl bg-white px-4 py-3 transition hover:shadow-sm">
                    <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl', tone.chip)}>
                      <Icon className="h-5 w-5" />
                    </span>
                    <Link to={link(it)} className="min-w-0 flex-1">
                      <span className={cn('block truncate text-[15px] text-gray-900', it.kind === 'mail' ? 'font-bold' : 'font-semibold')}>
                        {it.title}
                      </span>
                      <span className="block truncate text-xs text-gray-500">{it.sub}</span>
                    </Link>
                    {it.kind === 'announcement' && it.ack ? (
                      <button
                        type="button"
                        onClick={() => ack.mutate(it.id, { onError: () => navigate(link(it)) })}
                        disabled={ack.isPending}
                        className="rounded-xl border border-emerald-200 px-3 py-1.5 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                      >
                        أقرّ
                      </button>
                    ) : (
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <span className="text-xs text-gray-500">{shortDate(it.at)}</span>
                        {it.kind === 'request' ? (
                          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', it.late ? 'bg-orange-50 text-orange-800' : 'bg-gold-50 text-gold-700')}>
                            {it.late ? 'متأخر' : 'يحتاج قرارك'}
                          </span>
                        ) : it.kind === 'mail' ? (
                          <span aria-label="غير مقروءة" className="h-2.5 w-2.5 rounded-full bg-primary-700" />
                        ) : (
                          <ChevronLeft className="h-4 w-4 text-gray-400" />
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Shortcut({ to, icon: Icon, label }: { to: string; icon: LucideIcon; label: string }) {
  return (
    <Link
      to={to}
      className="flex flex-col items-center gap-2 rounded-2xl border border-gray-200 bg-white p-3 text-center text-xs font-semibold text-gray-800 transition hover:border-primary-200 hover:bg-primary-50 lg:flex-row lg:text-sm"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-700">
        <Icon className="h-5 w-5" />
      </span>
      {label}
    </Link>
  );
}
