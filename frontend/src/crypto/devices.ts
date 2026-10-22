/**
 * إدارة الأجهزة — العقد: /api/v1/crypto/devices/.
 * (list/approve/revoke؛ الواجهة في pages/devices.)
 */
import { cryptoApi } from './api';
import { refreshDeviceStatus } from './identity';

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
  approve: (deviceId: number | string) => cryptoApi.approveDevice(deviceId),
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
