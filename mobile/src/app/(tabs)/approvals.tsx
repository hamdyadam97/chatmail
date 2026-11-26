/** الموافقات: بانتظار قراري / طلباتي / وصلتني، وزر «طلب جديد». */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { Text } from '@/components/Text';

import { StatusChip } from '@/components/approvals';
import { Avatar, Empty, Header, Loading, T, tap } from '@/components/ui';
import { errorText } from '@/lib/api';
import { approvalsApi, requestTitle, type ApprovalRequest, type Box } from '@/lib/approvals';
import { shortDate } from '@/lib/format';
import { colors, font, row } from '@/lib/theme';

const BOXES: { key: Box; label: string }[] = [
  { key: 'pending_mine', label: 'بانتظار قراري' },
  { key: 'requested_by_me', label: 'طلباتي' },
  { key: 'received', label: 'وصلتني' },
];

export default function ApprovalsScreen() {
  const [box, setBox] = useState<Box>('pending_mine');
  const [items, setItems] = useState<ApprovalRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (which: Box) => {
    try {
      setItems(await approvalsApi.list(which));
      setError(null);
    } catch (err) {
      setError(errorText(err));
      setItems((p) => p ?? []);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load(box);
    }, [load, box]),
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="الموافقات" />
      <View style={[styles.segment, { flexDirection: row }]}>
        {BOXES.map((b) => {
          const active = b.key === box;
          return (
            <Pressable
              key={b.key}
              onPress={() => {
                tap();
                setItems(null);
                setBox(b.key);
              }}
              style={[styles.segItem, active && styles.segActive]}
            >
              <Text style={[styles.segText, active && { color: colors.navy, fontWeight: '700' }]}>{b.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {items === null ? (
        <Loading />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ paddingTop: 6, paddingBottom: 110, flexGrow: 1 }}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                await load(box);
                setRefreshing(false);
              }}
              tintColor={colors.navy}
              colors={[colors.navy]}
            />
          }
          ListEmptyComponent={
            error ? (
              <Empty icon="cloud-offline-outline" title="تعذر التحميل" hint={error} />
            ) : (
              <Empty
                icon="checkmark-done-circle-outline"
                title={box === 'pending_mine' ? 'لا طلبات بانتظارك' : 'لا طلبات'}
                hint={box === 'requested_by_me' ? 'قدّم طلب إجازة أو صرف من زر «طلب جديد».' : undefined}
              />
            )
          }
          renderItem={({ item: r }) => (
            <Pressable
              onPress={() => router.push(`/approvals/${r.id}`)}
              disabled={r.status === 'cancelled'}
              style={({ pressed }) => [styles.row, { flexDirection: row }, pressed && { backgroundColor: colors.navySoft }, r.status === 'cancelled' && { opacity: 0.5 }]}
            >
              <Avatar name={r.requested_by.full_name} size={42} />
              <View style={{ flex: 1, gap: 3 }}>
                <View style={{ flexDirection: row, alignItems: 'center', gap: 6 }}>
                  <T style={styles.name} numberOfLines={1}>
                    {box === 'requested_by_me' ? r.workflow_name ?? 'طلب اعتماد' : r.requested_by.full_name}
                  </T>
                  <Text style={styles.date}>{shortDate(r.created_at)}</Text>
                </View>
                <T style={styles.title} numberOfLines={1}>
                  {box !== 'requested_by_me' && r.workflow_name ? `${r.workflow_name} — ` : ''}
                  {requestTitle(r)}
                </T>
                <View style={{ flexDirection: row, gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                  <StatusChip status={r.status} />
                  {r.my_early_step != null && <Chip text="بانتظار المدير المباشر" color="#8A5A00" bg="#FFF4DC" />}
                  {r.status === 'pending' && <Chip text={`الخطوة ${r.current_step_order} من ${r.steps.length}`} />}
                </View>
              </View>
            </Pressable>
          )}
        />
      )}

      <Pressable
        onPress={() => {
          tap();
          router.push('/approvals/new');
        }}
        style={({ pressed }) => [styles.fab, pressed && { transform: [{ scale: 0.95 }] }]}
      >
        <Ionicons name="add" size={26} color="#fff" />
        <Text style={styles.fabText}>طلب جديد</Text>
      </Pressable>
    </View>
  );
}

function Chip({ text, color = colors.textSoft, bg = colors.bg }: { text: string; color?: string; bg?: string }) {
  return <Text style={[styles.chip, { color, backgroundColor: bg }]}>{text}</Text>;
}

const styles = StyleSheet.create({
  segment: { marginHorizontal: 16, marginBottom: 10, backgroundColor: colors.chip, borderRadius: 10, padding: 3 },
  segItem: { flex: 1, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  segActive: { backgroundColor: colors.card, shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  segText: { fontSize: font.small, color: colors.textSoft, fontWeight: '600' },
  row: { gap: 12, paddingHorizontal: 14, paddingVertical: 13, backgroundColor: colors.card, marginHorizontal: 14, borderRadius: 18 },
  sep: { height: 8 },
  name: { flex: 1, fontWeight: '700', fontSize: font.body },
  date: { fontSize: font.tiny, color: colors.textMuted },
  title: { fontSize: 15, color: colors.textSoft },
  chip: { fontSize: 11, fontWeight: '600', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, overflow: 'hidden' },
  fab: {
    position: 'absolute',
    bottom: 20,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.navyFill,
    paddingHorizontal: 22,
    height: 52,
    borderRadius: 26,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  fabText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
