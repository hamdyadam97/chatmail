/** رفع ملف (multipart) من مسار محلي على الهاتف، واختيار الملف من الكاميرا أو الصور أو الملفات. */
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Alert } from 'react-native';

import { API_BASE, ApiError, authHeaders, refreshSession } from './api';
import type { AttachmentMeta } from './types';

export interface LocalFile {
  uri: string;
  name: string;
  mime: string;
  size?: number;
}

export async function uploadMultipart<T>(path: string, fields: Record<string, string>, file: LocalFile): Promise<T> {
  const send = async () => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    // React Native: {uri, name, type} يرفع الملف من مساره المحلي.
    form.append('file', { uri: file.uri, name: file.name, type: file.mime } as unknown as Blob);
    return fetch(`${API_BASE}${path}`, { method: 'POST', headers: await authHeaders(), body: form });
  };
  let res: Response;
  try {
    res = await send();
    if (res.status === 401 && (await refreshSession())) res = await send();
  } catch {
    throw new ApiError(0, null, 'تعذر رفع الملف — تأكد من الإنترنت');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

/** مرفق مراسلة: الخادم يختمه ويعيد معرّفه. */
export const uploadAttachment = (file: LocalFile) => uploadMultipart<AttachmentMeta>('/attachments/', {}, file);

/** قائمة «إرفاق»: تصوير، من الصور، أو ملف. */
export function pickFile(onPicked: (f: LocalFile) => void) {
  const fromImage = (r: ImagePicker.ImagePickerResult) => {
    const a = !r.canceled ? r.assets[0] : null;
    if (a) onPicked({ uri: a.uri, name: a.fileName || `صورة-${Date.now()}.jpg`, mime: a.mimeType || 'image/jpeg', size: a.fileSize });
  };
  Alert.alert('إرفاق', undefined, [
    {
      text: 'تصوير',
      onPress: async () => {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) return Alert.alert('الكاميرا', 'اسمح للتطبيق باستخدام الكاميرا من إعدادات الهاتف.');
        fromImage(await ImagePicker.launchCameraAsync({ mediaTypes: 'images', quality: 0.7 }));
      },
    },
    { text: 'من الصور', onPress: async () => fromImage(await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'images', quality: 0.7 })) },
    {
      text: 'ملف',
      onPress: async () => {
        const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
        const a = !r.canceled ? r.assets[0] : null;
        if (a) onPicked({ uri: a.uri, name: a.name, mime: a.mimeType || 'application/octet-stream', size: a.size });
      },
    },
    { text: 'إلغاء', style: 'cancel' },
  ]);
}
