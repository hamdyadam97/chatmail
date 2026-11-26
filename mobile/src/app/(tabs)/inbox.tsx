/** البريد: المجلدات كشرائح أعلى القائمة (ومنها «الخارجي»)، بحث، سحب للتحديث، وزر «رسالة جديدة» العائم. */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '@/components/Text';

import { ExternalList } from '@/components/ExternalList';
import { Avatar, Empty, Header, IconButton, Loading, T, tap } from '@/components/ui';
import { api, errorText } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { shortDate } from '@/lib/format';
import { colors, font, radius, row, textRight } from '@/lib/theme';
import type { Folder, MailSummary, Page } from '@/lib/types';

type Tab = Folder | 'external';

const FOLDERS: { key: Tab; label: string }[] = [
  { key: 'inbox', label: 'الوارد' },
  { key: 'sent', label: 'الصادر' },
  { key: 'important', label: 'المهمة' },
  { key: 'archived', label: 'المؤرشفة' },
  { key: 'drafts', label: 'المسودات' },
  { key: 'external', label: 'الخارجي' },
];

export default function MailScreen() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('inbox');
  const external = tab === 'external';
  const folder: Folder = external ? 'inbox' : tab;
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<MailSummary[] | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingMore = useRef(false);

  const load = useCallback(
    async (p = 1) => {
      const params = new URLSearchParams({ folder, page: String(p) });
      if (query.trim()) params.set('q', query.trim());
      try {
        const data = await api<Page<MailSummary>>(`/correspondences/?${params}`);
        setItems((prev) => (p === 1 || !prev ? data.results : [...prev, ...data.results]));
        setPage(p);
        setHasMore(!!data.next);
        setError(null);
      } catch (err) {
        setError(errorText(err));
        if (p === 1) setItems((prev) => prev ?? []);
      }
    },
    [folder, query],
  );

  useEffect(() => {
    if (external) return;
    setItems(null);
    const t = setTimeout(() => void load(1), query ? 350 : 0);
    return () => clearTimeout(t);
  }, [load, query, external]);

  // بالرجوع من رسالة/إرسال: تحديث صامت (حالة القراءة والردود الجديدة).
  const latestLoad = useRef(load);
  latestLoad.current = load;
  const focusedOnce = useRef(false);
  const externalRef = useRef(external);
  externalRef.current = external;
  useFocusEffect(
    useCallback(() => {
      if (focusedOnce.current && !externalRef.current) void latestLoad.current(1);
      focusedOnce.current = true;
    }, []),
  );

  const refresh = async () => {
    setRefreshing(true);
    await load(1);
    setRefreshing(false);
  };

  const more = async () => {
    if (!hasMore || loadingMore.current) return;
    loadingMore.current = true;
    await load(page + 1);
    loadingMore.current = false;
  };

  const actions = (m: MailSummary) => {
    tap();
    if (folder === 'drafts') {
      return Alert.alert(m.subject || 'مسودة', undefined, [
        {
          text: 'حذف المسودة',
          style: 'destructive',
          onPress: () =>
            api(`/correspondences/${m.id}/`, { method: 'DELETE' })
              .then(() => load(1))
              .catch((err) => Alert.alert('تعذر الحذف', errorText(err))),
        },
        { text: 'إلغاء', style: 'cancel' },
      ]);
    }
    const flag = async (body: Record<string, boolean>) => {
      try {
        await api(`/correspondences/${m.id}/flags/`, { method: 'POST', body });
        void load(1);
      } catch (err) {
        Alert.alert('تعذر التنفيذ', errorText(err));
      }
    };
    Alert.alert(m.subject || '(بلا عنوان)', undefined, [
      { text: m.is_important ? 'إزالة من المهمة' : 'تعليم كمهمة', onPress: () => void flag({ important: !m.is_important }) },
      { text: m.archived ? 'إرجاع من الأرشيف' : 'أرشفة', onPress: () => void flag({ archived: !m.archived }) },
      { text: 'إلغاء', style: 'cancel' },
    ]);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="البريد" right={<IconButton name="search" onPress={() => router.push('/search')} />} />
      <View style={styles.searchWrap}>
        <View style={[styles.search, { flexDirection: row }]}>
          <Ionicons name="search" size={18} color={colors.textMuted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={external ? 'بحث في البريد الخارجي' : 'بحث في البريد'}
            placeholderTextColor={colors.textMuted}
            style={[styles.searchInput, textRight]}
            returnKeyType="search"
          />
          {!!query && (
            <Pressable hitSlop={10} onPress={() => setQuery('')}>
              <Ionicons name="close-circle" size={18} color={colors.textMuted} />
            </Pressable>
          )}
        </View>
      </View>
      <View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.chips, { flexDirection: row }]}>
          {FOLDERS.map((f) => {
            const active = f.key === tab;
            return (
              <Pressable
                key={f.key}
                onPress={() => {
                  tap();
                  setTab(f.key);
                }}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text style={[styles.chipText, active && { color: '#fff' }]}>{f.label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {external ? (
        <ExternalList query={query} />
      ) : items === null ? (
        <Loading />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => (
            <MailRow mail={item} meId={user?.id} folder={folder} onPress={() => (folder === 'drafts' ? router.push({ pathname: '/compose', params: { draftId: item.id } }) : router.push(`/mail/${item.id}`))} onLongPress={() => actions(item)} />
          )}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          onEndReached={more}
          onEndReachedThreshold={0.4}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.navy} colors={[colors.navy]} />}
          contentContainerStyle={{ paddingTop: 6, paddingBottom: 110, flexGrow: 1 }}
          ListEmptyComponent={
            error ? (
              <Empty icon="cloud-offline-outline" title="تعذر التحميل" hint={error} />
            ) : (
              <Empty icon="mail-open-outline" title={query ? 'لا نتائج' : 'لا رسائل هنا'} hint={query ? 'جرّب كلمة أخرى' : undefined} />
            )
          }
        />
      )}

      <Pressable
        onPress={() => {
          tap();
          router.push(external ? '/external/compose' : '/compose');
        }}
        style={({ pressed }) => [styles.fab, pressed && { transform: [{ scale: 0.95 }] }]}
      >
        <Ionicons name="create-outline" size={24} color="#fff" />
        <Text style={styles.fabText}>{external ? 'رسالة خارجية' : 'رسالة جديدة'}</Text>
      </Pressable>
    </View>
  );
}

function MailRow({
  mail,
  meId,
  folder,
  onPress,
  onLongPress,
}: {
  mail: MailSummary;
  meId?: string;
  folder: Folder;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const mine = mail.sender.id === meId;
  const unread = !mine && !mail.read_at;
  const others = mail.participants.filter((p) => p.user.id !== meId).map((p) => p.user.full_name || p.user.username);
  const who = folder === 'sent' || mine ? `إلى: ${others.join('، ') || '—'}` : mail.sender.full_name || mail.sender.username;
  const avatarName = folder === 'sent' || mine ? others[0] : mail.sender.full_name;
  const urgent = mail.priority === 'urgent' || mail.priority === 'high';
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [styles.row, { flexDirection: row }, pressed && { backgroundColor: colors.navySoft }]}
    >
      <View style={{ alignItems: 'center', gap: 8 }}>
        <Avatar name={avatarName} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <View style={[{ flexDirection: row, alignItems: 'center', gap: 6 }]}>
          {unread && <View style={styles.dot} />}
          <T style={[styles.who, unread && { fontWeight: '800' }]} numberOfLines={1}>
            {who}
          </T>
          {(mail.thread_count ?? 1) > 1 && <Text style={styles.count}>{mail.thread_count}</Text>}
          <Text style={[styles.date, unread && { color: colors.navy, fontWeight: '700' }]}>
            {shortDate(mail.thread_last_at || mail.sent_at || mail.created_at)}
          </Text>
        </View>
        <View style={{ flexDirection: row, alignItems: 'center', gap: 6 }}>
          {urgent && <Ionicons name="alert-circle" size={15} color={colors.danger} />}
          {mail.is_important && <Ionicons name="star" size={14} color={colors.gold} />}
          <T style={[styles.subject, unread && { fontWeight: '700', color: colors.text }]} numberOfLines={1}>
            {mail.subject || '(بلا عنوان)'}
          </T>
          {mail.has_attachments && <Ionicons name="attach" size={16} color={colors.textMuted} />}
        </View>
        <T style={styles.preview} numberOfLines={2}>
          {mail.preview}
        </T>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  searchWrap: { paddingHorizontal: 16, paddingBottom: 8 },
  search: {
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 12,
    height: 44,
  },
  searchInput: { flex: 1, fontSize: font.body, color: colors.text, height: '100%' },
  chips: { gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  chip: {
    paddingHorizontal: 16,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
  },
  chipActive: { backgroundColor: colors.navy, borderColor: colors.navy },
  chipText: { fontSize: font.small, fontWeight: '600', color: colors.textSoft },
  row: { gap: 12, paddingHorizontal: 14, paddingVertical: 13, backgroundColor: '#fff', marginHorizontal: 14, borderRadius: 18 },
  sep: { height: 8 },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.gold },
  who: { flex: 1, fontSize: font.body, fontWeight: '600' },
  count: {
    fontSize: 11,
    color: colors.textSoft,
    backgroundColor: colors.bg,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  date: { fontSize: font.tiny, color: colors.textMuted },
  subject: { flex: 1, fontSize: 15, color: colors.textSoft, fontWeight: '500' },
  preview: { fontSize: font.small, color: colors.textMuted, lineHeight: 21 },
  fab: {
    position: 'absolute',
    bottom: 20,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.navy,
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
