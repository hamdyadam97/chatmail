/** توقيعي: يُعرض المحفوظ، ويُرسم من جديد بالإصبع. */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Image, ScrollView, StyleSheet, View } from 'react-native';

import { SignaturePad } from '@/components/SignaturePad';
import { Button, Header, Loading, T } from '@/components/ui';
import { api, errorText } from '@/lib/api';
import { colors, font, radius } from '@/lib/theme';

export default function SignatureScreen() {
  const [image, setImage] = useState<string | null | undefined>(undefined);
  const [drawing, setDrawing] = useState(false);

  const load = useCallback(() => {
    api<{ has_signature: boolean; image: string | null }>('/approvals/signature/')
      .then((s) => setImage(s.image))
      .catch(() => setImage(null));
  }, []);

  useEffect(load, [load]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="توقيعي" back />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} scrollEnabled={!drawing}>
        <T style={{ color: colors.textSoft, fontSize: font.small, lineHeight: 22 }}>
          يُختم توقيعك على ملف الطلب عند اعتماده (مع اسمك والوقت ورمز تحقق). ارسمه مرة واحدة ويُحفظ لحسابك.
        </T>
        {image === undefined ? (
          <Loading />
        ) : image && !drawing ? (
          <>
            <View style={styles.preview}>
              <Image source={{ uri: `data:image/png;base64,${image}` }} style={{ width: '100%', height: 150 }} resizeMode="contain" />
            </View>
            <Button title="إعادة رسم التوقيع" icon="create-outline" variant="secondary" onPress={() => setDrawing(true)} />
            <Button
              title="حذف التوقيع"
              variant="plain"
              onPress={() =>
                Alert.alert('حذف التوقيع؟', 'ستحتاج رسمه من جديد قبل اعتماد أي طلب.', [
                  { text: 'تراجع', style: 'cancel' },
                  {
                    text: 'حذف',
                    style: 'destructive',
                    onPress: () =>
                      api('/approvals/signature/', { method: 'DELETE' })
                        .then(() => setImage(null))
                        .catch((err) => Alert.alert('تعذر الحذف', errorText(err))),
                  },
                ])
              }
            />
          </>
        ) : (
          <SignaturePad
            onSaved={() => {
              setDrawing(false);
              load();
            }}
          />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  preview: { backgroundColor: '#fff', borderRadius: radius.md, padding: 16, borderWidth: 1, borderColor: colors.border },
});
