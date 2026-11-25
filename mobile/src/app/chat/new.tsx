/**
 * محادثة جديدة: زميل واحد = محادثة مباشرة فورًا؛ أو «مجموعة جديدة»: اختيار
 * عدة زملاء واسم للمجموعة. البحث بالاسم أو الفرع.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Avatar, Button, Header, Loading, T, tap } from '@/components/ui';
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
  const [group, setGroup] = useState(false);
  const [picked, setPicked] = useState<DirectoryUser[]>([]);
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);

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

  const openDm = async (u: DirectoryUser) => {
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

  const toggle = (u: DirectoryUser) => {
    tap();
    setPicked((p) => (p.some((x) => x.id === u.id) ? p.filter((x) => x.id !== u.id) : [...p, u]));
  };

  const createGroup = async () => {
    setCreating(true);
    try {
      const c = await chatApi.create('group', picked.map((u) => String(u.id)), title.trim());
      router.replace({ pathname: '/chat/[id]', params: { id: c.id, name: title.trim() || 'مجموعة' } });
    } catch (err) {
      Alert.alert('تعذر إنشاء المجموعة', errorText(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title={group ? 'مجموعة جديدة' : 'محادثة جديدة'} back />
      {group && (
        <View style={{ paddingHorizontal: 16, gap: 8, marginBottom: 8 }}>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="اسم المجموعة"
            placeholderTextColor={colors.textMuted}
            maxLength={200}
            style={[styles.title, textRight]}
          />
          {picked.length > 0 && (
            <View style={{ flexDirection: row, flexWrap: 'wrap', gap: 6 }}>
              {picked.map((u) => (
                <Pressable key={String(u.id)} onPress={() => toggle(u)} style={[styles.pill, { flexDirection: row }]}>
                  <Text style={styles.pillText}>{u.full_name || u.username}</Text>
                  <Ionicons name="close" size={14} color={colors.navy} />
                </Pressable>
              ))}
            </View>
          )}
          <Button
            title={`إنشاء المجموعة${picked.length ? ` (${picked.length + 1} أعضاء)` : ''}`}
            icon="people"
            loading={creating}
            disabled={picked.length < 2 || !title.trim()}
            onPress={createGroup}
          />
        </View>
      )}
      <View style={[styles.search, { flexDirection: row }]}>
        <Ionicons name="search" size={18} color={colors.textMuted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="ابحث بالاسم أو الفرع"
          placeholderTextColor={colors.textMuted}
          style={[{ flex: 1, fontSize: font.body, color: colors.text }, textRight]}
        />
      </View>
      {!group && (
        <Pressable onPress={() => setGroup(true)} style={({ pressed }) => [styles.row, { flexDirection: row }, pressed && { backgroundColor: colors.navySoft }]}>
          <View style={styles.groupIcon}>
            <Ionicons name="people" size={22} color="#fff" />
          </View>
          <T style={{ flex: 1, fontWeight: '700', color: colors.navy }}>مجموعة جديدة</T>
        </Pressable>
      )}
      {users === null ? (
        <Loading />
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(u) => String(u.id)}
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          renderItem={({ item: u }) => {
            const on = picked.some((x) => x.id === u.id);
            return (
              <Pressable
                disabled={!!opening}
                onPress={() => (group ? toggle(u) : void openDm(u))}
                style={({ pressed }) => [styles.row, { flexDirection: row }, pressed && { backgroundColor: colors.navySoft }]}
              >
                <Avatar name={u.full_name} size={42} />
                <View style={{ flex: 1 }}>
                  <T style={{ fontWeight: '600' }}>{u.full_name || u.username}</T>
                  {!!unit(u) && <T style={{ fontSize: font.tiny, color: colors.textMuted }}>{unit(u)}</T>}
                </View>
                {group && <Ionicons name={on ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={on ? colors.navy : colors.border} />}
                {opening === String(u.id) && <ActivityIndicator color={colors.navy} />}
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  search: { alignItems: 'center', gap: 8, marginHorizontal: 16, marginBottom: 10, backgroundColor: '#E8E8EF', borderRadius: radius.md, paddingHorizontal: 12, height: 42 },
  row: { alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: '#fff' },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginHorizontal: 16 },
  groupIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.navy, alignItems: 'center', justifyContent: 'center' },
  title: { backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, height: 48, fontSize: font.body, color: colors.text },
  pill: { alignItems: 'center', gap: 4, backgroundColor: colors.navySoft, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  pillText: { color: colors.navy, fontSize: font.small, fontWeight: '600' },
});
