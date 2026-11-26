/** الدخول: شعار المؤسسة ← اسم المستخدم وكلمة المرور ← (رمز MFA) ← (كود الجهاز الجديد أول مرة). */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '@/components/Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, ErrorBox, Field, T, success } from '@/components/ui';
import { errorText } from '@/lib/api';
import { useAuth, type Challenge } from '@/lib/auth';
import { colors, font, radius, row } from '@/lib/theme';

type Step =
  | { kind: 'password' }
  | { kind: 'mfa'; token: string }
  | { kind: 'choose'; token: string; canSendToSelf: boolean }
  | { kind: 'code'; token: string; canSendToSelf: boolean; sentTo: ('self' | 'admin')[] };

export default function LoginScreen() {
  const auth = useAuth();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const next = (c: Challenge | null) => {
    if (!c) return success();
    if (c.kind === 'mfa') setStep({ kind: 'mfa', token: c.token });
    else setStep({ kind: 'choose', token: c.token, canSendToSelf: c.canSendToSelf });
  };

  const send = (token: string, canSendToSelf: boolean, to: 'self' | 'admin', already: ('self' | 'admin')[] = []) =>
    run(async () => {
      await auth.sendCode(token, to);
      setStep({ kind: 'code', token, canSendToSelf, sentTo: [...already, to] });
    });

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: '#fff' }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={[styles.wrap, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Image source={require('../../assets/logo-full.png')} style={styles.logo} resizeMode="contain" />
        <Text style={styles.title}>نظام المراسلات الداخلية</Text>

        <View style={styles.form}>
          {step.kind === 'password' && (
            <>
              <Field
                icon="person-outline"
                placeholder="اسم المستخدم"
                autoCapitalize="none"
                autoCorrect={false}
                value={username}
                onChangeText={setUsername}
                textContentType="username"
                returnKeyType="next"
              />
              <Field
                icon="lock-closed-outline"
                placeholder="كلمة المرور"
                secure
                value={password}
                onChangeText={setPassword}
                textContentType="password"
                returnKeyType="go"
                onSubmitEditing={() => run(async () => next(await auth.login(username.trim(), password)))}
              />
              <ErrorBox message={error} />
              <Button
                title="دخول"
                loading={busy}
                disabled={!username.trim() || !password}
                onPress={() => run(async () => next(await auth.login(username.trim(), password)))}
              />
            </>
          )}

          {step.kind === 'mfa' && (
            <>
              <T style={styles.hint}>اكتب الرمز من تطبيق المصادقة على هاتفك.</T>
              <Field icon="key-outline" placeholder="رمز التحقق" keyboardType="number-pad" value={otp} onChangeText={setOtp} maxLength={8} />
              <ErrorBox message={error} />
              <Button title="تحقق" loading={busy} disabled={otp.length < 6} onPress={() => run(async () => next(await auth.verifyMfa(step.token, otp)))} />
            </>
          )}

          {step.kind === 'choose' && (
            <>
              <View style={[styles.notice, { flexDirection: row }]}>
                <Ionicons name="phone-portrait-outline" size={22} color={colors.navy} />
                <T style={{ flex: 1, fontSize: font.small, lineHeight: 22 }}>
                  أول دخول من هذا الهاتف يحتاج كودًا من 6 أرقام. اختر أين يصلك الكود:
                </T>
              </View>
              <Choice
                icon="laptop-outline"
                title="أرسله لي"
                hint={step.canSendToSelf ? 'يظهر على جهازك الآخر المسجّل دخوله (صفحة «طلبات الدخول»)' : 'لا يوجد جهاز آخر مسجّل دخوله بحسابك'}
                disabled={!step.canSendToSelf || busy}
                onPress={() => send(step.token, step.canSendToSelf, 'self')}
              />
              <Choice
                icon="shield-checkmark-outline"
                title="أرسله لمسؤول النظام"
                hint="يعطيك الكود بعد التأكد منك"
                disabled={busy}
                onPress={() => send(step.token, step.canSendToSelf, 'admin')}
              />
              <ErrorBox message={error} />
            </>
          )}

          {step.kind === 'code' && (
            <>
              <T style={styles.hint}>
                {step.sentTo.includes('self') ? 'افتح «طلبات الدخول» على جهازك الآخر وانسخ الكود. ' : ''}
                {step.sentTo.includes('admin') ? 'أُرسل الكود لمسؤول النظام — اطلبه منه. ' : ''}
                الكود صالح 30 دقيقة.
              </T>
              <Field
                icon="keypad-outline"
                placeholder="الكود (6 أرقام)"
                keyboardType="number-pad"
                value={code}
                onChangeText={(v) => setCode(v.replace(/\D/g, ''))}
                maxLength={6}
                style={{ letterSpacing: 6, fontWeight: '700' }}
              />
              <ErrorBox message={error} />
              <Button title="دخول" loading={busy} disabled={code.length !== 6} onPress={() => run(() => auth.submitCode(step.token, code))} />
              {!step.sentTo.includes('admin') && (
                <Button title="لم يصلني؟ أرسله لمسؤول النظام" variant="plain" onPress={() => send(step.token, step.canSendToSelf, 'admin', step.sentTo)} />
              )}
            </>
          )}

          {step.kind !== 'password' && (
            <Button
              title="رجوع"
              variant="plain"
              onPress={() => {
                setError(null);
                setStep({ kind: 'password' });
              }}
            />
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Choice({ icon, title, hint, disabled, onPress }: { icon: 'laptop-outline' | 'shield-checkmark-outline'; title: string; hint: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.choice, { flexDirection: row }, disabled && { opacity: 0.45 }, pressed && { backgroundColor: colors.navySoft }]}
    >
      <View style={styles.choiceIcon}>
        <Ionicons name={icon} size={22} color={colors.navy} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <T style={{ fontWeight: '700' }}>{title}</T>
        <T style={{ fontSize: font.tiny, color: colors.textSoft }}>{hint}</T>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 24, flexGrow: 1 },
  logo: { width: '100%', height: 150, alignSelf: 'center' },
  title: { fontSize: 22, fontWeight: '800', color: colors.navy, textAlign: 'center', marginTop: 18, marginBottom: 28 },
  form: { gap: 14 },
  hint: { color: colors.textSoft, fontSize: font.small, lineHeight: 22 },
  notice: { gap: 10, alignItems: 'center', backgroundColor: colors.goldSoft, padding: 14, borderRadius: radius.md },
  choice: {
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#fff',
  },
  choiceIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.navySoft, alignItems: 'center', justifyContent: 'center' },
});
