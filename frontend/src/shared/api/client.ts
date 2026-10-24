const DEFAULT_BASE_URL = 'http://localhost:8000/api/v1';

export const API_BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? DEFAULT_BASE_URL;

/**
 * Access token lives in this module only — never in localStorage/sessionStorage
 * (see docs/phase1/06 §6.3). Lost on full page reload; restored via the
 * httpOnly refresh cookie at /auth/refresh/.
 */
let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export class ApiError extends Error {
  readonly status: number;
  readonly data: unknown;

  constructor(status: number, data: unknown, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /**
   * false for auth endpoints (login / mfa / refresh): no Authorization header
   * and no automatic refresh-on-401 (a failed login must not trigger a refresh).
   */
  auth?: boolean;
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

let refreshInFlight: Promise<boolean> | null = null;

async function performRefresh(retry = true): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/auth/refresh/`, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (res.status === 401 && retry) {
      // تبويب آخر (أو تشغيل مزدوج) جدّد الجلسة للتو: الكوكي الأحدث وصل — نعيد مرة.
      const body = (await parseBody(res)) as { code?: string } | null;
      if (body?.code === 'refresh_superseded') {
        await new Promise((r) => setTimeout(r, 300));
        return performRefresh(false);
      }
      return false;
    }
    if (!res.ok) return false;
    const data = (await parseBody(res)) as { access?: string } | null;
    if (!data?.access) return false;
    setAccessToken(data.access);
    return true;
  } catch {
    return false;
  }
}

/** Single-flight refresh: concurrent callers (401s, page boot, StrictMode's
 * double effect) share one /auth/refresh/ call — never two rotations at once. */
export function refreshAccessToken(): Promise<boolean> {
  refreshInFlight ??= performRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

function forceLogout(): void {
  setAccessToken(null);
  const { pathname } = window.location;
  if (!pathname.startsWith('/login')) {
    window.location.assign('/login');
  }
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, auth = true, headers, ...rest } = options;

  const doFetch = (): Promise<Response> =>
    fetch(`${API_BASE_URL}${path}`, {
      credentials: 'include',
      ...rest,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(auth && accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  let res = await doFetch();

  if (res.status === 401 && auth) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      forceLogout();
      throw new ApiError(401, null, 'انتهت الجلسة، يرجى تسجيل الدخول مجددًا');
    }
    res = await doFetch();
  }

  const data = await parseBody(res);
  if (!res.ok) {
    throw new ApiError(res.status, data, extractErrorMessage(data) ?? `HTTP ${res.status}`);
  }
  return data as T;
}

/** طلب ببايتات خام (ciphertext) — نفس المصادقة وتجديد الجلسة مثل apiFetch. */
export async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  const go = () =>
    fetch(`${API_BASE_URL}${path}`, {
      credentials: 'include',
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${accessToken ?? ''}` },
    });
  let res = await go();
  if (res.status === 401 && (await refreshAccessToken())) res = await go();
  return res;
}

function extractErrorMessage(data: unknown): string | undefined {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const direct = record.detail ?? record.message;
    if (typeof direct === 'string') return direct;
    for (const value of Object.values(record)) {
      if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
      if (typeof value === 'string') return value;
    }
  }
  if (typeof data === 'string' && data) return data;
  return undefined;
}

export function toUserMessage(error: unknown, fallback = 'حدث خطأ غير متوقع، حاول مرة أخرى'): string {
  if (error instanceof ApiError) {
    if (error.status === 401 && error.message.startsWith('انتهت الجلسة')) return error.message;
    // جسم 5xx قد يكون صفحة خطأ/traceback كاملة — لا تُعرض للمستخدم.
    if (error.status >= 500) return 'خطأ في الخادم، حاول لاحقًا';
    const fromData = extractErrorMessage(error.data);
    if (fromData) return fromData;
    if (error.status === 401) return 'بيانات الدخول غير صحيحة';
  }
  return fallback;
}
