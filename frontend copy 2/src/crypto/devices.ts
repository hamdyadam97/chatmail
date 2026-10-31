/**
 * إدارة الأجهزة — العقد: /api/v1/crypto/devices/.
 * (list/approve/revoke؛ الواجهة في pages/devices.)
 */
import { cryptoApi } from './api';
import { u8ToB64, utf8ToU8 } from './encoding';
import { loadCurrentDevice, refreshDeviceStatus, signWithCurrentDevice } from './identity';

const APPROVE_CONTEXT = 'device-approve-v1\n';

/**
 * الاعتماد يثبت أن جهازنا الموثّق هو من وافق: نوقّعه بمفتاحه. جلسة الدخول
 * وحدها مربوطة بصف جهاز بلا مفاتيح فلا تكفي الخادم ليعرف الجهاز الموثّق.
 */
async function approveSigned(userId: number | string, deviceId: number | string) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const local = await loadCurrentDevice(userId);
  if (!local) throw new Error('لا توجد مفاتيح جهاز على هذا المتصفح');
  const approverId = local.deviceId;
  const message = APPROVE_CONTEXT + [userId, approverId, deviceId, String(issuedAt)].join('\n');
  const { signature } = await signWithCurrentDevice(userId, utf8ToU8(message));
  return cryptoApi.approveDevice(deviceId, {
    approver_device_id: String(approverId),
    issued_at: issuedAt,
    signature: u8ToB64(signature),
  });
}

export interface ApiDevice {
  id: number | string;
  label: string;
  platform: string;
  status: 'pending' | 'active' | 'revoked' | 'retired' | (string & {});
  created_at: string;
  last_seen_at: string | null;
}

export const devicesApi = {
  list: () => cryptoApi.listDevices(),
  approve: (userId: number | string, deviceId: number | string) => approveSigned(userId, deviceId),
  revoke: (deviceId: number | string) => cryptoApi.revokeDevice(deviceId),
};

/** نص حالة الجهاز بالعربية لعرض الواجهة. */
export function deviceStatusLabel(status: string): string {
  switch (status) {
    case 'pending':
      return 'بانتظار الاعتماد';
    case 'active':
      return 'نشط';
    case 'revoked':
      return 'مبطل';
    case 'retired':
      return 'مُسقَط';
    default:
      return status;
  }
}

/**
 * يعيد حالة جهازنا الحالي من السيرفر ويحدّث المخزن المحلي (يبقى رابطًا بـ
 * device_id الحقيقي بعد اعتماد أول جهاز).
 */
export { refreshDeviceStatus };
