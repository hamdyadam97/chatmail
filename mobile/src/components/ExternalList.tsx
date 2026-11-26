/** قائمة البريد الخارجي داخل تبويب البريد: صف لكل محادثة بعدّاد رسائلها. */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Avatar, Empty, Loading, T } from '@/components/ui';
import { errorText } from '@/lib/api';
import { externalApi, type ExternalSummary, type MailboxInfo } from '@/lib/external';
import { shortDate } from '@/lib/format';
import { colors, font, row } from '@/lib/theme';

export function ExternalList({ query }: { query: string }) {
  const [items, setItems] = useState<ExternalSummary[] | null>(null);
  const [mailbox, setMailbox] = useState<MailboxInfo | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingMore = useRef(false);

  const load = useCallback(
    async (p = 1) => {
      try {
        const data = await externalApi.list(p, query.trim());
        setItems((prev) => (p === 1 || !prev ? data.results : [...prev, ...data.results]));
        setPage(p);
        setHasMore(!!data.next);
        setError(null);
      } catch (err) {
        setError(errorText(err));
        if (p === 1) setItems((prev) => prev ?? []);
      }
    },
    [query],
  );

  useEffect(() => {
    externalApi.me().then(setMailbox).catch(() => undefined);
  }, []);

  useEffect(() => {
    setItems(null);
    const t = setTimeout(() => void load(1), query ? 400 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  const latest = useRef(load);
  latest.current = load;
  const focusedOnce = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focusedOnce.current) void latest.current(1);
      focusedOnce.current = true;
    }, []),
  );

  if (items === null) return <Loading />;
  return (
    <FlatList
      data={items}
      keyExtractor={(m) => m.id}
      ListHeaderComponent={
        mailbox?.address ? (
          <View style={[styles.address, { flexDirection: row }]}>
            <Ionicons name="at" size={15} color={colors.textMuted} />
            <Text style={styles.addressText} selectable>
              {mailbox.address}
            </Text>
          </View>
        ) : undefined
      }
      renderItem={({ item }) => <Row item={item} onPress={() => router.push(`/external/${item.id}`)} />}
      ItemSeparatorComponent={() => <View style={styles.sep} />}
      onEndReached={async () => {
        if (!hasMore || loadingMore.current) return;
        loadingMore.current = true;
        await load(page + 1);
        loadingMore.current = false;
      }}
      onEndReachedThreshold={0.4}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load(1);
            setRefreshing(false);
          }}
          tintColor={colors.navy}
          colors={[colors.navy]}
        />
      }
      contentContainerStyle={{ paddingBottom: 110, flexGrow: 1 }}
      ListEmptyComponent={
        error ? (
          <Empty icon="cloud-offline-outline" title="تعذر التحميل" hint={error} />
        ) : (
          <Empty
            icon="globe-outline"
            title={query ? 'لا نتائج' : 'لا رسائل خارجية'}
            hint={query ? 'جرّب كلمة أخرى' : 'أعطِ عنوانك أعلاه لمن يراسلك من خارج النظام.'}
          />
        )
      }
    />
  );
}

function Row({ item, onPress }: { item: ExternalSummary; onPress: () => void }) {
  const unread = (item.thread_unread ?? 0) > 0 || (item.direction === 'in' && !item.read_at);
  const who = item.direction === 'in' ? item.from_name || item.from : `إلى: ${item.recipients.join('، ')}`;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, { flexDirection: row }, pressed && { backgroundColor: colors.navySoft }]}>
      <Avatar name={who} />
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: row, alignItems: 'center', gap: 6 }}>
          {unread && <View style={styles.dot} />}
          <T style={[styles.who, unread && { fontWeight: '800' }]} numberOfLines={1}>
            {who}
          </T>
          {(item.thread_count ?? 1) > 1 && <Text style={styles.count}>{item.thread_count}</Text>}
          <Text style={[styles.date, unread && { color: colors.navy, fontWeight: '700' }]}>{shortDate(item.created_at)}</Text>
        </View>
        <View style={{ flexDirection: row, alignItems: 'center', gap: 6 }}>
          {item.direction === 'out' && <Ionicons name="paper-plane-outline" size={14} color={colors.textMuted} />}
          {item.direction === 'in' && item.auth !== 'pass' && <Ionicons name="warning-outline" size={14} color="#B7791F" />}
          <T style={[styles.subject, unread && { fontWeight: '700', color: colors.text }]} numberOfLines={1}>
            {item.subject || '(بلا عنوان)'}
          </T>
          {item.attachment_count > 0 && <Ionicons name="attach" size={16} color={colors.textMuted} />}
        </View>
        <T style={styles.preview} numberOfLines={2}>
          {item.preview}
        </T>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  address: { alignItems: 'center', gap: 6, marginHorizontal: 16, marginBottom: 8, backgroundColor: '#fff', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  addressText: { fontSize: font.small, color: colors.textSoft, fontFamily: 'monospace' },
  row: { gap: 12, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#fff' },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginHorizontal: 16 },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.gold },
  who: { flex: 1, fontSize: font.body, fontWeight: '600' },
  count: { fontSize: 11, color: colors.textSoft, backgroundColor: colors.bg, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1, overflow: 'hidden' },
  date: { fontSize: font.tiny, color: colors.textMuted },
  subject: { flex: 1, fontSize: 15, color: colors.textSoft, fontWeight: '500' },
  preview: { fontSize: font.small, color: colors.textMuted, lineHeight: 20 },
});
