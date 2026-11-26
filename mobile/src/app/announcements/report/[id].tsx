/** متابعة تعميم: كم وصل واطلع وأقر، والأسماء بحالتها، و«تذكير من لم يقر». */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { Text } from '@/components/Text';

import { Button, Empty, Header, Loading, T, success, tap } from '@/components/ui';
import { errorText } from '@/lib/api';
import { announcementsApi, type Announcement, type Compliance, type ComplianceRow } from '@/lib/chat';
import { fullDate, shortDate } from '@/lib/format';
import { colors, font, radius, row } from '@/lib/theme';

type Filter = 'all' | 'unread' | 'unacked';

export default function AnnouncementReportScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [a, setA] = useState<Announcement | null>(null);
  const [report, setReport] = useState<Compliance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [reminding, setReminding] = useState(false);

  const load = useCallback(async () => {
    try {
      const [ann, rep] = await Promise.all([announcementsApi.get(id).catch(() => null), announcementsApi.compliance(id)]);
      setA(ann);
      setReport(rep);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const all = report?.rows ?? [];
    if (filter === 'unread') return all.filter((r) => !r.read_at);
    if (filter === 'unacked') return all.filter((r) => !r.acknowledged_at);
    return all;
  }, [report, filter]);

  if (error || !report) {
    return (
      <View style={{ flex: 1 }}>
        <Header title="" back />
        {error ? <Empty icon="alert-circle-outline" title="تعذر فتح المتابعة" hint={error} /> : <Loading />}
      </View>
    );
  }

  const requiresAck = !!a?.requires_ack;
  const remind = async () => {
    setReminding(true);
    try {
      const r = await announcementsApi.remind(id);
      success();
      Alert.alert('أُرسل التذكير', `وصل إشعار إلى ${r.reminded} لم يقرّوا بعد.`);
      void load();
    } catch (err) {
      Alert.alert('تعذر التذكير', errorText(err));
    } finally {
      setReminding(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="متابعة الاطلاع" back large={false} />
      <FlatList
        data={rows}
        keyExtractor={(r) => r.user.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
            tintColor={colors.navy}
          />
        }
        contentContainerStyle={{ paddingBottom: 40 }}
        ListHeaderComponent={
          <View style={{ padding: 16, gap: 12 }}>
            {a?.content?.title ? (
              <Pressable onPress={() => router.push(`/announcements/${id}`)}>
                <T style={{ fontSize: font.title, fontWeight: '800' }}>{a.content.title}</T>
                <T style={styles.meta}>
                  {a.reference_number ? `${a.reference_number} — ` : ''}
                  {fullDate(a.published_at)}
                </T>
              </Pressable>
            ) : null}
            <View style={{ flexDirection: row, gap: 8 }}>
              <Stat label="المستلمون" value={report.total} />
              <Stat label="اطلعوا" value={report.read} />
              {requiresAck && <Stat label="أقرّوا" value={report.acknowledged} highlight />}
              {report.overdue > 0 && <Stat label="متأخرون" value={report.overdue} danger />}
            </View>
            {requiresAck && a?.status === 'published' && report.acknowledged < report.total && (
              <Button title="تذكير من لم يقر" icon="notifications-outline" variant="secondary" loading={reminding} onPress={remind} />
            )}
            <View style={[styles.segment, { flexDirection: row }]}>
              {(
                [
                  ['all', `الكل (${report.total})`],
                  ['unread', `لم يطلع (${report.total - report.read})`],
                  ...(requiresAck ? [['unacked', `لم يقر (${report.total - report.acknowledged})`]] : []),
                ] as [Filter, string][]
              ).map(([k, label]) => (
                <Pressable
                  key={k}
                  onPress={() => {
                    tap();
                    setFilter(k);
                  }}
                  style={[styles.segItem, filter === k && styles.segActive]}
                >
                  <Text style={[styles.segText, filter === k && { color: colors.navy, fontWeight: '700' }]}>{label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        }
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        ListEmptyComponent={<Empty icon="checkmark-done-outline" title="لا أحد هنا" />}
        renderItem={({ item }) => <PersonRow r={item} requiresAck={requiresAck} />}
      />
    </View>
  );
}

function Stat({ label, value, highlight, danger }: { label: string; value: number; highlight?: boolean; danger?: boolean }) {
  return (
    <View style={[styles.stat, highlight && { backgroundColor: colors.navySoft }, danger && { backgroundColor: colors.dangerSoft }]}>
      <Text style={[styles.statValue, danger && { color: colors.danger }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function PersonRow({ r, requiresAck }: { r: ComplianceRow; requiresAck: boolean }) {
  const state = r.acknowledged_at
    ? { icon: 'checkmark-done-circle' as const, color: colors.success, text: `أقر ${shortDate(r.acknowledged_at)}` }
    : r.read_at
      ? { icon: 'eye' as const, color: colors.info, text: `اطلع ${shortDate(r.read_at)}${requiresAck ? ' — لم يقر' : ''}` }
      : { icon: 'ellipse-outline' as const, color: r.overdue ? colors.danger : colors.textMuted, text: r.overdue ? 'لم يطلع — متأخر' : 'لم يطلع بعد' };
  return (
    <View style={[styles.row, { flexDirection: row }]}>
      <Ionicons name={state.icon} size={22} color={state.color} />
      <View style={{ flex: 1 }}>
        <T style={{ fontWeight: '600' }} numberOfLines={1}>
          {r.user.full_name}
        </T>
        {!!(r.user.branch || r.user.institute) && <T style={styles.meta}>{r.user.branch || r.user.institute}</T>}
      </View>
      <Text style={[styles.state, { color: state.color }]}>{state.text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  meta: { fontSize: font.tiny + 1, color: colors.textMuted },
  stat: { flex: 1, backgroundColor: colors.card, borderRadius: radius.md, paddingVertical: 10, alignItems: 'center' },
  statValue: { fontSize: 22, fontWeight: '800', color: colors.navy },
  statLabel: { fontSize: font.tiny, color: colors.textSoft },
  segment: { backgroundColor: colors.chip, borderRadius: 10, padding: 3 },
  segItem: { flex: 1, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  segActive: { backgroundColor: colors.card },
  segText: { fontSize: font.tiny + 1, color: colors.textSoft, fontWeight: '600' },
  row: { alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 11, backgroundColor: colors.card },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginHorizontal: 16 },
  state: { fontSize: font.tiny, fontWeight: '600' },
});
