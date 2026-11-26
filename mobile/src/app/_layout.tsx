import * as Notifications from 'expo-notifications';
import { router, Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider, useAuth } from '@/lib/auth';
import { routeForUrl } from '@/lib/push';
import { colors } from '@/lib/theme';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

function openFromNotification(response: Notifications.NotificationResponse | null | undefined) {
  const url = (response?.notification.request.content.data as { url?: string } | undefined)?.url;
  const route = routeForUrl(url);
  if (route) router.push(route as never);
}

function RootStack() {
  const { status, user } = useAuth();
  const signedIn = status === 'signedIn';
  const mustChange = signedIn && !!user?.must_change_password;

  useEffect(() => {
    if (status !== 'loading') void SplashScreen.hideAsync().catch(() => undefined);
  }, [status]);

  // الضغط على إشعار: يفتح المراسلة (والتطبيق مفتوح أو مُغلق).
  useEffect(() => {
    if (!signedIn || mustChange) return;
    openFromNotification(Notifications.getLastNotificationResponse());
    const sub = Notifications.addNotificationResponseReceivedListener(openFromNotification);
    return () => sub.remove();
  }, [signedIn, mustChange]);

  if (status === 'loading') return null;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="login" />
      </Stack.Protected>
      <Stack.Protected guard={mustChange}>
        <Stack.Screen name="change-password" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && !mustChange}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="mail/[id]" />
        <Stack.Screen name="approvals/[id]" />
        <Stack.Screen name="approvals/new" />
        <Stack.Screen name="chat/[id]" />
        <Stack.Screen name="chat/new" />
        <Stack.Screen name="announcements/index" />
        <Stack.Screen name="announcements/[id]" />
        <Stack.Screen name="announcements/new" />
        <Stack.Screen name="announcements/report/[id]" />
        <Stack.Screen name="external/[id]" />
        <Stack.Screen name="external/compose" options={{ presentation: 'modal' }} />
        <Stack.Screen name="search" />
        <Stack.Screen name="compose" options={{ presentation: 'modal' }} />
        <Stack.Screen name="login-approvals" />
        <Stack.Screen name="password" />
        <Stack.Screen name="signature" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="dark" />
        <RootStack />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
