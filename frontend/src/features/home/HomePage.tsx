/**
 * الرئيسية — «لوحة اليوم الملونة» (قرار المستخدم 2026-11-27: كالتصميم تمامًا):
 * أربع بطاقات ملونة (متأخر، تنبيهات، رسائل مهمة، تم اليوم)، و«اليوم» بفلاتر
 * ملونة، وبطاقة «طلبات بانتظار توقيعك»، و«مهلة الرد». كل الأرقام من بيانات
 * المستخدم نفسه عبر نفس الـAPI (لا endpoint جديد).
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Clock, PenLine, Star } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import { approvalsApi, type ApprovalRequest } from '../approvals/api';
import { correspondenceApi, type CorrespondenceSummary } from '../correspondence/api';
import { announcementsApi, type Announcement } from '../announcements/api';
import { cn } from '../../shared/lib/cn';

const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const DAY_MS = 86400000;
const LATE_MS = 2 * DAY_MS;
const AVATARS = ['#13294B', '#0E7490', '#B45309', '#BE185D', '#4338CA', '#047857', '#9333EA'];

type Kind = 'late' | 'alert' | 'important' | 'done';
const KINDS: Record<Kind, { solid: string; soft: string; ink: string; wash: string; label: string }> = {
  late: { solid: '#E11D48', soft: '#FFE4E6', ink: '#9F1239', wash: '#FFF1F2', label: 'متأخر' },
  alert: { solid: '#B45309', soft: '#FEF3C7', ink: '#92400E', wash: '#FFFBEB', label: 'تنبيهات' },
  important: { solid: '#7C3AED', soft: '#EDE9FE', ink: '#5B21B6', wash: '#F5F3FF', label: 'مهم' },
  done: { solid: '#059669', soft: '#D1FAE5', ink: '#065F46', wash: '#ECFDF5', label: 'تم' },
};

interface Item {
  key: string;
  kind: Kind;
  at: string;
  title: string;
  sub: string;
  who: string;
  tag: string;
  to: string;
  ackId?: string;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'صباح الخير';
  if (h < 18) return 'مساء النور';
  return 'مساء الخير';
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  // «العتيبي» ← ع لا ا
  const first = (w: string) => (w.startsWith('ال') && w.length > 3 ? w[2] : w[0]);
  return parts.length > 1 ? `${first(parts[0])}${first(parts[1])}` : (parts[0] ?? '؟').slice(0, 2);
}

function avatarColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATARS[h % AVATARS.length];
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function ago(iso: string): string {
  const d = new Date(iso);
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / DAY_MS);
  if (days <= 0) {
    const h = d.getHours() % 12 || 12;
    return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'ص' : 'م'}`;
  }
  if (days === 1) return 'أمس';
  if (days === 2) return 'منذ يومين';
  if (days < 11) return `منذ ${days} أيام`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** أيام حتى الموعد (سالب = فات). */
function daysLeft(iso: string): number {
  return Math.round((startOfDay(new Date(iso)) - startOfDay(new Date())) / DAY_MS);
}

function requestTitle(r: ApprovalRequest): string {
  if (r.title) return r.workflow_name ? r.title.replace(`${r.workflow_name}: `, '') : r.title;
  return r.correspondence.reference_number ?? 'طلب اعتماد';
}

function decidedTodayByMe(r: ApprovalRequest, meId: string): boolean {
  const today = startOfDay(new Date());
  return r.steps.some((s) =>
    s.approvers.some((a) => a.decision && a.decision.approver.id === meId && new Date(a.decision.decided_at).getTime() >= today),
  );
}

export function HomePage() {
  const { user } = useAuth();
  const meId = user ? String(user.id) : '';
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Kind | 'all'>('all');

  const pending = useQuery({ queryKey: ['approvals', 'pending_mine'], queryFn: () => approvalsApi.list('pending_mine') });
  const received = useQuery({ queryKey: ['approvals', 'received'], queryFn: () => approvalsApi.list('received') });
  const inbox = useQuery({ queryKey: ['home', 'inbox'], queryFn: () => correspondenceApi.list({ folder: 'inbox', page: 1 }) });
  const important = useQuery({ queryKey: ['home', 'important'], queryFn: () => correspondenceApi.list({ folder: 'important', page: 1 }) });
  const replies = useQuery({ queryKey: ['home', 'pending_replies'], queryFn: () => correspondenceApi.list({ folder: 'pending_replies', page: 1 }) });
  const anns = useQuery({ queryKey: ['home', 'announcements-pending'], queryFn: () => announcementsApi.list('received', 1, true) });

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
  const lateRequests = waiting.filter((r) => now - new Date(r.created_at).getTime() > LATE_MS);
  const replyRows: CorrespondenceSummary[] = (replies.data?.results ?? []).filter((m) => m.due_date);
  const overdueReplies = replyRows.filter((m) => daysLeft(m.due_date!) < 0);
  const doneToday = (received.data ?? []).filter((r) => decidedTodayByMe(r, meId));
  const importantRows = important.data?.results ?? [];
  const ackRows: Announcement[] = anns.data?.results ?? [];

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const seen = new Set<string>();
    const push = (it: Item) => {
      if (seen.has(it.key)) return;
      seen.add(it.key);
      out.push(it);
    };
    for (const r of waiting) {
      const late = now - new Date(r.created_at).getTime() > LATE_MS;
      push({
        key: `r-${r.id}`,
        kind: late ? 'late' : 'alert',
        at: r.created_at,
        title: requestTitle(r),
        sub: `${r.workflow_name || 'طلب اعتماد'} · من ${r.requested_by.full_name}`,
        who: r.requested_by.full_name,
        tag: late ? 'متأخر' : 'يحتاج توقيعك',
        to: `/approvals/${r.id}`,
      });
    }
    for (const m of overdueReplies) {
      push({
        key: `m-${m.id}`, kind: 'late', at: m.sent_at || m.created_at, title: m.subject || '(بلا عنوان)',
        sub: `مراسلة · فات موعد الرد`, who: m.sender.full_name, tag: 'متأخر', to: `/mail/inbox/${m.id}`,
      });
    }
    for (const a of ackRows) {
      push({
        key: `a-${a.id}`, kind: 'alert', at: a.published_at || a.created_at, title: a.content?.title || 'تعميم',
        sub: a.ack_due_at ? `تعميم · الإقرار قبل ${DAYS[new Date(a.ack_due_at).getDay()]}` : `تعميم · من ${a.publisher.full_name}`,
        who: a.publisher.full_name, tag: 'تنبيه', to: `/announcements/${a.id}`, ackId: a.requires_ack ? a.id : undefined,
      });
    }
    for (const m of importantRows.slice(0, 6)) {
      push({
        key: `m-${m.id}`, kind: 'important', at: m.sent_at || m.created_at, title: m.subject || '(بلا عنوان)',
        sub: `مراسلة · من ${m.sender.full_name}`, who: m.sender.full_name, tag: 'مهمة', to: `/mail/important/${m.id}`,
      });
    }
    for (const m of (inbox.data?.results ?? []).filter((x) => !x.read_at).slice(0, 6)) {
      push({
        key: `m-${m.id}`, kind: 'alert', at: m.sent_at || m.created_at, title: m.subject || '(بلا عنوان)',
        sub: `مراسلة · من ${m.sender.full_name}`, who: m.sender.full_name, tag: 'جديدة', to: `/mail/inbox/${m.id}`,
      });
    }
    for (const r of doneToday) {
      push({
        key: `d-${r.id}`, kind: 'done', at: r.decided_at || r.created_at, title: requestTitle(r),
        sub: `${r.workflow_name || 'طلب اعتماد'} · ${r.signable ? 'تم التوقيع' : 'تم القرار'}`,
        who: r.requested_by.full_name, tag: 'تم', to: `/approvals/${r.id}`,
      });
    }
    const order: Record<Kind, number> = { late: 0, alert: 1, important: 2, done: 3 };
    return out.sort((a, b) => order[a.kind] - order[b.kind] || b.at.localeCompare(a.at));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.data, received.data, inbox.data, important.data, replies.data, anns.data]);

  const count = (k: Kind) => items.filter((i) => i.kind === k).length;
  const shown = filter === 'all' ? items : items.filter((i) => i.kind === filter);
  const loading = pending.isLoading || inbox.isLoading || anns.isLoading;

  const lateCount = lateRequests.length + overdueReplies.length;
  const firstLate = lateRequests[0];
  const nextAck = ackRows.find((a) => a.ack_due_at);
  const importantSenders = [...new Set(importantRows.map((m) => m.sender.full_name.split(/\s+/)[0]))].slice(0, 2);

  // مهلة الرد: ردود لها موعد، وإقرار تعاميم لها موعد، وطلبات تأخرت.
  const deadlines = [
    ...replyRows.map((m) => ({ key: `m-${m.id}`, title: m.subject || '(بلا عنوان)', left: daysLeft(m.due_date!), to: `/mail/inbox/${m.id}` })),
    ...ackRows.filter((a) => a.ack_due_at).map((a) => ({
      key: `a-${a.id}`, title: `إقرار ${a.content?.title || 'تعميم'}`, left: daysLeft(a.ack_due_at!), to: `/announcements/${a.id}`,
    })),
    ...lateRequests.map((r) => ({
      key: `r-${r.id}`, title: requestTitle(r), left: -Math.max(0, Math.floor((now - new Date(r.created_at).getTime()) / DAY_MS) - 2),
      to: `/approvals/${r.id}`,
    })),
  ]
    .sort((a, b) => a.left - b.left)
    .slice(0, 5);

  const d = new Date();
  const firstName = (user?.full_name ?? '').trim().split(/\s+/)[0] || user?.username;

  return (
    <div className="-m-4 min-h-[calc(100%+2rem)] bg-[#F5F3FF] p-4 md:-m-6 md:min-h-[calc(100%+3rem)] md:p-6" data-testid="home">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="home-rise">
          <p className="text-sm text-[#5B5F73]">
            {DAYS[d.getDay()]}، {d.getDate()} {MONTHS[d.getMonth()]}
          </p>
          <h1 className="text-[28px] font-bold text-[#16202E]">
            {greeting()}، {firstName}
          </h1>
        </header>

        {/* ملخص اليوم */}
        <section aria-label="ملخص اليوم" className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
          <StatCard
            to={firstLate ? `/approvals/${firstLate.id}` : '/approvals'}
            bg="#E11D48" fg="#FFFFFF" subFg="#FFE4E6" icon={Clock} label="متأخر" value={lateCount}
            sub={firstLate ? `${requestTitle(firstLate)} — ${ago(firstLate.created_at)}` : lateCount ? 'مراسلات فات موعد ردها' : 'لا شيء متأخر'}
            pulse={lateCount > 0} delay={0}
          />
          <StatCard
            to="/announcements" bg="#F59E0B" fg="#1F1300" subFg="#1F1300" icon={AlertTriangle} label="تنبيهات" value={ackRows.length}
            sub={nextAck ? `إقرار تعميم قبل ${DAYS[new Date(nextAck.ack_due_at!).getDay()]}` : ackRows.length ? 'تعاميم بانتظار إقرارك' : 'لا تعاميم بانتظارك'}
            delay={0.12}
          />
          <StatCard
            to="/mail/important" bg="#7C3AED" fg="#FFFFFF" subFg="#EDE9FE" icon={Star} label="رسائل مهمة"
            value={important.data?.count ?? 0}
            sub={importantSenders.length ? `من ${importantSenders.join(' و')}` : 'علّم رسالة كمهمة لتظهر هنا'}
            delay={0.19}
          />
          <StatCard
            to="/approvals" bg="#059669" fg="#FFFFFF" subFg="#D1FAE5" icon={Check} label="تم اليوم" value={doneToday.length}
            sub="موافقات وتوقيعات" delay={0.26}
          />
        </section>

        <div className="flex flex-wrap items-start gap-[22px]">
          {/* اليوم */}
          <section aria-label="اليوم" className="home-rise min-w-0 flex-[2_1_520px] space-y-3.5 rounded-3xl bg-white p-5" style={{ animationDelay: '.3s' }}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-bold text-[#16202E]">اليوم</h2>
              <div role="group" aria-label="تصفية" className="flex flex-wrap gap-2" data-testid="home-filters">
                <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} label="الكل" count={items.length}
                  solid="#13294B" soft="#E0E7FF" ink="#13294B" />
                {(Object.keys(KINDS) as Kind[]).map((k) => (
                  <FilterChip key={k} active={filter === k} onClick={() => setFilter(k)} count={count(k)} {...KINDS[k]} />
                ))}
              </div>
            </div>

            {loading ? (
              <div className="space-y-2.5">
                {[0, 1, 2].map((i) => <div key={i} className="h-[76px] animate-pulse rounded-[18px] bg-[#F5F3FF]" />)}
              </div>
            ) : shown.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-[18px] bg-[#ECFDF5] p-8 text-center" data-testid="home-empty">
                <Check className="h-8 w-8 text-[#059669]" />
                <p className="font-bold text-[#065F46]">{filter === 'all' ? 'لا شيء ينتظرك الآن' : 'لا عناصر هنا'}</p>
                <p className="text-sm text-[#5B5F73]">لا طلبات ولا رسائل جديدة ولا تعاميم تنتظر إقرارك.</p>
              </div>
            ) : (
              <ul className="space-y-2.5" data-testid="home-today">
                {shown.map((it, i) => {
                  const k = KINDS[it.kind];
                  return (
                    <li key={it.key} className="home-rise home-lift flex items-center gap-3.5 rounded-[18px] p-3.5"
                      style={{ background: k.wash, animationDelay: `${(0.36 + i * 0.05).toFixed(2)}s` }}>
                      <span className="relative h-12 w-12 shrink-0">
                        <span className="flex h-12 w-12 items-center justify-center rounded-full text-[15px] font-bold text-white"
                          style={{ background: avatarColor(it.who) }}>
                          {initials(it.who)}
                        </span>
                        <span className="absolute -bottom-[3px] -left-[3px] h-[22px] w-[22px] rounded-full border-[2.5px] border-white"
                          style={{ background: k.solid }} />
                      </span>
                      <Link to={it.to} className="flex min-w-0 flex-1 flex-col gap-0.5 text-[#16202E]">
                        <span className="truncate text-[15.5px] font-bold">{it.title}</span>
                        <span className="truncate text-[13px] text-[#5B5F73]">{it.sub}</span>
                      </Link>
                      <span className="hidden shrink-0 text-[12.5px] text-[#5B5F73] sm:inline">{ago(it.at)}</span>
                      {it.ackId ? (
                        <button type="button" disabled={ack.isPending}
                          onClick={() => ack.mutate(it.ackId!, { onError: () => navigate(it.to) })}
                          className="flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60"
                          style={{ background: k.solid }}>
                          أقرّ
                        </button>
                      ) : (
                        <span className="flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold text-white"
                          style={{ background: k.solid }}>
                          {it.kind === 'late' && <span aria-hidden="true" className="home-blink h-[7px] w-[7px] rounded-full bg-white" />}
                          {it.tag}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-[22px]">
            {/* بانتظار توقيعك */}
            <section aria-label="بانتظار قرارك" data-testid="home-pending"
              className="home-rise relative flex flex-col gap-3.5 overflow-hidden rounded-3xl bg-[#13294B] p-5 text-white" style={{ animationDelay: '.38s' }}>
              <Envelopes />
              <div className="flex items-baseline gap-2">
                <span className="text-[44px] font-bold leading-none text-[#D4A94E]">{waiting.length}</span>
                <span className="text-base font-semibold">
                  {waiting.length ? 'طلبات بانتظار توقيعك' : 'لا طلبات بانتظار توقيعك'}
                </span>
              </div>
              {waiting.length > 0 ? (
                <Link to={`/approvals/${waiting[0].id}`}
                  className="flex h-[50px] items-center justify-center gap-2 rounded-2xl bg-[#D4A94E] font-bold text-[#13294B] transition hover:brightness-105">
                  <PenLine className="h-5 w-5" />
                  {waiting.length > 1 ? 'ابدأ التوقيع بالأقدم' : 'ابدأ التوقيع'}
                </Link>
              ) : (
                <Link to="/approvals?new=1"
                  className="flex h-[50px] items-center justify-center gap-2 rounded-2xl bg-white/10 font-bold text-white transition hover:bg-white/15">
                  طلب جديد
                </Link>
              )}
            </section>

            {/* مهلة الرد */}
            <section aria-label="مهلة الرد" className="home-rise space-y-3.5 rounded-3xl bg-white p-5" style={{ animationDelay: '.46s' }}>
              <h2 className="text-[17px] font-bold text-[#16202E]">مهلة الرد</h2>
              {deadlines.length === 0 ? (
                <p className="text-sm text-[#5B5F73]">لا مواعيد قريبة.</p>
              ) : (
                deadlines.map((x, i) => {
                  const over = x.left < 0;
                  const soon = !over && x.left <= 3;
                  const tone = over ? { bar: '#E11D48', track: '#FFE4E6', ink: '#9F1239' }
                    : soon ? { bar: '#F59E0B', track: '#FEF3C7', ink: '#92400E' }
                      : { bar: '#7C3AED', track: '#EDE9FE', ink: '#5B21B6' };
                  const pct = over ? 100 : Math.max(12, Math.round(((7 - Math.min(x.left, 7)) / 7) * 100));
                  const label = over ? `تجاوز +${-x.left} يوم` : x.left === 0 ? 'اليوم' : x.left === 1 ? 'باقي يوم' : `باقي ${x.left} أيام`;
                  return (
                    <Link key={x.key} to={x.to} className="block space-y-1.5">
                      <span className="flex justify-between gap-3 text-[13px]">
                        <span className="truncate font-semibold text-[#16202E]">{x.title}</span>
                        <span className="shrink-0 font-bold" style={{ color: tone.ink }}>{label}</span>
                      </span>
                      <span className="flex h-2.5 overflow-hidden rounded-full" style={{ background: tone.track }}>
                        <span className="home-fill rounded-full" style={{ width: `${pct}%`, background: tone.bar, animationDelay: `${i * 0.15}s` }} />
                      </span>
                    </Link>
                  );
                })
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ to, bg, fg, subFg, icon: Icon, label, value, sub, pulse, delay }: {
  to: string; bg: string; fg: string; subFg: string; icon: LucideIcon; label: string; value: number; sub: string; pulse?: boolean; delay: number;
}) {
  return (
    <Link to={to} className={cn('home-rise home-lift flex min-w-0 flex-col gap-2 rounded-[22px] p-[18px]', pulse && 'home-pulse')}
      style={{ background: bg, color: fg, animationDelay: `${delay}s` }} data-testid="home-stat">
      <span className="flex items-center justify-between">
        <span className="text-sm font-semibold">{label}</span>
        <Icon className="h-[22px] w-[22px]" />
      </span>
      <span className="text-[40px] font-bold leading-none">{value}</span>
      <span className="truncate text-[13px]" style={{ color: subFg }}>{sub}</span>
    </Link>
  );
}

function FilterChip({ active, onClick, label, count, solid, soft, ink }: {
  active: boolean; onClick: () => void; label: string; count: number; solid: string; soft: string; ink: string;
}) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}
      className={cn('flex h-10 items-center gap-1.5 rounded-full px-3.5 text-[13.5px]', active ? 'font-bold text-white' : 'font-semibold')}
      style={active ? { background: solid } : { background: soft, color: ink }}>
      {!active && <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: solid }} />}
      {label}
      {active && <span className="rounded-full bg-white/25 px-[7px] py-px text-[11.5px]">{count}</span>}
    </button>
  );
}

function Envelopes() {
  return (
    <svg aria-hidden="true" width="150" height="104" viewBox="0 0 128 92" className="self-center">
      <g className="home-floaty2">
        <rect x="62" y="10" width="54" height="40" rx="8" fill="#8B5CF6" />
        <path d="M62 16l27 18 27-18" fill="none" stroke="#EDE9FE" strokeWidth="3" strokeLinejoin="round" />
      </g>
      <g className="home-floaty">
        <rect x="14" y="30" width="62" height="46" rx="9" fill="#FFFFFF" />
        <path d="M14 37l31 21 31-21" fill="none" stroke="#D4A94E" strokeWidth="3.5" strokeLinejoin="round" />
        <circle cx="72" cy="32" r="9" fill="#F43F5E" />
        <path d="M72 28v5M72 36v.5" stroke="#FFFFFF" strokeWidth="2.5" strokeLinecap="round" />
      </g>
      <circle cx="112" cy="70" r="7" fill="#F59E0B" />
      <circle cx="8" cy="18" r="4" fill="#2DD4BF" />
    </svg>
  );
}
