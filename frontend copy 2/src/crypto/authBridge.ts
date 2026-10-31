/**
 * جسر رفيع بين سياق المصادقة (React) وطبقة crypto المستقلة عن React:
 * يضبطه مزود التطبيق مرة واحدة، وتقرؤه وحدات crypto لمعرفة المستخدم الحالي
 * دون استيراد دوري لمكتبات الواجهة.
 */
export interface AuthUserRef {
  id: number | string;
}

let resolver: () => AuthUserRef = () => {
  throw new Error('جسر المصادقة غير مهيأ — استدعِ setAuthBridge من مزود التطبيق');
};

export function setAuthBridge(fn: () => AuthUserRef): void {
  resolver = fn;
}

export function useAuthUser(): AuthUserRef {
  return resolver();
}
