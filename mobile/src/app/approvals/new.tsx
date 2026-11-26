/** «طلب جديد» من الموبايل: النوع، العنوان، وملف الطلب (تصوير الورقة، صورة، أو PDF). */
import Ionicons from '@expo/vector-icons/Ionicons';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '@/components/Text';

import { Button, ErrorBox, Field, Header, Loading, T, success, tap, type IconName } from '@/components/ui';
import { errorText } from '@/lib/api';
import { approvalsApi, fileRequest, type RequestType } from '@/lib/approvals';
import { colors, font, radius, row, textRight } from '@/lib/theme';
import type { DirectoryUser } from '@/lib/types';
import { PeoplePicker } from '@/components/PeoplePicker';

interface Picked {
  uri: string;
  name: string;
  mime: string;
  image: boolean;
}

export default function NewRequestScreen() {
  const [types, setTypes] = useState<RequestType[] | null>(null);
  const [typeId, setTypeId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<Picked | null>(null);
  const [deliverTo, setDeliverTo] = useState<DirectoryUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    approvalsApi
      .types()
      .then((t) => {
        setTypes(t);
        if (t.length === 1) setTypeId(t[0].id);
      })
      .catch((err) => {
        setTypes([]);
        setError(errorText(err));
      });
  }, []);

  const fromImage = (asset: ImagePicker.ImagePickerAsset) =>
    setFile({ uri: asset.uri, name: asset.fileName || 'طلب.jpg', mime: asset.mimeType || 'image/jpeg', image: true });

  const camera = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return setError('اسمح للتطبيق باستخدام الكاميرا من إعدادات الهاتف.');
    const r = await ImagePicker.launchCameraAsync({ mediaTypes: 'images', quality: 0.7 });
    if (!r.canceled && r.assets[0]) fromImage(r.assets[0]);
  };
  const gallery = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'images', quality: 0.7 });
    if (!r.canceled && r.assets[0]) fromImage(r.assets[0]);
  };
  const pdf = async () => {
    const r = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true });
    if (!r.canceled && r.assets[0]) {
      const a = r.assets[0];
      setFile({ uri: a.uri, name: a.name || 'طلب.pdf', mime: a.mimeType || 'application/pdf', image: false });
    }
  };

  const submit = async () => {
    if (!typeId || !file) return;
    setBusy(true);
    setError(null);
    try {
      const req = await fileRequest({ workflowId: typeId, title: title.trim(), note: note.trim(), file, deliverTo: deliverTo.map((u) => String(u.id)) });
      success();
      router.replace(`/approvals/${req.id}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (types === null) {
    return (
      <View style={{ flex: 1 }}>
        <Header title="طلب جديد" back />
        <Loading />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Header title="طلب جديد" back />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <T style={styles.label}>نوع الطلب</T>
        {types.length === 0 ? (
          <ErrorBox message="لا توجد أنواع طلبات متاحة لك — راجع مدير النظام." />
        ) : (
          <View style={{ flexDirection: row, flexWrap: 'wrap', gap: 8 }}>
            {types.map((t) => (
              <Pressable
                key={t.id}
                onPress={() => {
                  tap();
                  setTypeId(t.id);
                }}
                style={[styles.type, typeId === t.id && styles.typeActive]}
              >
                <Text style={[styles.typeText, typeId === t.id && { color: '#fff' }]}>{t.name}</Text>
              </Pressable>
            ))}
          </View>
        )}

        <T style={styles.label}>عنوان الطلب</T>
        <Field placeholder="مثال: إجازة اضطرارية يومين" value={title} onChangeText={setTitle} maxLength={200} />

        <T style={styles.label}>ملف الطلب</T>
        {file ? (
          <View style={[styles.picked, { flexDirection: row }]}>
            {file.image ? (
              <Image source={{ uri: file.uri }} style={styles.thumb} />
            ) : (
              <View style={[styles.thumb, { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.navySoft }]}>
                <Ionicons name="document-text" size={30} color={colors.navy} />
              </View>
            )}
            <T style={{ flex: 1, fontSize: font.small }} numberOfLines={2}>
              {file.name}
            </T>
            <Pressable hitSlop={10} onPress={() => setFile(null)}>
              <Ionicons name="close-circle" size={24} color={colors.textMuted} />
            </Pressable>
          </View>
        ) : (
          <View style={{ flexDirection: row, gap: 10 }}>
            <Source icon="camera-outline" label="تصوير الورقة" onPress={camera} />
            <Source icon="images-outline" label="من الصور" onPress={gallery} />
            <Source icon="document-outline" label="ملف PDF" onPress={pdf} />
          </View>
        )}

        <T style={styles.label}>يُرسل بعد الاعتماد إلى (اختياري)</T>
        <T style={{ fontSize: font.tiny + 1, color: colors.textMuted, lineHeight: 19 }}>
          لخطاب موجّه لأشخاص: بعد اعتماده يصلهم الملف الموقّع باسم آخر معتمد، وأنت نسخة. لا يُرسل إن رُفض.
        </T>
        <PeoplePicker value={deliverTo} onChange={setDeliverTo} />

        <T style={styles.label}>ملاحظة (اختياري)</T>
        <TextInput value={note} onChangeText={setNote} multiline maxLength={1000} style={[styles.note, textRight]} textAlignVertical="top" />

        <ErrorBox message={error} />
        <Button title="تقديم الطلب" icon="paper-plane-outline" loading={busy} disabled={!typeId || !file || !title.trim()} onPress={submit} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Source({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.source, pressed && { backgroundColor: colors.navySoft }]}
    >
      <Ionicons name={icon} size={28} color={colors.navy} />
      <Text style={styles.sourceText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: font.small, color: colors.textSoft, fontWeight: '700', marginBottom: -4 },
  type: { paddingHorizontal: 16, height: 40, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: '#fff', justifyContent: 'center' },
  typeActive: { backgroundColor: colors.navy, borderColor: colors.navy },
  typeText: { fontSize: font.small, fontWeight: '700', color: colors.text },
  source: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
    paddingVertical: 18,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.navy,
    backgroundColor: '#fff',
  },
  sourceText: { fontSize: font.tiny + 1, fontWeight: '700', color: colors.navy },
  picked: { alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.md, padding: 10 },
  thumb: { width: 56, height: 72, borderRadius: 8 },
  note: { minHeight: 90, backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: 12, fontSize: font.body, color: colors.text },
});
