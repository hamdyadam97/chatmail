/** المحادثات: آخر رسالة ووقتها ونقطة غير المقروء، وزر «محادثة جديدة». */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { Text } from '@/components/Text';

import { Avatar, Empty, Header, IconButton, Loading, T } from '@/components/ui';
import { errorText } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { chatApi, conversationName, type Conversation } from '@/lib/chat';
import { shortDate } from '@/lib/format';
import { colors, font, row } from '@/lib/theme';

export default function ChatListScreen() {
  const { user } = useAuth();
  const [items, setItems] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await chatApi.list();
      list.sort((a, b) => (b.last?.created_at ?? b.created_at).localeCompare(a.last?.created_at ?? a.created_at));
      setItems(list);
      setError(null);
    } catch (err) {
      setError(errorText(err));
      setItems((p) => p ?? []);
    }
  }, []);

  // مفتوحة: تحديث كل 15 ثانية (رسائل جديدة من محادثات أخرى).
  useFocusEffect(
    useCallback(() => {
      void load();
      timer.current = setInterval(() => void load(), 15_000);
      return () => {
        if (timer.current) clearInterval(timer.current);
      };
    }, [load]),
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="المحادثات" right={<IconButton name="create-outline" onPress={() => router.push('/chat/new')} />} />
      {items === null ? (
        <Loading />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(c) => c.id}
          contentContainerStyle={{ paddingTop: 6, flexGrow: 1 }}
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
              colors={[colors.navy]}
            />
          }
          ListEmptyComponent={
            error ? (
              <Empty icon="cloud-offline-outline" title="تعذر التحميل" hint={error} />
            ) : (
              <Empty icon="chatbubbles-outline" title="لا محادثات بعد" hint="ابدأ محادثة مع زميل من الزر أعلى الشاشة." />
            )
          }
          renderItem={({ item: c }) => {
            const name = conversationName(c, user?.id);
            const unread = !!c.last && c.last.seq > c.last_read_seq && c.last.sender_user_id !== user?.id;
            const mine = c.last?.sender_user_id === user?.id;
            return (
              <Pressable
                onPress={() => router.push({ pathname: '/chat/[id]', params: { id: c.id, name } })}
                style={({ pressed }) => [styles.row, { flexDirection: row }, pressed && { backgroundColor: colors.navySoft }]}
              >
                {c.type === 'group' ? (
                  <View style={styles.groupAvatar}>
                    <Ionicons name="people" size={22} color="#fff" />
                  </View>
                ) : (
                  <Avatar name={name} size={50} />
                )}
                <View style={{ flex: 1, gap: 3 }}>
                  <View style={{ flexDirection: row, alignItems: 'center', gap: 6 }}>
                    <T style={[styles.name, unread && { fontWeight: '800' }]} numberOfLines={1}>
                      {name}
                    </T>
                    <Text style={[styles.date, unread && { color: colors.gold, fontWeight: '700' }]}>{shortDate(c.last?.created_at ?? c.created_at)}</Text>
                  </View>
                  <View style={{ flexDirection: row, alignItems: 'center', gap: 6 }}>
                    <T style={[styles.preview, unread && { color: colors.text, fontWeight: '600' }]} numberOfLines={1}>
                      {c.last ? `${mine ? 'أنت: ' : ''}${c.last.preview}` : 'لا رسائل بعد'}
                    </T>
                    {unread && <View style={styles.dot} />}
                  </View>
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
  row: { alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 13, backgroundColor: '#fff', marginHorizontal: 14, borderRadius: 18 },
  sep: { height: 8 },
  groupAvatar: { width: 50, height: 50, borderRadius: 25, backgroundColor: colors.navy, alignItems: 'center', justifyContent: 'center' },
  name: { flex: 1, fontSize: font.body, fontWeight: '600' },
  date: { fontSize: font.tiny, color: colors.textMuted },
  preview: { flex: 1, fontSize: font.small, color: colors.textMuted },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.gold },
});
