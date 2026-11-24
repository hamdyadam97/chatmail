/**
 * حالة الدخول: نفس خطوات الموقع — كلمة المرور ← (MFA) ← (كود الجهاز الجديد
 * أول مرة: لي أو للمسؤول) ← الجلسة. الهاتف يصبح «معروفًا» بعد الكود فلا يُطلب ثانية.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { api, onSessionEnded, refreshSession, setAccessToken, tokens } from './api';
import { clearDownloads } from './files';
import { registerForPush, unregisterPush } from './push';
import type { LoginResponse, User } from './types';

type Status = 'loading' | 'signedOut' | 'signedIn';

export type Challenge =
  | { kind: 'mfa'; token: string }
  | { kind: 'approval'; token: string; canSendToSelf: boolean };

interface AuthValue {
  status: Status;
  user: User | null;
  /** يعيد تحديًا إن احتاج الدخول خطوة إضافية، أو null إن اكتمل. */
  login: (username: string, password: string) => Promise<Challenge | null>;
  verifyMfa: (token: string, otp: string) => Promise<Challenge | null>;
  sendCode: (approvalToken: string, to: 'self' | 'admin') => Promise<void>;
  submitCode: (approvalToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  reloadUser: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<User | null>(null);

  const signOutLocal = useCallback(async () => {
    setAccessToken(null);
    clearDownloads();
    await tokens.clearSession();
    setUser(null);
    setStatus('signedOut');
  }, []);

  const loadMe = useCallback(async () => {
    const me = await api<User>('/users/me/');
    setUser(me);
    setStatus('signedIn');
    void registerForPush();
  }, []);

  useEffect(() => {
    onSessionEnded(() => void signOutLocal());
    (async () => {
      try {
        if (await refreshSession()) {
          await loadMe();
          return;
        }
      } catch {
        // بلا إنترنت عند الفتح: نعرض شاشة الدخول؛ الرمز المحفوظ يبقى.
      }
      setStatus('signedOut');
    })();
  }, [loadMe, signOutLocal]);

  const finish = useCallback(
    async (res: LoginResponse): Promise<Challenge | null> => {
      if ('approval_required' in res && res.approval_required) {
        return { kind: 'approval', token: res.approval_token, canSendToSelf: !!res.send_options?.sessions };
      }
      if (res.mfa_required) return { kind: 'mfa', token: res.mfa_token };
      if (!('access' in res)) throw new Error('unexpected login response');
      setAccessToken(res.access);
      await tokens.save(res.refresh, res.device_token);
      await loadMe();
      return null;
    },
    [loadMe],
  );

  const value = useMemo<AuthValue>(
    () => ({
      status,
      user,
      login: async (username, password) =>
        finish(await api<LoginResponse>('/auth/login/', { method: 'POST', auth: false, body: { username, password } })),
      verifyMfa: async (token, otp) =>
        finish(await api<LoginResponse>('/auth/mfa/verify/', { method: 'POST', auth: false, body: { mfa_token: token, otp } })),
      sendCode: async (approvalToken, to) => {
        await api('/auth/login/code/send/', { method: 'POST', auth: false, body: { approval_token: approvalToken, to } });
      },
      submitCode: async (approvalToken, code) => {
        await finish(
          await api<LoginResponse>('/auth/login/code/', { method: 'POST', auth: false, body: { approval_token: approvalToken, code } }),
        );
      },
      logout: async () => {
        await unregisterPush();
        try {
          const refresh = await tokens.refresh();
          await api('/auth/logout/', { method: 'POST', auth: false, body: { refresh } });
        } catch {
          // الخروج المحلي يكفي إن تعذر الوصول للخادم.
        }
        await signOutLocal();
      },
      reloadUser: loadMe,
    }),
    [status, user, finish, loadMe, signOutLocal],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
