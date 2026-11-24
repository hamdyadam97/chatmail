/**
 * إشعارات التطبيق: رمز Expo يُسجَّل على الخادم (notifications/push/app/register/)
 * فتصل الإشعارات عبر Google/Apple. لا تعمل داخل Expo Go (تحتاج نسخة مبنية)،
 * فنتجاوزها هناك بصمت.
 */
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { api } from './api';

let currentToken: string | null = null;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export function pushSupported(): boolean {
  return Device.isDevice && Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;
}

/** يطلب الإذن ويسجل الهاتف للحساب الحالي. يعيد false إن لم يتيسر. */
export async function registerForPush(): Promise<boolean> {
  if (!pushSupported()) return false;
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'الإشعارات',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 200, 120, 200],
        lightColor: '#CB962B',
      });
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return false;
    const projectId =
      (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ??
      Constants.easConfig?.projectId;
    if (!projectId) return false;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    await api('/notifications/push/app/register/', { method: 'POST', body: { token, platform: Platform.OS } });
    currentToken = token;
    return true;
  } catch {
    return false;
  }
}

/** قبل الخروج: لا إشعارات لهذا الهاتف بعد الآن. */
export async function unregisterPush(): Promise<void> {
  if (!currentToken) return;
  try {
    await api('/notifications/push/app/unregister/', { method: 'POST', body: { token: currentToken } });
  } catch {
    // الخادم يحذف الرمز وحده حين يرفضه Expo لاحقًا.
  }
  currentToken = null;
}

/** المسار داخل التطبيق لعنوان إشعار الخادم (`/correspondence/<id>` …). */
export function routeForUrl(url: string | undefined): string | null {
  if (!url) return null;
  const mail = url.match(/^\/correspondence\/([0-9a-f-]{36})/);
  if (mail) return `/mail/${mail[1]}`;
  const approval = url.match(/^\/approvals\/([0-9a-f-]{36})/);
  if (approval) return `/approvals/${approval[1]}`;
  const announcement = url.match(/^\/announcements\/([0-9a-f-]{36})/);
  if (announcement) return `/announcements/${announcement[1]}`;
  const chat = url.match(/^\/chat\/([0-9a-f-]{36})/);
  if (chat) return `/chat/${chat[1]}`;
  if (url.startsWith('/login-approvals')) return '/login-approvals';
  return '/notifications';
}
