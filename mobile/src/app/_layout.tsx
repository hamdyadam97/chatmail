// الأوزان الأربعة فقط (الفهرس يسحب السبعة ويكبّر التحديث).
import { IBMPlexSansArabic_400Regular } from '@expo-google-fonts/ibm-plex-sans-arabic/400Regular';
import { IBMPlexSansArabic_500Medium } from '@expo-google-fonts/ibm-plex-sans-arabic/500Medium';
import { IBMPlexSansArabic_600SemiBold } from '@expo-google-fonts/ibm-plex-sans-arabic/600SemiBold';
import { IBMPlexSansArabic_700Bold } from '@expo-google-fonts/ibm-plex-sans-arabic/700Bold';
import { useFonts } from 'expo-font';
import * as Notifications from 'expo-notifications';
import { router, Stack, useRootNavigationState } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { setFontsLoaded } from '@/components/Text';
import { AuthProvider, useAuth } from '@/lib/auth';
import { routeForUrl } from '@/lib/push';
import { colors, isDark } from '@/lib/theme';
import { watchForUpdates } from '@/lib/updates';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

/** إشعارات فُتحت فعلًا — حتى لا يعود آخر إشعار يفتح نفسه عند كل تجديد للجلسة. */
const handledNotifications = new Set<string>();

function RootStack() {
  const { status, user } = useAuth();
  const signedIn = status === 'signedIn';
  const mustChange = signedIn && !!user?.must_change_password;
  const navReady = !!useRootNavigationState()?.key;
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (status !== 'loading') void SplashScreen.hideAsync().catch(() => undefined);
  }, [status]);

  // الضغط على إشعار (والتطبيق مفتوح أو في الخلفية أو مُغلق): نحفظ وجهته…
  useEffect(() => {
    if (!signedIn || mustChange) return;
    const take = (response: Notifications.NotificationResponse | null | undefined) => {
      if (!response) return;
      const id = response.notification.request.identifier;
      if (handledNotifications.has(id)) return;
      handledNotifications.add(id);
      const url = (response.notification.request.content.data as { url?: string } | undefined)?.url;
      const route = routeForUrl(url);
      if (route) setPending(route);
    };
    take(Notifications.getLastNotificationResponse());
    const sub = Notifications.addNotificationResponseReceivedListener(take);
    return () => sub.remove();
  }, [signedIn, mustChange]);

  // …ونفتحها حين تجهز الشاشات: التنقل قبل تركيب المتصفح يفشل (فتح التطبيق من إشعار وهو مُغلق).
  useEffect(() => {
    if (!pending || !navReady || !signedIn || mustChange) return;
    const t = setTimeout(() => {
      setPending(null);
      try {
        router.push(pending as never);
      } catch {
        // لا شيء — يبقى المستخدم في الرئيسية.
      }
    }, 150);
    return () => clearTimeout(t);
  }, [pending, navReady, signedIn, mustChange]);

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
  useEffect(() => watchForUpdates(), []);
  const [fontsLoaded, fontError] = useFonts({
    IBMPlexSansArabic_400Regular,
    IBMPlexSansArabic_500Medium,
    IBMPlexSansArabic_600SemiBold,
    IBMPlexSansArabic_700Bold,
  });
  // شاشة البداية تبقى حتى يُحمَّل الخط؛ إن فشل نكمل بخط النظام.
  if (!fontsLoaded && !fontError) return null;
  setFontsLoaded(fontsLoaded);
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style={isDark ? "light" : "dark"} />
        <RootStack />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
