/**
 * الاتصال بالخادم — نفس `/api/v1` الذي يستعمله الموقع.
 *
 * التطبيق لا يعتمد على كوكيز: يرسل `X-Corr-Client: app` فيعيد الخادم رمز
 * التجديد (refresh) ورمز الجهاز في جسم الرد، ونحفظهما في المخزن الآمن
 * للهاتف (Keychain / Keystore). رمز الوصول (access) في الذاكرة فقط.
 */
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export const API_BASE: string =
  (Constants.expoConfig?.extra as { apiBase?: string } | undefined)?.apiBase ??
  'https://mail.m3had-system.cloud/api/v1';

const KEY_REFRESH = 'corr.refresh';
const KEY_DEVICE = 'corr.device';

const APP_VERSION = Constants.expoConfig?.version ?? '1.0';
const USER_AGENT = `CorrApp/${APP_VERSION} (${Platform.OS === 'ios' ? 'iPhone' : 'Android'})`;

let accessToken: string | null = null;
let onSignedOut: (() => void) | null = null;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly data: unknown,
    message?: string,
  ) {
    super(message ?? `HTTP ${status}`);
    this.name = 'ApiError';
  }
}

export function setAccessToken(token: string | null) {
  accessToken = token;
}

/** رؤوس طلب مصادَق (لتنزيل الملفات خارج api()). */
export async function authHeaders(): Promise<Record<string, string>> {
  const h = await baseHeaders(false);
  if (accessToken) h.Authorization = `Bearer ${accessToken}`;
  return h;
}

/** يُستدعى حين تنتهي الجلسة نهائيًا (التجديد مرفوض) — يعيد التطبيق لشاشة الدخول. */
export function onSessionEnded(cb: () => void) {
  onSignedOut = cb;
}

export const tokens = {
  refresh: () => SecureStore.getItemAsync(KEY_REFRESH),
  device: () => SecureStore.getItemAsync(KEY_DEVICE),
  async save(refresh?: string | null, device?: string | null) {
    if (refresh) await SecureStore.setItemAsync(KEY_REFRESH, refresh);
    if (device) await SecureStore.setItemAsync(KEY_DEVICE, device);
  },
  /** الخروج يمسح الجلسة فقط؛ رمز الجهاز يبقى ليبقى الهاتف «معروفًا» (بلا كود في المرة القادمة). */
  clearSession: () => SecureStore.deleteItemAsync(KEY_REFRESH),
};

async function baseHeaders(json: boolean): Promise<Record<string, string>> {
  const h: Record<string, string> = {
    Accept: 'application/json',
    'X-Corr-Client': 'app',
    'User-Agent': USER_AGENT,
  };
  if (json) h['Content-Type'] = 'application/json';
  const device = await tokens.device();
  if (device) h['X-Corr-Device'] = device;
  return h;
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

let refreshing: Promise<boolean> | null = null;

/** يجدد رمز الوصول من رمز التجديد المحفوظ (طلب واحد مهما تعددت النداءات). */
export function refreshSession(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      const refresh = await tokens.refresh();
      if (!refresh) return false;
      try {
        const res = await fetch(`${API_BASE}/auth/refresh/`, {
          method: 'POST',
          headers: await baseHeaders(true),
          body: JSON.stringify({ refresh }),
        });
        if (res.status === 401) {
          await tokens.clearSession();
          return false;
        }
        if (!res.ok) throw new ApiError(res.status, null);
        const data = (await res.json()) as { access: string; refresh: string };
        accessToken = data.access;
        await tokens.save(data.refresh);
        return true;
      } catch (err) {
        // انقطاع الشبكة لا يُخرج المستخدم — نعيد المحاولة لاحقًا.
        if (err instanceof ApiError) throw err;
        throw new ApiError(0, null, 'تعذر الاتصال بالخادم — تأكد من الإنترنت');
      }
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

interface Options {
  method?: string;
  body?: unknown;
  /** false لنقاط الدخول (لا رمز وصول ولا تجديد عند 401). */
  auth?: boolean;
}

export async function api<T>(path: string, { method = 'GET', body, auth = true }: Options = {}): Promise<T> {
  const send = async () => {
    const headers = await baseHeaders(body !== undefined);
    if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;
    try {
      return await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, null, 'تعذر الاتصال بالخادم — تأكد من الإنترنت');
    }
  };
  let res = await send();
  if (res.status === 401 && auth) {
    if (await refreshSession()) {
      res = await send();
    } else {
      onSignedOut?.();
      throw new ApiError(401, null, 'انتهت الجلسة — سجّل الدخول من جديد');
    }
  }
  const data = await parse(res);
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

function firstMessage(data: unknown): string | null {
  if (!data) return null;
  if (typeof data === 'string') return data.length < 200 && !data.includes('<') ? data : null;
  if (Array.isArray(data)) return firstMessage(data[0]);
  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (typeof obj.detail === 'string') return obj.detail;
    for (const v of Object.values(obj)) {
      const m = firstMessage(v);
      if (m) return m;
    }
  }
  return null;
}

/** رسالة عربية مناسبة للعرض. */
export function errorText(err: unknown, fallback = 'حدث خطأ، حاول مرة أخرى'): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return err.message;
    if (err.status >= 500) return 'خطأ في الخادم، حاول لاحقًا';
    return firstMessage(err.data) ?? (err.status === 401 ? err.message : fallback);
  }
  return fallback;
}
