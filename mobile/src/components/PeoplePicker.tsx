/** اختيار موظفين من الدليل: بحث بالاسم أو الفرع، والمختارون شرائح تُزال بالضغط. */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '@/components/Text';

import { Avatar, T } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { colors, font, radius, row, textRight } from '@/lib/theme';
import type { DirectoryUser } from '@/lib/types';

const unit = (u: DirectoryUser) => u.primary_membership?.branch || u.primary_membership?.institute || '';

let cache: DirectoryUser[] | null = null;

export function PeoplePicker({ value, onChange, placeholder = 'اكتب اسم الموظف' }: { value: DirectoryUser[]; onChange: (v: DirectoryUser[]) => void; placeholder?: string }) {
  const { user } = useAuth();
  const [users, setUsers] = useState<DirectoryUser[]>(cache ?? []);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (cache) return;
    api<DirectoryUser[] | { results: DirectoryUser[] }>('/users/')
      .then((d) => {
        cache = Array.isArray(d) ? d : d.results ?? [];
        setUsers(cache);
      })
      .catch(() => undefined);
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const taken = new Set([...value.map((u) => String(u.id)), String(user?.id)]);
    return users
      .filter((u) => !taken.has(String(u.id)))
      .filter((u) => (u.full_name ?? '').toLowerCase().includes(q) || (u.username ?? '').toLowerCase().includes(q) || unit(u).toLowerCase().includes(q))
      .slice(0, 8);
  }, [users, query, value, user]);

  return (
    <View style={{ gap: 8 }}>
      {value.length > 0 && (
        <View style={{ flexDirection: row, flexWrap: 'wrap', gap: 6 }}>
          {value.map((u) => (
            <Pressable key={String(u.id)} onPress={() => onChange(value.filter((x) => x.id !== u.id))} style={[styles.pill, { flexDirection: row }]}>
              <Text style={styles.pillText}>{u.full_name || u.username}</Text>
              <Ionicons name="close" size={14} color={colors.navy} />
            </Pressable>
          ))}
        </View>
      )}
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        autoCorrect={false}
        style={[styles.input, textRight]}
      />
      {matches.length > 0 && (
        <View style={styles.list}>
          {matches.map((u) => (
            <Pressable
              key={String(u.id)}
              onPress={() => {
                onChange([...value, u]);
                setQuery('');
              }}
              style={({ pressed }) => [styles.option, { flexDirection: row }, pressed && { backgroundColor: colors.navySoft }]}
            >
              <Avatar name={u.full_name} size={32} />
              <View style={{ flex: 1 }}>
                <T style={{ fontWeight: '600', fontSize: font.small }}>{u.full_name || u.username}</T>
                {!!unit(u) && <T style={{ fontSize: font.tiny, color: colors.textMuted }}>{unit(u)}</T>}
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { alignItems: 'center', gap: 4, backgroundColor: colors.navySoft, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  pillText: { color: colors.navy, fontSize: font.small, fontWeight: '600' },
  input: { backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, height: 46, fontSize: font.body, color: colors.text },
  list: { backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  option: { alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8 },
});
