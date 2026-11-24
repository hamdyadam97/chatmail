/**
 * هل الصفحة تعمل داخل التطبيق المثبّت (APK أندرويد، أو «إضافة إلى الشاشة الرئيسية»
 * في الآيفون، أو التثبيت من Chrome/Edge على الكمبيوتر)؟
 * تطبيق أندرويد (TWA) يفتح الصفحة الأولى بمرجع android-app://… فنتذكره للجلسة.
 */
const KEY = 'installed-app';

export function isInstalledApp(): boolean {
  try {
    if (document.referrer.startsWith('android-app://')) sessionStorage.setItem(KEY, '1');
    if (sessionStorage.getItem(KEY) === '1') return true;
  } catch {
    // التخزين قد يكون محجوبًا — نكمل بفحص وضع العرض.
  }
  try {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}
