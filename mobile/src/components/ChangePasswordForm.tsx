import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';

import { Button, ErrorBox, Field, Header, T, success } from '@/components/ui';
import { api, errorText } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { colors, font } from '@/lib/theme';

export function ChangePasswordForm({ back, forced }: { back?: boolean; forced?: boolean }) {
  const { reloadUser, logout } = useAuth();
  const [oldPassword, setOld] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    if (next !== confirm) return setError('كلمتا المرور الجديدتان غير متطابقتين');
    setBusy(true);
    setError(null);
    try {
      await api('/auth/password/change/', { method: 'POST', body: { old_password: oldPassword, new_password: next } });
      success();
      setDone(true);
      await reloadUser();
      if (back) router.back();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Header title="تغيير كلمة المرور" back={back} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled">
        {forced && (
          <T style={{ color: colors.textSoft, fontSize: font.small, lineHeight: 22 }}>
            دخلت بكلمة مرور مؤقتة. اختر كلمة مرور جديدة خاصة بك للمتابعة.
          </T>
        )}
        <Field icon="lock-open-outline" placeholder="كلمة المرور الحالية" secure value={oldPassword} onChangeText={setOld} />
        <Field icon="lock-closed-outline" placeholder="كلمة المرور الجديدة" secure value={next} onChangeText={setNext} />
        <Field icon="lock-closed-outline" placeholder="تأكيد كلمة المرور الجديدة" secure value={confirm} onChangeText={setConfirm} />
        <T style={{ color: colors.textMuted, fontSize: font.tiny, lineHeight: 19 }}>
          10 أحرف على الأقل، ولا تشبه اسم المستخدم. ستُغلق جلساتك على الأجهزة الأخرى.
        </T>
        <ErrorBox message={error} />
        <Button title="حفظ" loading={busy} disabled={done || !oldPassword || !next || !confirm} onPress={submit} />
        {forced && (
          <View style={{ marginTop: 8 }}>
            <Button title="تسجيل الخروج" variant="plain" onPress={() => void logout()} />
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
