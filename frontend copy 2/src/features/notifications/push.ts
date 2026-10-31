/**
 * إشعارات سطح المكتب (Web Push) — تصل والموقع مغلق.
 * الحمولة عامة الصياغة (عنوان ثابت + اسم المرسِل + رابط داخلي) ولا تحمل محتوى (SEC-11).
 */
import { apiFetch } from '../../shared/api';

export type PushState = 'unsupported' | 'disabled-server' | 'denied' | 'off' | 'on';

const SW_URL = '/sw.js';

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

function keyBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  return reg ? reg.pushManager.getSubscription() : null;
}

export async function pushStatus(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  const info = await apiFetch<{ enabled: boolean; public_key: string | null }>('/notifications/push/public-key/');
  if (!info.enabled) return 'disabled-server';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  const sub = await currentSubscription();
  if (!sub) return 'off';
  // نعيد التسجيل (عملية idempotent): الخادم قد يكون فقده (حساب آخر على المتصفح، قاعدة جديدة، فشل سابق).
  await apiFetch('/notifications/push/subscribe/', { method: 'POST', body: sub.toJSON() });
  return 'on';
}

/** يطلب الإذن ويسجّل هذا المتصفح لحساب المستخدم الحالي. */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  const info = await apiFetch<{ enabled: boolean; public_key: string | null }>('/notifications/push/public-key/');
  if (!info.enabled || !info.public_key) return 'disabled-server';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';

  const reg = await navigator.serviceWorker.register(SW_URL);
  await navigator.serviceWorker.ready;
  const key = keyBytes(info.public_key);
  let sub = await reg.pushManager.getSubscription();
  // اشتراك قديم بمفتاح خادم مختلف (مثلًا بعد تغيير مفاتيح VAPID) لا يصلح.
  const oldKey = sub?.options.applicationServerKey;
  if (sub && oldKey && !sameBytes(new Uint8Array(oldKey), key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await apiFetch('/notifications/push/subscribe/', { method: 'POST', body: sub.toJSON() });
  return 'on';
}

/** يلغي إشعارات هذا المتصفح (يُستدعى أيضًا عند تسجيل الخروج). */
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const sub = await currentSubscription();
  if (!sub) return;
  try {
    await apiFetch('/notifications/push/unsubscribe/', { method: 'POST', body: { endpoint: sub.endpoint } });
  } finally {
    await sub.unsubscribe();
  }
}

export const sendTestPush = () => apiFetch<{ subscriptions: number }>('/notifications/push/test/', { method: 'POST' });

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
