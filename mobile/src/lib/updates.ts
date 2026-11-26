/**
 * التحديثات:
 * 1) تحديثات الشاشات والمنطق (أغلبها) تصل وحدها عبر expo-updates: يفحص
 *    التطبيق عند فتحه، وعند رجوعه من الخلفية، وينزّلها في الخلفية؛ تعمل
 *    من الفتح التالي — أو فورًا إن غاب التطبيق في الخلفية 10 دقائق فأكثر.
 * 2) إصدار كامل جديد (مكتبة أصلية/صلاحية جديدة): الخادم يعلن رقمه ورابطه
 *    (`/auth/app-version/`) فتظهر رسالة «تحديث» مرة واحدة في كل تشغيل.
 */
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { Alert, AppState, Linking, Platform } from 'react-native';

import { api } from './api';

const RELOAD_AFTER_MS = 10 * 60 * 1000;

function installedVersion(): string {
  return Updates.runtimeVersion || Constants.expoConfig?.version || '0';
}

/** 5.1.0 > 5.0.9 */
export function newer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

let fetched = false;

async function fetchScreensUpdate(): Promise<void> {
  if (!Updates.isEnabled || fetched) return;
  try {
    const check = await Updates.checkForUpdateAsync();
    if (!check.isAvailable) return;
    const r = await Updates.fetchUpdateAsync();
    fetched = r.isNew;
  } catch {
    // بلا إنترنت أو الخادم لا يرد: نحاول لاحقًا.
  }
}

let prompted = false;

async function checkFullRelease(): Promise<void> {
  if (prompted || Platform.OS !== 'android') return;
  try {
    const r = await api<{ android: { version: string; url: string } | null }>('/auth/app-version/', { auth: false });
    if (!r.android || !newer(r.android.version, installedVersion())) return;
    prompted = true;
    const url = r.android.url;
    Alert.alert('إصدار جديد من التطبيق', `الإصدار ${r.android.version} متاح. نزّله وثبّته فوق الحالي — بياناتك وحسابك يبقيان كما هما.`, [
      { text: 'لاحقًا', style: 'cancel' },
      { text: 'تحديث', onPress: () => void Linking.openURL(url) },
    ]);
  } catch {
    // لا شيء — نحاول في التشغيل القادم.
  }
}

/** يُستدعى مرة عند بدء التطبيق؛ يعيد دالة إلغاء الاشتراك. */
export function watchForUpdates(): () => void {
  void fetchScreensUpdate();
  void checkFullRelease();
  let backgroundSince = 0;
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'background') {
      backgroundSince = Date.now();
      return;
    }
    if (state !== 'active') return;
    const away = backgroundSince ? Date.now() - backgroundSince : 0;
    backgroundSince = 0;
    if (fetched && away >= RELOAD_AFTER_MS) {
      void Updates.reloadAsync().catch(() => undefined);
      return;
    }
    void fetchScreensUpdate();
    void checkFullRelease();
  });
  return () => sub.remove();
}
