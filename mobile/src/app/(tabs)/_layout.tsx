import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { api } from '@/lib/api';
import { colors } from '@/lib/theme';

/** أعداد الشارات (غير المقروء) — تتحدث عند العودة للتطبيق وكل دقيقة. */
function useBadges() {
  const [mail, setMail] = useState(0);
  const [notes, setNotes] = useState(0);
  useEffect(() => {
    const load = () => {
      api<{ inbox_unread: number }>('/correspondences/counts/').then((c) => setMail(c.inbox_unread)).catch(() => undefined);
      api<{ unread: number }>('/notifications/unread-count/').then((c) => setNotes(c.unread)).catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 60_000);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && load());
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, []);
  return { mail, notes };
}

export default function TabsLayout() {
  const badges = useBadges();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.navy,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
        tabBarStyle: { backgroundColor: '#fff', borderTopColor: colors.border },
        tabBarBadgeStyle: { backgroundColor: colors.gold, color: '#fff', fontSize: 11 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'البريد',
          tabBarBadge: badges.mail || undefined,
          tabBarIcon: ({ color, focused }) => <Ionicons name={focused ? 'mail' : 'mail-outline'} size={25} color={color as string} />,
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: 'الإشعارات',
          tabBarBadge: badges.notes || undefined,
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? 'notifications' : 'notifications-outline'} size={25} color={color as string} />
          ),
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: 'حسابي',
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? 'person-circle' : 'person-circle-outline'} size={27} color={color as string} />
          ),
        }}
      />
    </Tabs>
  );
}
