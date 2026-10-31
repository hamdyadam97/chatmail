/**
 * تهيئة التشفير بعد الدخول: bootstrap الهوية/الجهاز + ضمان KeyPackage.
 * single-flight على مستوى الوحدة حتى تتقاسم الصفحات (chat/devices/recovery/
 * security) نفس الوعد.
 */
import { useEffect, useState } from 'react';
import { useAuth } from '../features/auth/AuthContext';
import { initMlsWasm } from './wasm';
import { bootstrapUserCrypto, refreshDeviceStatus } from './identity';
import { ensureKeyPackage } from './mls';
import { startAutoBackup } from './recovery';
import { ApiError } from '../shared/api';

export type CryptoBootstrapState =
  | { status: 'loading' }
  | { status: 'ready'; deviceId: number | string }
  | { status: 'pending_approval'; deviceId: number | string }
  | { status: 'error'; message: string };

let inFlight: Promise<CryptoBootstrapState> | null = null;
let inFlightUser: string | null = null;

/** أخطاء الـWASM تُرمى نصوصًا لا كائنات Error — نعرض نصها الفعلي. */
function describe(err: unknown): string {
  if (err instanceof ApiError && err.status >= 500) return 'تعذر تجهيز التشفير: خطأ في الخادم — أبلغ مسؤول النظام';
  if (err instanceof Error) return err.message;
  if (typeof err === 'string' && err) return `خطأ في طبقة التشفير: ${err}`;
  return 'تعذر تجهيز التشفير على هذا الجهاز';
}

export function runCryptoBootstrap(user: { id: number | string }): Promise<CryptoBootstrapState> {
  if (inFlightUser !== String(user.id)) {
    inFlight = null;
    inFlightUser = String(user.id);
  }
  inFlight ??= (async (): Promise<CryptoBootstrapState> => {
    try {
      await initMlsWasm();
      const result = await bootstrapUserCrypto(user);
      if (result.state === 'pending_approval') {
        const refreshed = await refreshDeviceStatus(user.id);
        if (refreshed && refreshed.status === 'active') {
          result.device.status = 'active';
          startAutoBackup(user.id);
          return { status: 'ready', deviceId: refreshed.deviceId };
        }
        return { status: 'pending_approval', deviceId: result.device.deviceId };
      }
      try {
        await ensureKeyPackage();
      } catch (err) {
        // تكملة مخزون KPs ليست شرطًا لاستخدام الجهاز (الموجود يكفي غالبًا)؛
        // فشلها (حد معدل، انقطاع) لا يعطّل التطبيق وتُعاد في الزيارة التالية.
        console.warn('key package top-up deferred', err);
      }
      // نسخة مشفّرة تلقائية بعد كل تغيير (إن كان مفتاح الاستعادة مُعدًّا).
      startAutoBackup(user.id);
      return { status: 'ready', deviceId: result.device.deviceId };
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        return { status: 'error', message: 'جهازك بانتظار الاعتماد من جهاز موثّق آخر' };
      }
      // للتشخيص فقط: أخطاء التهيئة لا تحمل أي محتوى أو مفاتيح.
      console.error('crypto bootstrap failed', err);
      return { status: 'error', message: describe(err) };
    }
  })().finally(() => {
    // نُبقي الوعد بعد اكتماله لتتشارك الصفحات النتيجة؛ إعادة المحاولة
    // تتطلب إعادة تحميل الصفحة أو استدعاء صريح.
  });
  return inFlight;
}

export function resetCryptoBootstrap(): void {
  inFlight = null;
}

export function useCryptoBootstrap(): CryptoBootstrapState {
  const { user } = useAuth();
  const [state, setState] = useState<CryptoBootstrapState>({ status: 'loading' });

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    runCryptoBootstrap(user).then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  return state;
}
