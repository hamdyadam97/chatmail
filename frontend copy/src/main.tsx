import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { AppProviders } from './app/providers';
import { AuthProvider } from './features/auth/AuthContext';
import { router } from './app/router';
// خط عربي مضمَّن مع التطبيق (CSP تمنع الخطوط الخارجية): عربي + لاتيني، تُنزَّل حسب الحاجة.
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import '@fontsource/ibm-plex-sans-arabic/700.css';
import './index.css';

// Service worker من البداية: يجعل التطبيق قابلًا للتثبيت (PWA) ويستقبل إشعارات سطح المكتب.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProviders>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </AppProviders>
  </React.StrictMode>,
);
