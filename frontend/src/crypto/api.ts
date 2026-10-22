/**
 * عقد crypto/ في الـbackend — `/api/v1/crypto/*` (كلها تتطلب مصادقة).
 * الأشكال هنا verbatim من العقد المشترك؛ أي تغيير يُنسَّق مع وكيل الـbackend.
 */
import { apiFetch } from '../shared/api';
import type { ApiDevice } from './devices';

const BASE = '/crypto';

export interface DeviceKeyPayload {
  /** base64 — مفتاح توقيع الجهاز Ed25519 العام (32B raw). */
  sign_pub: string;
  /** base64 — مفتاح KEM الجهاز X25519 العام (32B raw). */
  kem_pub: string;
}

export interface IdentityBootstrapPayload {
  /** base64 — مفتاح الهوية Ed25519 العام (32B raw). */
  identity_pub: string;
  /** base64 — توقيع الهوية فوق identity_pub||sign_pub||kem_pub||user.id.bytes. */
  bootstrap_sig: string;
  device: {
    label: string;
    platform: string;
    sign_pub: string;
    kem_pub: string;
    /** base64 — توقيع الهوية فوق sign_pub||kem_pub||user.id.bytes. */
    sig: string;
  };
}

export interface KeyPackageUpload {
  keypackage: string;
  keypackage_hash: string;
  /** اختياري — رفع KP لجهاز محدد من أجهزتي (افتراضيًا جهاز الجلسة). */
  device_id?: number | string;
  expires_at?: string;
}

export interface IdentityBootstrapResponse {
  user_id: string;
  identity_pub: string;
  algorithm: string;
  device_id: string;
  device_status: string;
}

export interface DirectoryDevice {
  id: number | string;
  sign_pub: string;
  kem_pub: string;
  status: string;
}

export interface DirectoryUser {
  user_id: number | string;
  identity_pub: string;
  devices: DirectoryDevice[];
}

export interface ClaimedKeyPackage {
  device_id: number | string;
  keypackage: string;
  keypackage_hash: string;
}

/**
 * حدث سلسلة الشفافية — الصيغة الفعلية للـbackend:
 * ‏entry_hash = sha256(prev_hash_bytes ‖ canonical_json(payload))، والتوقيع
 * ‏ed25519 فوق entry_hash (raw bytes). genesis = sha256("correspondence-key-
 * transparency-genesis-v1") — ثابت معلن في crypto_keys/transparency.py.
 */
export interface TransparencyEntry {
  seq: number;
  event_type: string;
  prev_hash: string;
  entry_hash: string;
  payload: Record<string, unknown>;
  log_signature: string;
  created_at: string;
}

export const cryptoApi = {
  /** 409 إن وُجدت هوية للمستخدم مسبقًا. يردّ 201 بـ device_id مباشرة. */
  bootstrapIdentity: (payload: IdentityBootstrapPayload) =>
    apiFetch<IdentityBootstrapResponse>(`${BASE}/identity/`, { method: 'POST', body: payload }),

  listDevices: () => apiFetch<ApiDevice[]>(`${BASE}/devices/`),

  registerDevice: (payload: {
    label: string;
    platform: string;
    sign_pub: string;
    kem_pub: string;
    sig: string;
  }) => apiFetch<ApiDevice>(`${BASE}/devices/register/`, { method: 'POST', body: payload }),

  approveDevice: (deviceId: number | string) =>
    apiFetch<null>(`${BASE}/devices/${deviceId}/approve/`, { method: 'POST' }),

  revokeDevice: (deviceId: number | string) =>
    apiFetch<null>(`${BASE}/devices/${deviceId}/revoke/`, { method: 'POST' }),

  uploadKeyPackage: (payload: KeyPackageUpload) =>
    apiFetch<null>(`${BASE}/keys/upload/`, { method: 'POST', body: payload }),

  queryKeys: (userIds: Array<number | string>) =>
    apiFetch<{ users: DirectoryUser[] }>(`${BASE}/keys/query/`, {
      method: 'POST',
      body: { user_ids: userIds },
    }),

  /** يستهلك KeyPackage واحدًا لكل جهاز (لا يعيد نفسها مرتين). */
  claimKeyPackages: (deviceIds: Array<number | string>) =>
    apiFetch<ClaimedKeyPackage[]>(`${BASE}/keys/claim/`, {
      method: 'POST',
      body: { device_ids: deviceIds },
    }),

  transparencySelf: () => apiFetch<TransparencyEntry[]>(`${BASE}/transparency/self/`),

  transparencyLogKey: () => apiFetch<{ log_pub: string }>(`${BASE}/transparency/log-key/`),
};
