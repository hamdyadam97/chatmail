/** مكونات الواجهة المشتركة: رأس الشاشة، الصورة الرمزية، الأزرار، الحقول، الحالات الفارغة. */
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState, type ComponentProps, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { initials } from '@/lib/format';
import { backIcon, colors, font, radius, row, textRight } from '@/lib/theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

export function tap() {
  void Haptics.selectionAsync().catch(() => undefined);
}

export function success() {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
}

/** نص عربي محاذى لليمين. */
export function T({ style, ...props }: TextProps) {
  return <Text {...props} style={[styles.text, textRight, style]} />;
}

/** رأس الشاشة: عنوان كبير (كتطبيقات iOS) مع رجوع اختياري وأزرار على الطرف الآخر. */
export function Header({
  title,
  back,
  right,
  large = true,
}: {
  title: string;
  back?: boolean;
  right?: ReactNode;
  large?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
      <View style={[styles.headerBar, { flexDirection: row }]}>
        {back ? (
          <Pressable hitSlop={12} onPress={() => router.back()} style={[styles.backBtn, { flexDirection: row }]}>
            <Ionicons name={backIcon} size={26} color={colors.navy} />
            <Text style={styles.backText}>رجوع</Text>
          </Pressable>
        ) : (
          <View />
        )}
        <View style={{ flexDirection: row, gap: 14, alignItems: 'center' }}>{right}</View>
      </View>
      {!!title && (
        <T style={large ? styles.largeTitle : styles.smallTitle} numberOfLines={large ? 1 : 2}>
          {title}
        </T>
      )}
    </View>
  );
}

export function IconButton({ name, onPress, color = colors.navy, size = 24 }: { name: IconName; onPress: () => void; color?: string; size?: number }) {
  return (
    <Pressable
      hitSlop={10}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.5 }]}
    >
      <Ionicons name={name} size={size} color={color} />
    </Pressable>
  );
}

const AVATAR_COLORS = ['#28255F', '#3B5BA9', '#7A4FA3', '#2F7D6B', '#B0662B', '#8E3B46', '#4B6584'];

export function Avatar({ name, size = 44 }: { name?: string; size?: number }) {
  const n = name ?? '';
  let h = 0;
  for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const bg = AVATAR_COLORS[h % AVATAR_COLORS.length];
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: size * 0.34 }}>{initials(n)}</Text>
    </View>
  );
}

export function Button({
  title,
  onPress,
  loading,
  disabled,
  variant = 'primary',
  icon,
  style,
}: {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'danger' | 'plain';
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}) {
  const v = VARIANTS[variant];
  return (
    <Pressable
      disabled={disabled || loading}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: v.bg, borderColor: v.border, flexDirection: row },
        (pressed || disabled) && { opacity: disabled ? 0.45 : 0.8 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={v.fg} />
      ) : (
        <>
          {icon && <Ionicons name={icon} size={20} color={v.fg} />}
          <Text style={[styles.buttonText, { color: v.fg }]}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

const VARIANTS = {
  primary: { bg: colors.navy, fg: '#fff', border: colors.navy },
  secondary: { bg: colors.card, fg: colors.navy, border: colors.border },
  danger: { bg: colors.dangerSoft, fg: colors.danger, border: colors.dangerSoft },
  plain: { bg: 'transparent', fg: colors.navy, border: 'transparent' },
};

export function Field({ icon, secure, style, ...props }: TextInputProps & { icon?: IconName; secure?: boolean }) {
  const [hidden, setHidden] = useState(true);
  return (
    <View style={[styles.field, { flexDirection: row }]}>
      {icon && <Ionicons name={icon} size={20} color={colors.textMuted} />}
      <TextInput
        placeholderTextColor={colors.textMuted}
        secureTextEntry={secure && hidden}
        {...props}
        style={[styles.fieldInput, textRight, style]}
      />
      {secure && (
        <Pressable hitSlop={10} onPress={() => setHidden((h) => !h)}>
          <Ionicons name={hidden ? 'eye-outline' : 'eye-off-outline'} size={20} color={colors.textMuted} />
        </Pressable>
      )}
    </View>
  );
}

export function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <View style={[styles.error, { flexDirection: row }]}>
      <Ionicons name="alert-circle" size={20} color={colors.danger} />
      <T style={{ color: colors.danger, flex: 1, fontSize: font.small }}>{message}</T>
    </View>
  );
}

export function Empty({ icon, title, hint }: { icon: IconName; title: string; hint?: string }) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Ionicons name={icon} size={34} color={colors.navy} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      {hint && <Text style={styles.emptyHint}>{hint}</Text>}
    </View>
  );
}

export function Loading() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 }}>
      <ActivityIndicator size="large" color={colors.navy} />
    </View>
  );
}

const styles = StyleSheet.create({
  text: { color: colors.text, fontSize: font.body },
  header: { backgroundColor: colors.bg, paddingHorizontal: 16, paddingBottom: 8 },
  headerBar: { alignItems: 'center', justifyContent: 'space-between', minHeight: 36 },
  backBtn: { alignItems: 'center', gap: 2 },
  backText: { color: colors.navy, fontSize: 17 },
  largeTitle: { fontSize: font.largeTitle, fontWeight: '800', color: colors.text, marginTop: 4 },
  smallTitle: { fontSize: font.title, fontWeight: '700', color: colors.text, marginTop: 6 },
  iconBtn: { padding: 2 },
  button: {
    height: 52,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    paddingHorizontal: 18,
  },
  buttonText: { fontSize: 17, fontWeight: '700' },
  field: {
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    height: 54,
  },
  fieldInput: { flex: 1, fontSize: 17, color: colors.text, height: '100%' },
  error: { alignItems: 'center', gap: 8, backgroundColor: colors.dangerSoft, borderRadius: radius.md, padding: 12 },
  empty: { alignItems: 'center', padding: 40, gap: 10, marginTop: 40 },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.navySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.text, textAlign: 'center' },
  emptyHint: { fontSize: font.small, color: colors.textSoft, textAlign: 'center', lineHeight: 21 },
});
