/**
 * الرئيسية — «لوحة اليوم الملونة» (قرار المستخدم 2026-11-27، نفس الموقع):
 * أربع بطاقات ملونة (متأخر، تنبيهات، رسائل مهمة، تم اليوم)، وبطاقة كحلية
 * «طلبات بانتظار توقيعك»، و«اليوم» بفلاتر ملونة، و«مهلة الرد».
 * في المظهر الليلي تبقى ألوان البطاقات وتصير الأرضية والقوائم داكنة.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Path, Rect } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/Text';
import { IconName, T, success, tap } from '@/components/ui';
import { api } from '@/lib/api';
import { approvalsApi, requestTitle, type ApprovalRequest } from '@/lib/approvals';
import { useAuth } from '@/lib/auth';
import { announcementsApi, type Announcement } from '@/lib/chat';
import { colors, isDark, row } from '@/lib/theme';
import type { MailSummary, Page } from '@/lib/types';

const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const DAY_MS = 86400000;
const LATE_MS = 2 * DAY_MS;
const AVATARS = ['#13294B', '#0E7490', '#B45309', '#BE185D', '#4338CA', '#047857', '#9333EA'];
const NAVY = '#13294B';
const GOLD = '#D4A94E';
const PAGE_BG = isDark ? colors.bg : '#F5F3FF';
const SURFACE = isDark ? colors.card : '#FFFFFF';
const INK = isDark ? colors.text : '#16202E';
const MUTED = isDark ? colors.textSoft : '#5B5F73';

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
  go: () => void;
  ackId?: string;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'صباح الخير';
  if (h < 18) return 'مساء النور';
  return 'مساء الخير';
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
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

function daysLeft(iso: string): number {
  return Math.round((startOfDay(new Date(iso)) - startOfDay(new Date())) / DAY_MS);
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [pending, setPending] = useState<ApprovalRequest[] | null>(null);
  const [received, setReceived] = useState<ApprovalRequest[]>([]);
  const [inbox, setInbox] = useState<MailSummary[]>([]);
  const [important, setImportant] = useState<Page<MailSummary> | null>(null);
  const [replies, setReplies] = useState<MailSummary[]>([]);
  const [anns, setAnns] = useState<Announcement[]>([]);
  const [notes, setNotes] = useState(0);
  const [filter, setFilter] = useState<Kind | 'all'>('all');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const mail = (folder: string) => api<Page<MailSummary>>(`/correspondences/?folder=${folder}&page=1`);
    await Promise.all([
      approvalsApi.list('pending_mine').then(setPending).catch(() => setPending((p) => p ?? [])),
      approvalsApi.list('received').then(setReceived).catch(() => undefined),
      mail('inbox').then((p) => setInbox(p.results)).catch(() => undefined),
      mail('important').then(setImportant).catch(() => undefined),
      mail('pending_replies').then((p) => setReplies(p.results)).catch(() => undefined),
      announcementsApi.received(true).then((p) => setAnns(p.results)).catch(() => undefined),
      api<{ unread: number }>('/notifications/unread-count/').then((c) => setNotes(c.unread)).catch(() => undefined),
    ]);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const now = Date.now();
  const waiting = (pending ?? []).filter((r) => r.status === 'pending').sort((a, b) => a.created_at.localeCompare(b.created_at));
  const lateRequests = waiting.filter((r) => now - new Date(r.created_at).getTime() > LATE_MS);
  const replyRows = replies.filter((m) => m.due_date);
  const overdueReplies = replyRows.filter((m) => daysLeft(m.due_date!) < 0);
  const today = startOfDay(new Date());
  const doneToday = received.filter((r) =>
    r.steps.some((s) => s.approvers.some((a) => a.user.id === user?.id && a.decision && new Date(a.decision.decided_at).getTime() >= today)),
  );
  const importantRows = important?.results ?? [];

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const seen = new Set<string>();
    const push = (it: Item) => {
      if (!seen.has(it.key)) {
        seen.add(it.key);
        out.push(it);
      }
    };
    for (const r of waiting) {
      const late = now - new Date(r.created_at).getTime() > LATE_MS;
      push({
        key: `r-${r.id}`, kind: late ? 'late' : 'alert', at: r.created_at, title: requestTitle(r),
        sub: `${r.workflow_name || 'طلب اعتماد'} · من ${r.requested_by.full_name}`, who: r.requested_by.full_name,
        tag: late ? 'متأخر' : 'توقيعك', go: () => router.push(`/approvals/${r.id}`),
      });
    }
    for (const m of overdueReplies) {
      push({
        key: `m-${m.id}`, kind: 'late', at: m.sent_at || m.created_at, title: m.subject || '(بلا عنوان)',
        sub: 'مراسلة · فات موعد الرد', who: m.sender.full_name, tag: 'متأخر', go: () => router.push(`/mail/${m.id}`),
      });
    }
    for (const a of anns) {
      push({
        key: `a-${a.id}`, kind: 'alert', at: a.published_at || '', title: a.content?.title || 'تعميم',
        sub: a.ack_due_at ? `تعميم · الإقرار قبل ${DAYS[new Date(a.ack_due_at).getDay()]}` : `تعميم · من ${a.publisher.full_name}`,
        who: a.publisher.full_name, tag: 'تنبيه', go: () => router.push(`/announcements/${a.id}`),
        ackId: a.requires_ack && !a.mine?.observer ? a.id : undefined,
      });
    }
    for (const m of importantRows.slice(0, 6)) {
      push({
        key: `m-${m.id}`, kind: 'important', at: m.sent_at || m.created_at, title: m.subject || '(بلا عنوان)',
        sub: `مراسلة · من ${m.sender.full_name}`, who: m.sender.full_name, tag: 'مهمة', go: () => router.push(`/mail/${m.id}`),
      });
    }
    for (const m of inbox.filter((x) => !x.read_at).slice(0, 6)) {
      push({
        key: `m-${m.id}`, kind: 'alert', at: m.sent_at || m.created_at, title: m.subject || '(بلا عنوان)',
        sub: `مراسلة · من ${m.sender.full_name}`, who: m.sender.full_name, tag: 'جديدة', go: () => router.push(`/mail/${m.id}`),
      });
    }
    for (const r of doneToday) {
      push({
        key: `d-${r.id}`, kind: 'done', at: r.decided_at || r.created_at, title: requestTitle(r),
        sub: `${r.workflow_name || 'طلب اعتماد'} · ${r.signable ? 'تم التوقيع' : 'تم القرار'}`, who: r.requested_by.full_name,
        tag: 'تم', go: () => router.push(`/approvals/${r.id}`),
      });
    }
    const order: Record<Kind, number> = { late: 0, alert: 1, important: 2, done: 3 };
    return out.sort((a, b) => order[a.kind] - order[b.kind] || b.at.localeCompare(a.at));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, received, inbox, important, replies, anns]);

  const shown = filter === 'all' ? items : items.filter((i) => i.kind === filter);
  const count = (k: Kind) => items.filter((i) => i.kind === k).length;
  const lateCount = lateRequests.length + overdueReplies.length;
  const firstLate = lateRequests[0];
  const nextAck = anns.find((a) => a.ack_due_at);
  const senders = [...new Set(importantRows.map((m) => m.sender.full_name.split(/\s+/)[0]))].slice(0, 2);

  const deadlines = [
    ...replyRows.map((m) => ({ key: `m-${m.id}`, title: m.subject || '(بلا عنوان)', left: daysLeft(m.due_date!), go: () => router.push(`/mail/${m.id}`) })),
    ...anns.filter((a) => a.ack_due_at).map((a) => ({
      key: `a-${a.id}`, title: `إقرار ${a.content?.title || 'تعميم'}`, left: daysLeft(a.ack_due_at!), go: () => router.push(`/announcements/${a.id}`),
    })),
    ...lateRequests.map((r) => ({
      key: `r-${r.id}`, title: requestTitle(r), left: -Math.max(0, Math.floor((now - new Date(r.created_at).getTime()) / DAY_MS) - 2),
      go: () => router.push(`/approvals/${r.id}`),
    })),
  ]
    .sort((a, b) => a.left - b.left)
    .slice(0, 5);

  const acknowledge = async (id: string) => {
    tap();
    try {
      await announcementsApi.ack(id);
      success();
      setAnns((list) => list.filter((a) => a.id !== id));
    } catch {
      router.push(`/announcements/${id}`);
    }
  };

  const d = new Date();
  const name = (user?.full_name ?? '').trim();
  const firstName = name.split(/\s+/)[0] || user?.username;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: PAGE_BG }}
      contentContainerStyle={{ paddingTop: insets.top + 14, paddingHorizontal: 16, paddingBottom: 32, gap: 18 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={NAVY} />}
    >
      {/* التحية */}
      <View style={{ flexDirection: row, alignItems: 'center', gap: 12 }}>
        <View style={{ flex: 1 }}>
          <T style={{ fontSize: 13, color: MUTED }}>
            {DAYS[d.getDay()]}، {d.getDate()} {MONTHS[d.getMonth()]}
          </T>
          <T style={{ fontSize: 22, fontWeight: '700', color: INK }} numberOfLines={1}>
            {greeting()}، {firstName}
          </T>
        </View>
        <Pressable
          onPress={() => {
            tap();
            router.push('/notifications');
          }}
          style={styles.bell}
          accessibilityLabel={notes ? `الإشعارات، ${notes} جديد` : 'الإشعارات'}
        >
          <Ionicons name="notifications-outline" size={22} color="#B45309" />
          {notes > 0 && (
            <View style={styles.bellBadge}>
              <Text style={{ color: '#fff', fontSize: 10.5, fontWeight: '700' }}>{notes > 99 ? '99+' : notes}</Text>
            </View>
          )}
        </Pressable>
        <Pressable onPress={() => router.push('/account')} accessibilityLabel="حسابي"
          style={[styles.avatar, { backgroundColor: avatarColor(name || 'x') }]}>
          <Text style={{ color: '#fff', fontWeight: '700' }}>{initialsOf(name || user?.username || '؟')}</Text>
        </Pressable>
      </View>

      {/* البطاقات الأربع */}
      <View style={{ flexDirection: row, flexWrap: 'wrap', gap: 12 }}>
        <Stat bg="#E11D48" fg="#fff" subFg="#FFE4E6" icon="time-outline" label="متأخر" value={lateCount}
          sub={firstLate ? `${requestTitle(firstLate)} — ${ago(firstLate.created_at)}` : lateCount ? 'مراسلات فات موعد ردها' : 'لا شيء متأخر'}
          onPress={() => router.push(firstLate ? `/approvals/${firstLate.id}` : '/approvals')} />
        <Stat bg="#F59E0B" fg="#1F1300" subFg="#1F1300" icon="warning-outline" label="تنبيهات" value={anns.length}
          sub={nextAck ? `إقرار تعميم قبل ${DAYS[new Date(nextAck.ack_due_at!).getDay()]}` : anns.length ? 'تعاميم بانتظار إقرارك' : 'لا تعاميم بانتظارك'}
          onPress={() => router.push('/announcements')} />
        <Stat bg="#7C3AED" fg="#fff" subFg="#EDE9FE" icon="star" label="رسائل مهمة" value={important?.count ?? 0}
          sub={senders.length ? `من ${senders.join(' و')}` : 'علّم رسالة كمهمة'}
          onPress={() => router.push('/inbox')} />
        <Stat bg="#059669" fg="#fff" subFg="#D1FAE5" icon="checkmark" label="تم اليوم" value={doneToday.length}
          sub="موافقات وتوقيعات" onPress={() => router.push('/approvals')} />
      </View>

      {/* بانتظار توقيعك */}
      <View style={styles.navyCard}>
        <Svg width={150} height={104} viewBox="0 0 128 92" style={{ alignSelf: 'center' }}>
          <G rotation={8} origin="89, 30">
            <Rect x={62} y={10} width={54} height={40} rx={8} fill="#8B5CF6" />
            <Path d="M62 16l27 18 27-18" fill="none" stroke="#EDE9FE" strokeWidth={3} strokeLinejoin="round" />
          </G>
          <G rotation={-6} origin="45, 53">
            <Rect x={14} y={30} width={62} height={46} rx={9} fill="#FFFFFF" />
            <Path d="M14 37l31 21 31-21" fill="none" stroke={GOLD} strokeWidth={3.5} strokeLinejoin="round" />
            <Circle cx={72} cy={32} r={9} fill="#F43F5E" />
            <Path d="M72 28v5M72 36v.5" stroke="#FFFFFF" strokeWidth={2.5} strokeLinecap="round" />
          </G>
          <Circle cx={112} cy={70} r={7} fill="#F59E0B" />
          <Circle cx={8} cy={18} r={4} fill="#2DD4BF" />
        </Svg>
        <View style={{ flexDirection: row, alignItems: 'baseline', gap: 8 }}>
          <Text style={{ fontSize: 44, fontWeight: '700', color: GOLD, lineHeight: 52 }}>{pending === null ? '…' : waiting.length}</Text>
          <Text style={{ fontSize: 16, fontWeight: '600', color: '#fff' }}>
            {waiting.length ? 'طلبات بانتظار توقيعك' : 'لا طلبات بانتظار توقيعك'}
          </Text>
        </View>
        <Pressable
          onPress={() => {
            tap();
            router.push(waiting.length ? `/approvals/${waiting[0].id}` : '/approvals/new');
          }}
          style={({ pressed }) => [styles.cta, { flexDirection: row }, !waiting.length && { backgroundColor: 'rgba(255,255,255,0.12)' }, pressed && { opacity: 0.85 }]}
        >
          <Ionicons name={waiting.length ? 'create-outline' : 'add'} size={20} color={waiting.length ? NAVY : '#fff'} />
          <Text style={{ fontSize: 16, fontWeight: '700', color: waiting.length ? NAVY : '#fff' }}>
            {waiting.length > 1 ? 'ابدأ التوقيع بالأقدم' : waiting.length ? 'ابدأ التوقيع' : 'طلب جديد'}
          </Text>
        </Pressable>
      </View>

      {/* اليوم */}
      <View style={[styles.panel, { gap: 12 }]}>
        <T style={{ fontSize: 19, fontWeight: '700', color: INK }}>اليوم</T>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, flexDirection: row }}>
          <Chip active={filter === 'all'} onPress={() => setFilter('all')} label="الكل" count={items.length} solid={NAVY} soft="#E0E7FF" ink={NAVY} />
          {(Object.keys(KINDS) as Kind[]).map((k) => (
            <Chip key={k} active={filter === k} onPress={() => setFilter(k)} count={count(k)} {...KINDS[k]} />
          ))}
        </ScrollView>
        {pending === null ? null : shown.length === 0 ? (
          <View style={[styles.empty, { backgroundColor: isDark ? colors.successSoft : '#ECFDF5' }]}>
            <Ionicons name="checkmark-done" size={30} color="#059669" />
            <T style={{ fontSize: 15, fontWeight: '700', color: isDark ? colors.successText : '#065F46', textAlign: 'center' }}>
              {filter === 'all' ? 'لا شيء ينتظرك الآن' : 'لا عناصر هنا'}
            </T>
          </View>
        ) : (
          shown.map((it) => {
            const k = KINDS[it.kind];
            return (
              <Pressable
                key={it.key}
                onPress={() => {
                  tap();
                  it.go();
                }}
                style={({ pressed }) => [styles.item, { flexDirection: row, backgroundColor: isDark ? colors.bg : k.wash }, pressed && { opacity: 0.8 }]}
              >
                <View style={{ width: 46, height: 46 }}>
                  <View style={[styles.itemAvatar, { backgroundColor: avatarColor(it.who) }]}>
                    <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>{initialsOf(it.who)}</Text>
                  </View>
                  <View style={[styles.itemDot, { backgroundColor: k.solid, borderColor: isDark ? colors.bg : '#fff' }]} />
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <T style={{ fontSize: 15, fontWeight: '700', color: INK }} numberOfLines={1}>{it.title}</T>
                  <T style={{ fontSize: 12.5, color: MUTED }} numberOfLines={1}>{it.sub}</T>
                  <T style={{ fontSize: 11.5, color: MUTED }}>{ago(it.at)}</T>
                </View>
                {it.ackId ? (
                  <Pressable onPress={() => void acknowledge(it.ackId!)} hitSlop={8} style={[styles.tag, { backgroundColor: k.solid }]}>
                    <Text style={styles.tagText}>أقرّ</Text>
                  </Pressable>
                ) : (
                  <View style={[styles.tag, { backgroundColor: k.solid }]}>
                    <Text style={styles.tagText}>{it.tag}</Text>
                  </View>
                )}
              </Pressable>
            );
          })
        )}
      </View>

      {/* مهلة الرد */}
      <View style={[styles.panel, { gap: 14 }]}>
        <T style={{ fontSize: 17, fontWeight: '700', color: INK }}>مهلة الرد</T>
        {deadlines.length === 0 ? (
          <T style={{ fontSize: 13, color: MUTED }}>لا مواعيد قريبة.</T>
        ) : (
          deadlines.map((x) => {
            const over = x.left < 0;
            const soon = !over && x.left <= 3;
            const tone = over ? { bar: '#E11D48', track: '#FFE4E6', ink: '#9F1239' }
              : soon ? { bar: '#F59E0B', track: '#FEF3C7', ink: '#92400E' }
                : { bar: '#7C3AED', track: '#EDE9FE', ink: '#5B21B6' };
            const pct = over ? 100 : Math.max(12, Math.round(((7 - Math.min(x.left, 7)) / 7) * 100));
            const label = over ? `تجاوز +${-x.left} يوم` : x.left === 0 ? 'اليوم' : x.left === 1 ? 'باقي يوم' : `باقي ${x.left} أيام`;
            return (
              <Pressable key={x.key} onPress={x.go} style={{ gap: 6 }}>
                <View style={{ flexDirection: row, justifyContent: 'space-between', gap: 10 }}>
                  <T style={{ flex: 1, fontSize: 13, fontWeight: '600', color: INK }} numberOfLines={1}>{x.title}</T>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: isDark ? tone.bar : tone.ink }}>{label}</Text>
                </View>
                <View style={{ height: 10, borderRadius: 999, backgroundColor: isDark ? colors.chip : tone.track, overflow: 'hidden', flexDirection: row }}>
                  <View style={{ width: `${pct}%`, backgroundColor: tone.bar, borderRadius: 999 }} />
                </View>
              </Pressable>
            );
          })
        )}
      </View>
    </ScrollView>
  );
}

function Stat({ bg, fg, subFg, icon, label, value, sub, onPress }: {
  bg: string; fg: string; subFg: string; icon: IconName; label: string; value: number; sub: string; onPress: () => void;
}) {
  return (
    <Pressable
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.stat, { backgroundColor: bg }, pressed && { transform: [{ scale: 0.97 }] }]}
    >
      <View style={{ flexDirection: row, justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ fontSize: 13.5, fontWeight: '600', color: fg }}>{label}</Text>
        <Ionicons name={icon} size={20} color={fg} />
      </View>
      <Text style={{ fontSize: 34, fontWeight: '700', color: fg, lineHeight: 42 }}>{value}</Text>
      <Text style={{ fontSize: 12, color: subFg }} numberOfLines={1}>{sub}</Text>
    </Pressable>
  );
}

function Chip({ active, onPress, label, count, solid, soft, ink }: {
  active: boolean; onPress: () => void; label: string; count: number; solid: string; soft: string; ink: string;
}) {
  return (
    <Pressable
      onPress={() => {
        tap();
        onPress();
      }}
      style={[styles.chip, { flexDirection: row, backgroundColor: active ? solid : isDark ? colors.chip : soft }]}
    >
      {!active && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: solid }} />}
      <Text style={{ fontSize: 13.5, fontWeight: active ? '700' : '600', color: active ? '#fff' : isDark ? colors.text : ink }}>{label}</Text>
      {active && (
        <View style={{ backgroundColor: 'rgba(255,255,255,0.25)', borderRadius: 999, paddingHorizontal: 7 }}>
          <Text style={{ fontSize: 11.5, color: '#fff', fontWeight: '700' }}>{count}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bell: { width: 46, height: 46, borderRadius: 14, backgroundColor: '#FEF3C7', alignItems: 'center', justifyContent: 'center' },
  bellBadge: {
    position: 'absolute', top: -4, left: -4, minWidth: 20, height: 20, paddingHorizontal: 5, borderRadius: 10,
    backgroundColor: '#E11D48', borderWidth: 2, borderColor: PAGE_BG, alignItems: 'center', justifyContent: 'center',
  },
  avatar: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: SURFACE },
  stat: { flexBasis: '47%', flexGrow: 1, borderRadius: 22, padding: 16, gap: 6 },
  navyCard: { backgroundColor: NAVY, borderRadius: 24, padding: 18, gap: 14, overflow: 'hidden' },
  cta: { height: 50, borderRadius: 16, backgroundColor: GOLD, alignItems: 'center', justifyContent: 'center', gap: 8 },
  panel: { backgroundColor: SURFACE, borderRadius: 24, padding: 16 },
  chip: { height: 38, paddingHorizontal: 14, borderRadius: 999, alignItems: 'center', gap: 6 },
  empty: { borderRadius: 18, padding: 22, alignItems: 'center', gap: 6 },
  item: { borderRadius: 18, padding: 12, gap: 12, alignItems: 'center' },
  itemAvatar: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  itemDot: { position: 'absolute', bottom: -3, left: -3, width: 20, height: 20, borderRadius: 10, borderWidth: 2.5 },
  tag: { borderRadius: 999, paddingHorizontal: 11, paddingVertical: 5 },
  tagText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
