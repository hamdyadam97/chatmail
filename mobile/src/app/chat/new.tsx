/** محادثة جديدة: اختيار زميل من الدليل (بحث بالاسم أو الفرع) يفتح المحادثة المباشرة معه. */
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Avatar, Header, Loading, T } from '@/components/ui';
import { api, errorText } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { chatApi } from '@/lib/chat';
import { colors, font, radius, row, textRight } from '@/lib/theme';
import type { DirectoryUser } from '@/lib/types';

const unit = (u: DirectoryUser) => u.primary_membership?.branch || u.primary_membership?.institute || '';

export default function NewChatScreen() {
  const { user } = useAuth();
  const [users, setUsers] = useState<DirectoryUser[] | null>(null);
  const [query, setQuery] = useState('');
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    api<DirectoryUser[] | { results: DirectoryUser[] }>('/users/')
      .then((d) => setUsers((Array.isArray(d) ? d : d.results ?? []).filter((u) => String(u.id) !== user?.id)))
      .catch(() => setUsers([]));
  }, [user?.id]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (users ?? [])
      .filter((u) => !q || (u.full_name ?? '').toLowerCase().includes(q) || (u.username ?? '').toLowerCase().includes(q) || unit(u).toLowerCase().includes(q))
      .slice(0, 100);
  }, [users, query]);

  const open = async (u: DirectoryUser) => {
    setOpening(String(u.id));
    try {
      const c = await chatApi.create('dm', [String(u.id)]);
      router.replace({ pathname: '/chat/[id]', params: { id: c.id, name: u.full_name || u.username || '' } });
    } catch (err) {
      Alert.alert('تعذر فتح المحادثة', errorText(err));
    } finally {
      setOpening(null);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="محادثة جديدة" back />
      <View style={[styles.search, { flexDirection: row }]}>
        <Ionicons name="search" size={18} color={colors.textMuted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="ابحث بالاسم أو الفرع"
          placeholderTextColor={colors.textMuted}
          autoFocus
          style={[{ flex: 1, fontSize: font.body, color: colors.text }, textRight]}
        />
      </View>
      {users === null ? (
        <Loading />
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(u) => String(u.id)}
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          renderItem={({ item: u }) => (
            <Pressable
              disabled={!!opening}
              onPress={() => void open(u)}
              style={({ pressed }) => [styles.row, { flexDirection: row }, pressed && { backgroundColor: colors.navySoft }]}
            >
              <Avatar name={u.full_name} size={42} />
              <View style={{ flex: 1 }}>
                <T style={{ fontWeight: '600' }}>{u.full_name || u.username}</T>
                {!!unit(u) && <T style={{ fontSize: font.tiny, color: colors.textMuted }}>{unit(u)}</T>}
              </View>
              {opening === String(u.id) && <ActivityIndicator color={colors.navy} />}
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  search: { alignItems: 'center', gap: 8, marginHorizontal: 16, marginBottom: 10, backgroundColor: '#E8E8EF', borderRadius: radius.md, paddingHorizontal: 12, height: 42 },
  row: { alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: '#fff' },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginHorizontal: 16 },
});
