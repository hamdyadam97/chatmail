/**
 * الرئيسية — «مكتب اليوم»: ما ينتظر قرارك في بطاقة واحدة واضحة، ثم
 * اختصارات العمل اليومي، ثم «اليوم»: الطلبات والرسائل غير المقروءة
 * والتعاميم التي تنتظر إقرارك في قائمة واحدة مرتبة بالأحدث.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '@/components/Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconName, T, success, tap } from '@/components/ui';
import { api } from '@/lib/api';
import { approvalsApi, requestTitle, type ApprovalRequest } from '@/lib/approvals';
import { useAuth } from '@/lib/auth';
import { announcementsApi, type Announcement } from '@/lib/chat';
import { initials, shortDate } from '@/lib/format';
import { colors, forwardIcon, row } from '@/lib/theme';
import type { MailSummary, Page } from '@/lib/types';

const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const LATE_MS = 48 * 3600 * 1000;

const TONES = {
  request: { bg: '#FBF1DC', fg: '#8A5A12', icon: 'create-outline' as IconName },
  mail: { bg: '#ECEBF7', fg: colors.navy, icon: 'mail-outline' as IconName },
  announcement: { bg: '#E3F1EC', fg: '#1F6B52', icon: 'megaphone-outline' as IconName },
};

type TodayItem =
  | { kind: 'request'; id: string; at: string; title: string; sub: string; late: boolean }
  | { kind: 'mail'; id: string; at: string; title: string; sub: string }
  | { kind: 'announcement'; id: string; at: string; title: string; sub: string; ack: boolean };

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'صباح الخير';
  if (h < 18) return 'مساء النور';
  return 'مساء الخير';
}

function today(): string {
  const d = new Date();
  return `${DAYS[d.getDay()]}، ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function firstName(full?: string): string {
  return (full ?? '').trim().split(/\s+/)[0] ?? '';
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [pending, setPending] = useState<ApprovalRequest[] | null>(null);
  const [mail, setMail] = useState<MailSummary[]>([]);
  const [anns, setAnns] = useState<Announcement[]>([]);
  const [notes, setNotes] = useState(0);
  const [canPublish, setCanPublish] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    await Promise.all([
      approvalsApi.list('pending_mine').then(setPending).catch(() => setPending((p) => p ?? [])),
      api<Page<MailSummary>>('/correspondences/?folder=inbox&page=1')
        .then((p) => setMail(p.results.filter((m) => !m.read_at)))
        .catch(() => undefined),
      announcementsApi.received(true).then((p) => setAnns(p.results)).catch(() => undefined),
      api<{ unread: number }>('/notifications/unread-count/').then((c) => setNotes(c.unread)).catch(() => undefined),
      announcementsApi
        .targets()
        .then((t) => setCanPublish(t.all || t.institutes.length > 0 || t.branches.length > 0))
        .catch(() => undefined),
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

  // الأقدم أولًا: «ابدأ» يفتح ما انتظر أطول.
  const waiting = (pending ?? []).filter((r) => r.status === 'pending').sort((a, b) => a.created_at.localeCompare(b.created_at));
  const now = Date.now();
  const late = waiting.filter((r) => now - new Date(r.created_at).getTime() > LATE_MS).length;
  const byType = new Map<string, number>();
  for (const r of waiting) {
    const k = r.workflow_name || 'مراسلة';
    byType.set(k, (byType.get(k) ?? 0) + 1);
  }

  const items: TodayItem[] = [
    ...waiting.map<TodayItem>((r) => ({
      kind: 'request',
      id: r.id,
      at: r.created_at,
      title: requestTitle(r),
      sub: `${r.workflow_name || 'طلب اعتماد'} · من ${r.requested_by.full_name}`,
      late: now - new Date(r.created_at).getTime() > LATE_MS,
    })),
    ...mail.map<TodayItem>((m) => ({
      kind: 'mail',
      id: m.id,
      at: m.sent_at || m.created_at,
      title: m.subject || '(بلا عنوان)',
      sub: `مراسلة · من ${m.sender.full_name}`,
    })),
    ...anns.map<TodayItem>((a) => ({
      kind: 'announcement',
      id: a.id,
      at: a.published_at || '',
      title: a.content?.title || 'تعميم',
      sub: a.ack_due_at ? `تعميم · الإقرار قبل ${shortDate(a.ack_due_at)}` : `تعميم · من ${a.publisher.full_name}`,
      ack: a.requires_ack,
    })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 8);

  const open = (it: TodayItem) => {
    tap();
    if (it.kind === 'request') router.push(`/approvals/${it.id}`);
    else if (it.kind === 'mail') router.push(`/mail/${it.id}`);
    else router.push(`/announcements/${it.id}`);
  };

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

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: HOME_BG }}
      contentContainerStyle={{ paddingTop: insets.top + 14, paddingHorizontal: 18, paddingBottom: 32, gap: 20 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.navy} />}
    >
      {/* التحية */}
      <View style={[styles.header, { flexDirection: row }]}>
        <Pressable onPress={() => router.push('/account')} style={styles.avatar} accessibilityLabel="حسابي">
          <Text style={styles.avatarText}>{initials(user?.full_name)}</Text>
        </Pressable>
        <View style={{ flex: 1, gap: 1 }}>
          <T style={styles.date}>{today()}</T>
          <T style={styles.hello} numberOfLines={1}>
            {greeting()}، {firstName(user?.full_name) || user?.username}
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
          <Ionicons name="notifications-outline" size={22} color={colors.navy} />
          {notes > 0 && <View style={styles.bellDot} />}
        </Pressable>
      </View>

      {/* بانتظار قرارك */}
      {pending === null ? (
        <View style={[styles.hero, { minHeight: 186 }]} />
      ) : waiting.length > 0 ? (
        <View style={styles.hero}>
          <View style={styles.heroRing} />
          <View style={{ flexDirection: row, justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
            <View style={{ gap: 2 }}>
              <T style={styles.heroLabel}>بانتظار قرارك</T>
              <View style={{ flexDirection: row, alignItems: 'baseline', gap: 8 }}>
                <Text style={styles.heroCount}>{waiting.length}</Text>
                <Text style={styles.heroUnit}>{waiting.length === 1 ? 'طلب' : waiting.length === 2 ? 'طلبان' : waiting.length <= 10 ? 'طلبات' : 'طلبًا'}</Text>
              </View>
            </View>
            {late > 0 && <Text style={styles.lateChip}>{late === 1 ? 'واحد ينتظر أكثر من يومين' : `${late} تنتظر أكثر من يومين`}</Text>}
          </View>
          <View style={{ flexDirection: row, flexWrap: 'wrap', gap: 8 }}>
            {[...byType].map(([name, n]) => (
              <Text key={name} style={styles.typeChip}>
                {name} · {n}
              </Text>
            ))}
          </View>
          <Pressable
            onPress={() => {
              tap();
              router.push(`/approvals/${waiting[0].id}`);
            }}
            style={({ pressed }) => [styles.cta, { flexDirection: row }, pressed && { opacity: 0.85 }]}
          >
            <Ionicons name="create-outline" size={20} color={colors.navyDark} />
            <Text style={styles.ctaText}>{waiting.length > 1 ? 'ابدأ بالأقدم' : 'افتح الطلب'}</Text>
          </Pressable>
        </View>
      ) : (
        <View style={[styles.calm, { flexDirection: row }]}>
          <View style={styles.calmIcon}>
            <Ionicons name="checkmark-done" size={24} color="#1F6B52" />
          </View>
          <View style={{ flex: 1 }}>
            <T style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>لا شيء بانتظار قرارك</T>
            <T style={{ fontSize: 13, color: colors.textSoft }}>كل الطلبات الموجهة إليك تم البت فيها.</T>
          </View>
        </View>
      )}

      {/* اختصارات */}
      <View style={{ flexDirection: row, justifyContent: 'space-between' }}>
        <Shortcut icon="mail-outline" label="رسالة" onPress={() => router.push('/compose')} />
        <Shortcut icon="document-attach-outline" label="طلب جديد" onPress={() => router.push('/approvals/new')} />
        <Shortcut
          icon="megaphone-outline"
          label={canPublish ? 'تعميم' : 'التعاميم'}
          onPress={() => router.push(canPublish ? '/announcements/new' : '/announcements')}
        />
        <Shortcut icon="search-outline" label="بحث" onPress={() => router.push('/search')} />
      </View>

      {/* اليوم */}
      <View style={{ gap: 10 }}>
        <View style={{ flexDirection: row, justifyContent: 'space-between', alignItems: 'baseline' }}>
          <T style={styles.section}>اليوم</T>
          {items.length > 0 && <T style={styles.sectionHint}>{items.length === 8 ? 'آخر 8' : `${items.length}`}</T>}
        </View>
        {items.length === 0 && pending !== null ? (
          <View style={styles.empty}>
            <Ionicons name="sunny-outline" size={30} color={colors.gold} />
            <T style={{ fontSize: 15, fontWeight: '600', color: colors.text, textAlign: 'center' }}>كل شيء مقروء</T>
            <T style={{ fontSize: 13, color: colors.textSoft, textAlign: 'center' }}>لا رسائل جديدة ولا تعاميم تنتظر إقرارك.</T>
          </View>
        ) : (
          items.map((it) => {
            const tone = TONES[it.kind];
            return (
              <Pressable
                key={`${it.kind}-${it.id}`}
                onPress={() => open(it)}
                style={({ pressed }) => [styles.item, { flexDirection: row }, pressed && { backgroundColor: '#F7F6FB' }]}
              >
                <View style={[styles.itemIcon, { backgroundColor: tone.bg }]}>
                  <Ionicons name={tone.icon} size={20} color={tone.fg} />
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <T style={[styles.itemTitle, it.kind === 'mail' && { fontWeight: '700' }]} numberOfLines={1}>
                    {it.title}
                  </T>
                  <T style={styles.itemSub} numberOfLines={1}>
                    {it.sub}
                  </T>
                </View>
                {it.kind === 'announcement' && it.ack ? (
                  <Pressable onPress={() => void acknowledge(it.id)} hitSlop={8} style={styles.ackBtn}>
                    <Text style={styles.ackText}>أقرّ</Text>
                  </Pressable>
                ) : (
                  <View style={{ alignItems: 'flex-end', gap: 5 }}>
                    <Text style={styles.time}>{shortDate(it.at)}</Text>
                    {it.kind === 'request' ? (
                      <Text style={[styles.pill, it.late && { backgroundColor: '#FDE8DA', color: '#9A3412' }]}>
                        {it.late ? 'متأخر' : 'يحتاج قرارك'}
                      </Text>
                    ) : it.kind === 'mail' ? (
                      <View style={styles.unreadDot} />
                    ) : (
                      <Ionicons name={forwardIcon} size={16} color={colors.textMuted} />
                    )}
                  </View>
                )}
              </Pressable>
            );
          })
        )}
      </View>
    </ScrollView>
  );
}

function Shortcut({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [{ alignItems: 'center', gap: 7, width: 76 }, pressed && { opacity: 0.6 }]}
    >
      <View style={styles.shortcut}>
        <Ionicons name={icon} size={24} color={colors.navy} />
      </View>
      <Text style={styles.shortcutLabel}>{label}</Text>
    </Pressable>
  );
}

const HOME_BG = colors.bg;
const LINE = colors.border;

const styles = StyleSheet.create({
  header: { alignItems: 'center', gap: 12 },
  avatar: { width: 46, height: 46, borderRadius: 15, backgroundColor: colors.navy, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  date: { fontSize: 13, color: colors.textSoft },
  hello: { fontSize: 21, fontWeight: '800', color: colors.text },
  bell: {
    width: 46,
    height: 46,
    borderRadius: 15,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: LINE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bellDot: { position: 'absolute', top: 10, left: 11, width: 10, height: 10, borderRadius: 5, backgroundColor: '#C2410C', borderWidth: 2, borderColor: '#fff' },

  hero: { backgroundColor: colors.navy, borderRadius: 26, padding: 20, gap: 16, overflow: 'hidden' },
  heroRing: { position: 'absolute', left: -40, top: -40, width: 160, height: 160, borderRadius: 80, borderWidth: 20, borderColor: 'rgba(255,255,255,0.05)' },
  heroLabel: { fontSize: 14, color: '#CFCDE8' },
  heroCount: { fontSize: 54, fontWeight: '800', color: '#fff', lineHeight: 60 },
  heroUnit: { fontSize: 17, fontWeight: '600', color: '#fff' },
  lateChip: {
    fontSize: 12,
    fontWeight: '700',
    color: '#FDBA74',
    backgroundColor: 'rgba(251,146,60,0.16)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    overflow: 'hidden',
    maxWidth: 170,
    textAlign: 'center',
  },
  typeChip: { fontSize: 12.5, color: '#fff', backgroundColor: 'rgba(255,255,255,0.09)', paddingHorizontal: 11, paddingVertical: 5, borderRadius: 999, overflow: 'hidden' },
  cta: { height: 52, borderRadius: 16, backgroundColor: '#D9AE52', alignItems: 'center', justifyContent: 'center', gap: 8 },
  ctaText: { fontSize: 16, fontWeight: '800', color: colors.navyDark },

  calm: { backgroundColor: '#fff', borderRadius: 22, padding: 16, gap: 14, alignItems: 'center', borderWidth: 1, borderColor: LINE },
  calmIcon: { width: 48, height: 48, borderRadius: 16, backgroundColor: '#E3F1EC', alignItems: 'center', justifyContent: 'center' },

  shortcut: {
    width: 58,
    height: 58,
    borderRadius: 19,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: LINE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shortcutLabel: { fontSize: 12.5, fontWeight: '600', color: colors.text },

  section: { fontSize: 19, fontWeight: '800', color: colors.text },
  sectionHint: { fontSize: 12.5, color: colors.textSoft },
  item: { backgroundColor: '#fff', borderRadius: 18, paddingVertical: 13, paddingHorizontal: 14, gap: 12, alignItems: 'center' },
  itemIcon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  itemTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
  itemSub: { fontSize: 12.5, color: colors.textSoft },
  time: { fontSize: 12, color: colors.textSoft },
  pill: { fontSize: 11, fontWeight: '700', color: '#8A5A12', backgroundColor: '#FBF1DC', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: 'hidden' },
  unreadDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.navy },
  ackBtn: { borderWidth: 1, borderColor: '#B9DCCD', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 7 },
  ackText: { fontSize: 13, fontWeight: '700', color: '#1F6B52' },
  empty: { backgroundColor: '#fff', borderRadius: 18, padding: 22, alignItems: 'center', gap: 6 },
});
