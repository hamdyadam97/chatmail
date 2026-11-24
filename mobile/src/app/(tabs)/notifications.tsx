/** الإشعارات: عناوين عامة فقط (لا محتوى)، والضغط يفتح المراسلة أو طلبات الدخول. */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Empty, Header, IconName, Loading, T, tap } from '@/components/ui';
import { api, errorText } from '@/lib/api';
import { shortDate } from '@/lib/format';
import { colors, font, row } from '@/lib/theme';
import type { AppNotification, Page } from '@/lib/types';

const ICONS: Record<string, IconName> = {
  new_correspondence: 'mail',
  correspondence_reply: 'arrow-undo',
  correspondence_forward: 'arrow-redo',
  approval_requested: 'checkmark-done-circle',
  approval_awaiting_manager: 'hourglass',
  approval_overridden: 'flash',
  approval_reminder: 'alarm-outline',
  announcement: 'megaphone',
  announcement_reminder: 'megaphone',
  correspondence_due_soon: 'time',
  correspondence_overdue: 'alarm',
  correspondence_overdue_sender: 'alarm',
  external_mail: 'globe',
  login_approval: 'key',
};

export default function NotificationsScreen() {
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const page = await api<Page<AppNotification>>('/notifications/?page=1');
      setItems(page.results);
      setError(null);
    } catch (err) {
      setError(errorText(err));
      setItems((prev) => prev ?? []);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const openOne = async (n: AppNotification) => {
    tap();
    if (!n.read_at) {
      setItems((prev) => prev?.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)) ?? null);
      void api(`/notifications/${n.id}/read/`, { method: 'POST' }).catch(() => undefined);
    }
    if (n.ref_type === 'correspondence' && n.ref_id) router.push(`/mail/${n.ref_id}`);
    else if (n.ref_type === 'approval_request' && n.ref_id) router.push(`/approvals/${n.ref_id}`);
    else if (n.ref_type === 'login_approval') router.push('/login-approvals');
  };

  const readAll = async () => {
    await api('/notifications/read-all/', { method: 'POST' }).catch(() => undefined);
    void load();
  };

  const unread = items?.some((n) => !n.read_at);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header
        title="الإشعارات"
        right={
          unread ? (
            <Pressable hitSlop={8} onPress={readAll}>
              <Text style={{ color: colors.navy, fontSize: 15, fontWeight: '600' }}>قراءة الكل</Text>
            </Pressable>
          ) : undefined
        }
      />
      {items === null ? (
        <Loading />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(n) => n.id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                await load();
                setRefreshing(false);
              }}
              tintColor={colors.navy}
              colors={[colors.navy]}
            />
          }
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          contentContainerStyle={{ flexGrow: 1 }}
          ListEmptyComponent={
            error ? <Empty icon="cloud-offline-outline" title="تعذر التحميل" hint={error} /> : <Empty icon="notifications-off-outline" title="لا إشعارات" />
          }
          renderItem={({ item: n }) => (
            <Pressable
              onPress={() => void openOne(n)}
              style={({ pressed }) => [styles.row, { flexDirection: row }, !n.read_at && { backgroundColor: '#FBFAF4' }, pressed && { backgroundColor: colors.navySoft }]}
            >
              <View style={[styles.icon, !n.read_at && { backgroundColor: colors.goldSoft }]}>
                <Ionicons name={ICONS[n.kind] ?? 'notifications'} size={20} color={n.read_at ? colors.navy : colors.gold} />
              </View>
              <T style={[styles.title, !n.read_at && { fontWeight: '800' }]} numberOfLines={2}>
                {n.title}
              </T>
              <Text style={styles.date}>{shortDate(n.created_at)}</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#fff' },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginHorizontal: 16 },
  icon: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.navySoft, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: font.body, fontWeight: '600' },
  date: { fontSize: font.tiny, color: colors.textMuted },
});
