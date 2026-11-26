/** توقيعي: يُعرض المحفوظ، ويُرسم من جديد بالإصبع أو يُصوَّر من ورقة (الخادم يزيل الورقة والظل). */
import * as ImagePicker from 'expo-image-picker';
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

  const [uploading, setUploading] = useState(false);
  const fromPhoto = async (camera: boolean) => {
    if (camera) {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return Alert.alert('الكاميرا غير مسموحة', 'اسمح للتطبيق باستخدام الكاميرا من إعدادات الجهاز.');
    }
    // القص (allowsEditing) على التوقيع وحده يصغّر الصورة ويُبعد الطاولة والأصابع.
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: 'images', quality: 0.5, base64: true, allowsEditing: true };
    const r = camera ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    const b64 = !r.canceled ? r.assets[0]?.base64 : null;
    if (!b64) return;
    if (b64.length > 3_800_000) return Alert.alert('الصورة كبيرة', 'قصّ الصورة على التوقيع فقط ثم حاول مرة أخرى.');
    setUploading(true);
    try {
      await api('/approvals/signature/', { method: 'PUT', body: { image: b64 } });
      setDrawing(false);
      load();
    } catch (err) {
      Alert.alert('تعذر حفظ التوقيع', errorText(err));
    } finally {
      setUploading(false);
    }
  };
  const photoButtons = (
    <View style={{ gap: 8 }}>
      <Button title="تصوير توقيعي من ورقة" icon="camera-outline" variant="secondary" loading={uploading} onPress={() => void fromPhoto(true)} />
      <Button title="اختيار صورة التوقيع" icon="image-outline" variant="plain" disabled={uploading} onPress={() => void fromPhoto(false)} />
      <T style={{ color: colors.textSoft, fontSize: font.small, lineHeight: 20 }}>
        وقّع بقلم غامق على ورقة بيضاء، وقصّ الصورة على التوقيع — تُزال الورقة والظل تلقائيًا.
      </T>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="توقيعي" back />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} scrollEnabled={!drawing}>
        <T style={{ color: colors.textSoft, fontSize: font.small, lineHeight: 22 }}>
          يُختم توقيعك على ملف الطلب عند اعتماده (مع اسمك والوقت ورمز تحقق). ارسمه أو صوّره مرة واحدة ويُحفظ لحسابك.
        </T>
        {image === undefined ? (
          <Loading />
        ) : image && !drawing ? (
          <>
            <View style={styles.preview}>
              <Image source={{ uri: `data:image/png;base64,${image}` }} style={{ width: '100%', height: 150 }} resizeMode="contain" />
            </View>
            <Button title="إعادة رسم التوقيع" icon="create-outline" variant="secondary" onPress={() => setDrawing(true)} />
            {photoButtons}
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
          <>
            <SignaturePad
              onSaved={() => {
                setDrawing(false);
                load();
              }}
            />
            {photoButtons}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  preview: { backgroundColor: colors.card, borderRadius: radius.md, padding: 16, borderWidth: 1, borderColor: colors.border },
});
