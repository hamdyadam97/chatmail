import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { authApi, isMfaChallenge, setAccessToken, type User } from '../../shared/api';
import { disablePush } from '../notifications/push';

export type AuthStatus = 'booting' | 'authenticated' | 'guest';

export type LoginResult = { ok: true } | { ok: false; mfaToken: string };

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  /** On MFA challenge returns the mfa_token needed for verifyMfa. */
  login: (username: string, password: string) => Promise<LoginResult>;
  verifyMfa: (mfaToken: string, otp: string) => Promise<void>;
  logout: () => Promise<void>;
  changeOwnPassword: (oldPassword: string, newPassword: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('booting');
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Restore the session from the httpOnly refresh cookie; the access
        // token itself is never persisted client-side.
        await authApi.refresh();
        const currentUser = await authApi.me();
        if (cancelled) return;
        setUser(currentUser);
        setStatus('authenticated');
      } catch {
        if (cancelled) return;
        setAccessToken(null);
        setStatus('guest');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string): Promise<LoginResult> => {
    const result = await authApi.login(username, password);
    if (isMfaChallenge(result)) return { ok: false, mfaToken: result.mfa_token };
    setAccessToken(result.access);
    setUser(result.user);
    setStatus('authenticated');
    return { ok: true };
  }, []);

  const verifyMfa = useCallback(async (mfaToken: string, otp: string) => {
    const result = await authApi.verifyMfa(mfaToken, otp);
    setAccessToken(result.access);
    setUser(result.user);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    // هذا المتصفح لا يستقبل إشعارات الحساب بعد الخروج (جهاز مشترك).
    await disablePush().catch(() => undefined);
    try {
      await authApi.logout();
    } catch {
      // Best effort — the refresh cookie is cleared server-side anyway.
    } finally {
      setAccessToken(null);
      setUser(null);
      setStatus('guest');
    }
  }, []);

  const changeOwnPassword = useCallback(async (oldPassword: string, newPassword: string) => {
    await authApi.changePassword(oldPassword, newPassword);
    setUser((prev) => (prev ? { ...prev, must_change_password: false } : prev));
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, login, verifyMfa, logout, changeOwnPassword }),
    [status, user, login, verifyMfa, logout, changeOwnPassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
