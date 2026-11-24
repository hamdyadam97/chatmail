/**
 * فتح المرفقات: تنزيل من الخادم (يفك تشفيرها هناك للمشاركين فقط) إلى مجلد
 * مؤقت خاص بالتطبيق، ثم عرضها بعارض النظام (Quick Look / تطبيق مناسب)،
 * وإلا قائمة المشاركة. المجلد يُمسح عند الخروج.
 */
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { API_BASE, ApiError, authHeaders, refreshSession } from './api';

export interface FileRef {
  id: string;
  name: string;
  mime?: string;
}

function folder(): Directory {
  const dir = new Directory(Paths.cache, 'attachments');
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function safeName(name: string): string {
  return (name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120);
}

async function download(ref: FileRef): Promise<File> {
  const target = new File(folder(), `${ref.id}-${safeName(ref.name)}`);
  if (target.exists && target.size > 0) return target;
  const url = `${API_BASE}/attachments/${ref.id}/`;
  const attempt = async () => {
    const file = await File.downloadFileAsync(url, target, { headers: await authHeaders(), idempotent: true });
    // ردّ خطأ الخادم (JSON صغير) لا يُعرض كملف.
    if (file.size < 512) {
      const text = await file.text().catch(() => '');
      if (text.startsWith('{"detail"')) {
        file.delete();
        throw new ApiError(401, null);
      }
    }
    return file;
  };
  try {
    return await attempt();
  } catch {
    // رمز الوصول انتهى؟ نجدده مرة ونعيد.
    if (await refreshSession().catch(() => false)) {
      try {
        return await attempt();
      } catch {
        // يقع أدناه.
      }
    }
    throw new ApiError(0, null, 'تعذر فتح الملف — تأكد من الإنترنت وحاول مرة أخرى');
  }
}

export async function openAttachment(ref: FileRef): Promise<void> {
  const file = await download(ref);
  try {
    await file.preview({ title: ref.name, mimeType: ref.mime });
  } catch {
    await Sharing.shareAsync(file.uri, { mimeType: ref.mime, dialogTitle: ref.name });
  }
}

/** عند الخروج: لا تبقى ملفات الحساب على الهاتف. */
export function clearDownloads(): void {
  try {
    const dir = new Directory(Paths.cache, 'attachments');
    if (dir.exists) dir.delete();
  } catch {
    // لا شيء ليُمسح.
  }
}
