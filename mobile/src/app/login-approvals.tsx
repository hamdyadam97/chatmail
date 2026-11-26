/** طلبات الدخول: كود دخول أرسلته لنفسي من جهاز جديد (و— للمسؤولين — ما أُرسل لهم). */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { Text } from '@/components/Text';

import { Button, Empty, Header, Loading, T } from '@/components/ui';
import { api, errorText } from '@/lib/api';
import { shortDate } from '@/lib/format';
import { colors, font, radius, row } from '@/lib/theme';

interface Approval {
  id: string;
  mine: boolean;
  user: { full_name: string; username: string };
  device_label: string;
  code: string;
  created_at: string;
}

export default function LoginApprovalsScreen() {
  const [items, setItems] = useState<Approval[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await api<Approval[]>('/auth/login-approvals/'));
    } catch {
      setItems((p) => p ?? []);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const reject = (a: Approval) =>
    Alert.alert(a.mine ? 'ليس أنا؟' : 'رفض الطلب؟', a.mine ? 'سيُرفض الطلب. غيّر كلمة مرورك إن لم تكن أنت.' : undefined, [
      { text: 'إلغاء', style: 'cancel' },
      {
        text: 'رفض',
        style: 'destructive',
        onPress: async () => {
          try {
            await api(`/auth/login-approvals/${a.id}/reject/`, { method: 'POST' });
            void load();
          } catch (err) {
            Alert.alert('تعذر الرفض', errorText(err));
          }
        },
      },
    ]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="طلبات الدخول" back />
      {items === null ? (
        <Loading />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(a) => a.id}
          contentContainerStyle={{ padding: 16, gap: 12, flexGrow: 1 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                await load();
                setRefreshing(false);
              }}
              tintColor={colors.navy}
            />
          }
          ListEmptyComponent={<Empty icon="shield-checkmark-outline" title="لا طلبات دخول الآن" hint="حين تطلب كودًا لنفسك من جهاز جديد يظهر هنا." />}
          renderItem={({ item: a }) => (
            <View style={styles.card}>
              <View style={{ flexDirection: row, alignItems: 'center', gap: 10 }}>
                <Ionicons name="phone-portrait-outline" size={22} color={colors.navy} />
                <View style={{ flex: 1 }}>
                  <T style={{ fontWeight: '700' }}>{a.mine ? 'محاولة دخول لحسابك' : a.user.full_name || a.user.username}</T>
                  <T style={{ fontSize: font.tiny, color: colors.textMuted }}>
                    {a.device_label} — {shortDate(a.created_at)}
                  </T>
                </View>
              </View>
              <Text style={styles.code} selectable>
                {a.code}
              </Text>
              <Button title={a.mine ? 'ليس أنا' : 'رفض'} variant="danger" onPress={() => reject(a)} />
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: radius.lg, padding: 16, gap: 12 },
  code: { fontSize: 34, fontWeight: '800', letterSpacing: 8, textAlign: 'center', color: colors.navy, fontVariant: ['tabular-nums'] },
});
