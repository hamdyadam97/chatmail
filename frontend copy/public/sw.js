/* Service worker: shows Web Push notifications while the site is closed.
 * The payload is generic (title + sender name + in-app link) — never
 * message content (SEC-11). No caching / offline logic here on purpose. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || 'نظام المراسلات';
  event.waitUntil(
    (async () => {
      // المستخدم ينظر لنفس الصفحة الآن: لا داعي لإشعار (التحديث الحي يكفي).
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const watching = windows.some(
        (c) => c.focused && c.visibilityState === 'visible' && new URL(c.url).pathname === data.url,
      );
      if (watching) return;
      await self.registration.showNotification(title, {
        body: data.body || '',
        tag: data.tag || undefined,
        renotify: Boolean(data.tag),
        dir: 'rtl',
        lang: 'ar',
        icon: '/favicon.svg',
        badge: '/favicon.svg',
        data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/' },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = event.notification.data?.url || '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          // The open app routes in place (no reload → keys stay unlocked).
          client.postMessage({ type: 'open-url', url: path });
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow(new URL(path, self.location.origin).href);
    })(),
  );
});
