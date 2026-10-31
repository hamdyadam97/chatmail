import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { authApi, isApprovalChallenge, isMfaChallenge, setAccessToken, type User } from '../../shared/api';
import { disablePush } from '../notifications/push';

export type AuthStatus = 'booting' | 'authenticated' | 'guest';

export type LoginResult =
  | { ok: true }
  | { ok: false; mfaToken: string }
  /** متصفح جديد: الكود عند مسؤول النظام. */
  | { ok: false; approvalToken: string };

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  /** On MFA challenge returns the mfa_token needed for verifyMfa. */
  login: (username: string, password: string) => Promise<LoginResult>;
  verifyMfa: (mfaToken: string, otp: string) => Promise<LoginResult>;
  submitLoginCode: (approvalToken: string, code: string) => Promise<void>;
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
    if (isApprovalChallenge(result)) return { ok: false, approvalToken: result.approval_token };
    setAccessToken(result.access);
    setUser(result.user);
    setStatus('authenticated');
    return { ok: true };
  }, []);

  const verifyMfa = useCallback(async (mfaToken: string, otp: string): Promise<LoginResult> => {
    const result = await authApi.verifyMfa(mfaToken, otp);
    if (isApprovalChallenge(result)) return { ok: false, approvalToken: result.approval_token };
    setAccessToken(result.access);
    setUser(result.user);
    setStatus('authenticated');
    return { ok: true };
  }, []);

  const submitLoginCode = useCallback(async (approvalToken: string, code: string) => {
    const result = await authApi.loginCode(approvalToken, code);
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
    () => ({ status, user, login, verifyMfa, submitLoginCode, logout, changeOwnPassword }),
    [status, user, login, verifyMfa, submitLoginCode, logout, changeOwnPassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
