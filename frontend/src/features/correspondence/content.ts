/** المرفقات: التنزيل من الخادم (يفك تشفيرها هناك للمشاركين فقط) وصيغة الحجم. */
import { saveBlob } from '../../shared/lib/download';
import { correspondenceApi, type AttachmentMeta } from './api';

/**
 * يحفظ الملف كتنزيل. النوع دائمًا octet-stream كي لا يعرضه المتصفح داخل أصل
 * التطبيق (HTML/SVG قد يحمل سكربتًا — حماية XSS، §21).
 */
export async function downloadAttachment(meta: AttachmentMeta): Promise<void> {
  const blob = await correspondenceApi.download(meta.id);
  saveBlob(new Blob([blob], { type: 'application/octet-stream' }), meta.name || 'attachment');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} بايت`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} ك.ب`;
  return `${(n / 1024 / 1024).toFixed(1)} م.ب`;
}
