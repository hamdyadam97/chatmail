/** التعميم: يُعلَّم مقروءًا عند الفتح، وزر «أقرّ بالاطلاع» إن طُلب الإقرار. */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '@/components/Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Empty, Header, Loading, T, success } from '@/components/ui';
import { errorText } from '@/lib/api';
import { announcementsApi, type Announcement } from '@/lib/chat';
import { fullDate } from '@/lib/format';
import { colors, font, radius, row } from '@/lib/theme';

export default function AnnouncementScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const [a, setA] = useState<Announcement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    announcementsApi
      .get(id)
      .then((x) => {
        setA(x);
        if (x.mine && !x.mine.read_at && x.status === 'published') void announcementsApi.read(id).catch(() => undefined);
      })
      .catch((err) => setError(errorText(err)));
  }, [id]);

  if (error || !a) {
    return (
      <View style={{ flex: 1 }}>
        <Header title="" back />
        {error ? <Empty icon="alert-circle-outline" title="تعذر فتح التعميم" hint={error} /> : <Loading />}
      </View>
    );
  }

  const needsAck = a.requires_ack && a.mine && !a.mine.observer && !a.mine.acknowledged_at && a.status === 'published';

  const ack = async () => {
    setBusy(true);
    try {
      const r = await announcementsApi.ack(a.id);
      setA({ ...a, mine: { ...(a.mine ?? { delivered_at: null, read_at: null }), acknowledged_at: r.acknowledged_at } });
      success();
    } catch (err) {
      Alert.alert('تعذر تسجيل الإقرار', errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="" back />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: needsAck ? 120 : 40 }}>
        {a.status === 'withdrawn' ? (
          <Empty icon="eye-off-outline" title="سُحب هذا التعميم" hint="لم يعد محتواه متاحًا." />
        ) : (
          <>
            <View style={{ gap: 6 }}>
              {a.priority !== 'normal' && (
                <Text style={styles.priority}>{a.priority === 'urgent' ? 'عاجل' : 'مهم'}</Text>
              )}
              <T style={styles.title}>{a.content?.title}</T>
              <T style={styles.meta}>
                {a.publisher.full_name} — {fullDate(a.published_at)}
              </T>
              {!!a.reference_number && <T style={styles.meta}>{a.reference_number}</T>}
            </View>
            <View style={styles.card}>
              <T style={styles.body} selectable>
                {a.content?.body}
              </T>
            </View>
            {a.mine?.acknowledged_at && (
              <View style={[styles.done, { flexDirection: row }]}>
                <Ionicons name="checkmark-circle" size={22} color={colors.success} />
                <T style={{ flex: 1, color: colors.success, fontWeight: '700' }}>أقررت بالاطلاع — {fullDate(a.mine.acknowledged_at)}</T>
              </View>
            )}
          </>
        )}
      </ScrollView>
      {needsAck && (
        <View style={[styles.bar, { paddingBottom: insets.bottom + 10 }]}>
          {!!a.ack_due_at && <T style={[styles.meta, { textAlign: 'center' }]}>مطلوب الإقرار قبل {fullDate(a.ack_due_at)}</T>}
          <Button title="أقرّ بالاطلاع" icon="checkmark-done" loading={busy} onPress={ack} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 24, fontWeight: '800', lineHeight: 33 },
  meta: { fontSize: font.small, color: colors.textMuted },
  priority: {
    alignSelf: 'flex-start',
    color: colors.danger,
    backgroundColor: colors.dangerSoft,
    fontWeight: '800',
    fontSize: font.tiny,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 8,
    overflow: 'hidden',
  },
  card: { backgroundColor: '#fff', borderRadius: radius.lg, padding: 16 },
  body: { fontSize: 17, lineHeight: 29 },
  done: { alignItems: 'center', gap: 8, backgroundColor: '#E5F5EA', padding: 14, borderRadius: radius.md },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 16, gap: 8, backgroundColor: 'rgba(255,255,255,0.97)', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
});
