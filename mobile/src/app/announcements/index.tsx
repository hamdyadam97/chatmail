/**
 * التعاميم الواردة (الجديد غير المقروء بارز، وشارة «بانتظار تأكيد اطلاعك»)،
 * و«المتابعة» لمن يتابع اطلاع التعاميم، و«+» لمن يحق له النشر.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Empty, Header, IconButton, Loading, T, tap } from '@/components/ui';
import { errorText } from '@/lib/api';
import { announcementsApi, type Announcement, type PublishTargets } from '@/lib/chat';
import { shortDate } from '@/lib/format';
import { colors, font, row } from '@/lib/theme';

export default function AnnouncementsScreen() {
  const [box, setBox] = useState<'all' | 'pending' | 'tracking'>('all');
  const [targets, setTargets] = useState<PublishTargets | null>(null);
  const canPublish = !!targets && (targets.all || targets.institutes.length > 0 || targets.branches.length > 0);
  const tracking = box === 'tracking';

  useEffect(() => {
    announcementsApi.targets().then(setTargets).catch(() => undefined);
  }, []);
  const [items, setItems] = useState<Announcement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems((box === 'tracking' ? await announcementsApi.tracking() : await announcementsApi.received(box === 'pending')).results);
      setError(null);
    } catch (err) {
      setError(errorText(err));
      setItems((p) => p ?? []);
    }
  }, [box]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="التعاميم" back right={canPublish ? <IconButton name="add-circle" size={30} onPress={() => router.push('/announcements/new')} /> : undefined} />
      <View style={[styles.segment, { flexDirection: row }]}>
        {[
          { v: 'all' as const, label: 'الواردة' },
          { v: 'pending' as const, label: 'بانتظار تأكيدي' },
          ...(targets?.can_track ? [{ v: 'tracking' as const, label: 'المتابعة' }] : []),
        ].map((o) => (
          <Pressable
            key={o.label}
            onPress={() => {
              tap();
              setItems(null);
              setBox(o.v);
            }}
            style={[styles.segItem, box === o.v && styles.segActive]}
          >
            <Text style={[styles.segText, box === o.v && { color: colors.navy, fontWeight: '700' }]}>{o.label}</Text>
          </Pressable>
        ))}
      </View>
      {items === null ? (
        <Loading />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(a) => a.id}
          contentContainerStyle={{ flexGrow: 1 }}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
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
          ListEmptyComponent={
            error ? (
              <Empty icon="cloud-offline-outline" title="تعذر التحميل" hint={error} />
            ) : (
              <Empty icon="megaphone-outline" title={box === 'pending' ? 'لا شيء بانتظار تأكيدك' : tracking ? 'لا تعاميم تتابعها' : 'لا تعاميم'} />
            )
          }
          renderItem={({ item: a }) => {
            const unread = !tracking && !a.mine?.read_at;
            const needsAck = !tracking && a.requires_ack && !a.mine?.acknowledged_at && a.status === 'published';
            return (
              <Pressable
                onPress={() => router.push(tracking ? `/announcements/report/${a.id}` : `/announcements/${a.id}`)}
                style={({ pressed }) => [styles.row, { flexDirection: row }, pressed && { backgroundColor: colors.navySoft }]}
              >
                <View style={[styles.icon, a.priority !== 'normal' && { backgroundColor: '#FDECEC' }]}>
                  <Ionicons name="megaphone" size={20} color={a.priority !== 'normal' ? colors.danger : colors.navy} />
                </View>
                <View style={{ flex: 1, gap: 3 }}>
                  <View style={{ flexDirection: row, alignItems: 'center', gap: 6 }}>
                    {unread && <View style={styles.dot} />}
                    <T style={[styles.title, unread && { fontWeight: '800' }]} numberOfLines={2}>
                      {a.status === 'withdrawn' ? 'تعميم مسحوب' : a.content?.title ?? `تعميم ${a.reference_number ?? ''}`}
                    </T>
                    <Text style={styles.date}>{shortDate(a.published_at)}</Text>
                  </View>
                  <T style={styles.meta} numberOfLines={1}>
                    {a.publisher.full_name}
                    {a.reference_number ? ` — ${a.reference_number}` : ''}
                  </T>
                  {needsAck && <Text style={styles.ack}>بانتظار تأكيد اطلاعك</Text>}
                  {tracking && a.counts && (
                    <Text style={styles.counts}>
                      اطلع {a.counts.read} من {a.counts.recipients}
                      {a.requires_ack ? ` · أقر ${a.counts.acknowledged}` : ''}
                    </Text>
                  )}
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  segment: { marginHorizontal: 16, marginBottom: 10, backgroundColor: '#E8E8EF', borderRadius: 10, padding: 3 },
  segItem: { flex: 1, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  segActive: { backgroundColor: '#fff' },
  segText: { fontSize: font.small, color: colors.textSoft, fontWeight: '600' },
  row: { gap: 12, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#fff', alignItems: 'flex-start' },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginHorizontal: 16 },
  icon: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.navySoft, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: font.body, fontWeight: '600' },
  date: { fontSize: font.tiny, color: colors.textMuted },
  meta: { fontSize: font.tiny + 1, color: colors.textMuted },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.gold },
  counts: { fontSize: font.tiny, color: colors.navy, fontWeight: '700' },
  ack: {
    alignSelf: 'flex-start',
    fontSize: 11,
    fontWeight: '700',
    color: '#8A5A00',
    backgroundColor: '#FFF4DC',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: 'hidden',
  },
});
