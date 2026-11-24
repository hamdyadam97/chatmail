/** حسابي: البيانات، طلبات الدخول، تغيير كلمة المرور، والخروج. */
import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Avatar, Header, IconName, T, tap } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { pushSupported } from '@/lib/push';
import { colors, font, forwardIcon, radius, row } from '@/lib/theme';
import type { Profile } from '@/lib/types';

export default function AccountScreen() {
  const { user, logout } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    api<Profile>('/users/me/profile/').then(setProfile).catch(() => undefined);
  }, []);

  const unitText = [profile?.membership?.branch || profile?.membership?.institute, profile?.membership?.job_title].filter(Boolean).join(' — ');

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="حسابي" />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 18, paddingBottom: 40 }}>
        <View style={[styles.card, styles.profile]}>
          <Avatar name={user?.full_name} size={76} />
          <Text style={styles.name}>{user?.full_name || user?.username}</Text>
          <Text style={styles.username}>{user?.username}</Text>
          {!!unitText && <Text style={styles.unit}>{unitText}</Text>}
          {!!profile?.roles?.length && (
            <View style={{ flexDirection: row, flexWrap: 'wrap', gap: 6, justifyContent: 'center', marginTop: 4 }}>
              {profile.roles.map((r) => (
                <Text key={`${r.code}-${r.scope}`} style={styles.role}>
                  {r.name}
                </Text>
              ))}
            </View>
          )}
        </View>

        <Group>
          {!!profile?.external_address && <Item icon="globe-outline" title="بريدي الخارجي" value={profile.external_address} />}
          {!!profile?.phone && <Item icon="call-outline" title="الجوال" value={profile.phone} />}
          <Item icon="key-outline" title="طلبات الدخول" hint="أكواد الدخول المرسلة لي" onPress={() => router.push('/login-approvals')} />
          <Item icon="lock-closed-outline" title="تغيير كلمة المرور" onPress={() => router.push('/password')} />
          <Item
            icon="notifications-outline"
            title="الإشعارات"
            hint={pushSupported() ? 'تصلك على هذا الهاتف' : 'تعمل في النسخة المثبّتة من التطبيق'}
          />
        </Group>

        <Group>
          <Item
            icon="log-out-outline"
            title="تسجيل الخروج"
            danger
            onPress={() =>
              Alert.alert('تسجيل الخروج؟', 'ستحتاج كلمة المرور للدخول مرة أخرى.', [
                { text: 'إلغاء', style: 'cancel' },
                { text: 'خروج', style: 'destructive', onPress: () => void logout() },
              ])
            }
          />
        </Group>

        <Text style={styles.version}>نظام المراسلات — الإصدار {Constants.expoConfig?.version}</Text>
      </ScrollView>
    </View>
  );
}

function Group({ children }: { children: ReactNode }) {
  return <View style={[styles.card, { overflow: 'hidden' }]}>{children}</View>;
}

function Item({ icon, title, value, hint, danger, onPress }: { icon: IconName; title: string; value?: string; hint?: string; danger?: boolean; onPress?: () => void }) {
  return (
    <Pressable
      disabled={!onPress}
      onPress={() => {
        tap();
        onPress?.();
      }}
      style={({ pressed }) => [styles.item, { flexDirection: row }, pressed && { backgroundColor: colors.navySoft }]}
    >
      <View style={[styles.itemIcon, danger && { backgroundColor: colors.dangerSoft }]}>
        <Ionicons name={icon} size={19} color={danger ? colors.danger : colors.navy} />
      </View>
      <View style={{ flex: 1 }}>
        <T style={[{ fontSize: font.body, fontWeight: '600' }, danger && { color: colors.danger }]}>{title}</T>
        {!!hint && <T style={{ fontSize: font.tiny, color: colors.textMuted }}>{hint}</T>}
      </View>
      {!!value && (
        <Text style={styles.value} numberOfLines={1}>
          {value}
        </Text>
      )}
      {onPress && !danger && <Ionicons name={forwardIcon} size={18} color={colors.textMuted} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: radius.lg },
  profile: { alignItems: 'center', padding: 22, gap: 4 },
  name: { fontSize: 21, fontWeight: '800', color: colors.text, marginTop: 8, textAlign: 'center' },
  username: { fontSize: font.small, color: colors.textMuted },
  unit: { fontSize: font.small, color: colors.textSoft, textAlign: 'center' },
  role: {
    fontSize: font.tiny,
    color: colors.navy,
    backgroundColor: colors.navySoft,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  item: {
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  itemIcon: { width: 34, height: 34, borderRadius: 9, backgroundColor: colors.navySoft, alignItems: 'center', justifyContent: 'center' },
  value: { fontSize: font.small, color: colors.textMuted, maxWidth: '55%' },
  version: { textAlign: 'center', color: colors.textMuted, fontSize: font.tiny },
});
