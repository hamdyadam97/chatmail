/** البحث الشامل: المراسلات والمحادثات والتعاميم والبريد الخارجي — ما يحق لي قراءته فقط. */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '@/components/Text';

import { Empty, Header, IconName, Loading, T, tap } from '@/components/ui';
import { api, errorText } from '@/lib/api';
import { shortDate } from '@/lib/format';
import { colors, font, radius, row, textRight } from '@/lib/theme';

type Kind = 'correspondence' | 'announcement' | 'external' | 'chat';

interface Hit {
  kind: Kind;
  id: string;
  title: string;
  snippet: string;
  meta: string;
  date: string | null;
  link: string;
}

const KINDS: { key: Kind | ''; label: string }[] = [
  { key: '', label: 'الكل' },
  { key: 'correspondence', label: 'المراسلات' },
  { key: 'chat', label: 'المحادثات' },
  { key: 'announcement', label: 'التعاميم' },
  { key: 'external', label: 'الخارجي' },
];

const KIND_META: Record<Kind, { label: string; icon: IconName }> = {
  correspondence: { label: 'مراسلة', icon: 'mail-outline' },
  chat: { label: 'محادثة', icon: 'chatbubbles-outline' },
  announcement: { label: 'تعميم', icon: 'megaphone-outline' },
  external: { label: 'بريد خارجي', icon: 'globe-outline' },
};

/** رابط الموقع ← شاشة التطبيق. */
function routeOf(hit: Hit): string | null {
  const id = hit.link.split('/').filter(Boolean).pop();
  if (!id) return null;
  switch (hit.kind) {
    case 'correspondence':
      return `/mail/${id}`;
    case 'external':
      return `/external/${id}`;
    case 'announcement':
      return `/announcements/${id}`;
    case 'chat':
      return `/chat/${id}`;
  }
}

/** كلمات البحث بارزة كما كُتبت. */
function Highlighted({ text, query, style, lines }: { text: string; query: string; style: object; lines: number }) {
  const words = query.split(/\s+/).filter((w) => w.length > 1).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return <T style={style} numberOfLines={lines}>{text}</T>;
  const parts = text.split(new RegExp(`(${words.join('|')})`, 'gi'));
  return (
    <T style={style} numberOfLines={lines}>
      {parts.map((p, i) => (
        <Text key={i} style={i % 2 === 1 ? styles.mark : undefined}>
          {p}
        </Text>
      ))}
    </T>
  );
}

export default function SearchScreen() {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<Kind | ''>('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState('');
  const seq = useRef(0);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) {
      setHits(null);
      return;
    }
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const params = new URLSearchParams({ q: text });
        if (kind) params.set('kind', kind);
        const data = await api<{ results: Hit[] }>(`/search/?${params}`);
        if (mine !== seq.current) return;
        setHits(data.results);
        setSearched(text);
        setError(null);
      } catch (err) {
        if (mine === seq.current) setError(errorText(err, 'تعذر البحث'));
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    }, 450);
    return () => clearTimeout(t);
  }, [q, kind]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="البحث" back />
      <View style={styles.searchWrap}>
        <View style={[styles.search, { flexDirection: row }]}>
          <Ionicons name="search" size={18} color={colors.textMuted} />
          <TextInput
            value={q}
            onChangeText={setQ}
            autoFocus
            placeholder="ابحث في البريد والمحادثات والتعاميم…"
            placeholderTextColor={colors.textMuted}
            style={[styles.searchInput, textRight]}
            returnKeyType="search"
          />
          {!!q && (
            <Pressable hitSlop={10} onPress={() => setQ('')}>
              <Ionicons name="close-circle" size={18} color={colors.textMuted} />
            </Pressable>
          )}
        </View>
      </View>
      <View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.chips, { flexDirection: row }]}>
          {KINDS.map((k) => {
            const active = k.key === kind;
            return (
              <Pressable
                key={k.label}
                onPress={() => {
                  tap();
                  setKind(k.key);
                }}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text style={[styles.chipText, active && { color: '#fff' }]}>{k.label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
      {busy && hits === null ? (
        <Loading />
      ) : hits === null ? (
        <Empty icon="search-outline" title="اكتب كلمتين على الأقل" hint="يبحث في بريدك ومحادثاتك وتعاميمك فقط — ما يحق لك قراءته." />
      ) : (
        <FlatList
          data={hits}
          keyExtractor={(h) => `${h.kind}:${h.id}`}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ flexGrow: 1, paddingBottom: 40 }}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          ListEmptyComponent={
            error ? <Empty icon="cloud-offline-outline" title="تعذر البحث" hint={error} /> : <Empty icon="search-outline" title="لا نتائج" hint="جرّب كلمات أخرى" />
          }
          renderItem={({ item }) => {
            const meta = KIND_META[item.kind];
            return (
              <Pressable
                onPress={() => {
                  const r = routeOf(item);
                  if (r) router.push(r as never);
                }}
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.navySoft }]}
              >
                <View style={{ flexDirection: row, alignItems: 'center', gap: 6 }}>
                  <Ionicons name={meta.icon} size={15} color={colors.textMuted} />
                  <Text style={styles.kind}>{meta.label}</Text>
                  {!!item.meta && (
                    <T style={[styles.kind, { flex: 1 }]} numberOfLines={1}>
                      · {item.meta}
                    </T>
                  )}
                  {!!item.date && <Text style={styles.kind}>{shortDate(item.date)}</Text>}
                </View>
                {!!item.title && <Highlighted text={item.title} query={searched} style={styles.title} lines={1} />}
                <Highlighted text={item.snippet} query={searched} style={styles.snippet} lines={2} />
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  searchWrap: { paddingHorizontal: 16, paddingBottom: 8 },
  search: { alignItems: 'center', gap: 8, backgroundColor: '#ECE8DF', borderRadius: radius.md, paddingHorizontal: 12, height: 42 },
  searchInput: { flex: 1, fontSize: font.body, color: colors.text, height: '100%' },
  chips: { gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  chip: { paddingHorizontal: 16, height: 34, borderRadius: 17, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, justifyContent: 'center' },
  chipActive: { backgroundColor: colors.navy, borderColor: colors.navy },
  chipText: { fontSize: font.small, fontWeight: '600', color: colors.textSoft },
  row: { gap: 4, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#fff' },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginHorizontal: 16 },
  kind: { fontSize: font.tiny, color: colors.textMuted },
  title: { fontSize: font.body, fontWeight: '700' },
  snippet: { fontSize: font.small, color: colors.textSoft, lineHeight: 21 },
  mark: { backgroundColor: '#FCE9B8', color: colors.text },
});
