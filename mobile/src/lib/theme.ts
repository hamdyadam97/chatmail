/**
 * ألوان المؤسسة (من الشعار: الكحلي والذهبي) واتجاه الواجهة.
 *
 * الاتجاه: التطبيق المبني يفرض RTL (expo-localization ‏forcesRTL). في Expo Go
 * قد يبقى الاتجاه LTR إن كانت لغة الهاتف غير العربية، فنبني الصفوف والمحاذاة
 * بهذه المساعدات لتبقى الواجهة عربية في الحالتين.
 */
import * as SecureStore from 'expo-secure-store';
import { Appearance, I18nManager, type TextStyle, type ViewStyle } from 'react-native';

/**
 * الوضع الليلي: الألوان تُختار مرة عند بدء التطبيق (الأنماط ثابتة في كل
 * شاشة)، فتغيير المظهر يعيد تشغيل الواجهة (`setThemePref` ثم reload).
 * «تلقائي» يتبع الهاتف — يحتاج APK بـ userInterfaceStyle "automatic"؛
 * النسخ الحالية تبلغ «فاتح» دائمًا.
 */
export type ThemePref = 'light' | 'dark' | 'system';
const THEME_KEY = 'corr.theme';

export function themePref(): ThemePref {
  try {
    const v = SecureStore.getItem(THEME_KEY);
    return v === 'dark' || v === 'system' ? v : 'light';
  } catch {
    return 'light';
  }
}

export async function setThemePref(v: ThemePref): Promise<void> {
  await SecureStore.setItemAsync(THEME_KEY, v);
}

const pref = themePref();
export const isDark = pref === 'dark' || (pref === 'system' && Appearance.getColorScheme() === 'dark');

const LIGHT = {
  /** لون النص والأيقونات والتحديد. */
  navy: '#28255F',
  /** خلفية الأزرار والبطاقات الكحلية (نصها أبيض). */
  navyFill: '#28255F',
  navyDark: '#1C1A47',
  navySoft: '#EEEDF7',
  gold: '#CB962B',
  goldSoft: '#FBF4E4',
  goldText: '#8A5A12',
  // أرضية «ورق» دافئة وخطوط فاصلة بنفس الدفء (تصميم الرئيسية 2026-11-26).
  bg: '#F5F3EE',
  card: '#FFFFFF',
  chip: '#ECE8DF',
  text: '#16152B',
  textSoft: '#5E5D72',
  textMuted: '#8E8DA0',
  border: '#E6E1D6',
  danger: '#C62828',
  dangerSoft: '#FDECEC',
  success: '#2E7D32',
  successSoft: '#E3F1EC',
  successText: '#1F6B52',
  info: '#0B6E99',
};

const DARK: typeof LIGHT = {
  navy: '#B3AEF2',
  navyFill: '#3E3A8C',
  navyDark: '#E4E2FB',
  navySoft: '#2A2842',
  gold: '#E0B65C',
  goldSoft: '#3A2F17',
  goldText: '#F2C673',
  bg: '#121119',
  card: '#1D1C27',
  chip: '#2A2935',
  text: '#ECEAF4',
  textSoft: '#B6B4C6',
  textMuted: '#8D8B9F',
  border: '#2F2D3D',
  danger: '#F07171',
  dangerSoft: '#3B1F22',
  success: '#6FCF8A',
  successSoft: '#173A30',
  successText: '#7FD3B2',
  info: '#6CC3EC',
};

export const colors = isDark ? DARK : LIGHT;

export const RTL = I18nManager.isRTL;

/** صف يبدأ من اليمين. */
export const row: ViewStyle['flexDirection'] =RTL ? 'row' : 'row-reverse';

/** محاذاة نص عربي لليمين (في RTL المحاذاة الطبيعية يمين أصلًا). */
export const textRight: TextStyle = RTL ? { writingDirection: 'rtl' } : { textAlign: 'right', writingDirection: 'rtl' };

/** أيقونة «رجوع» تشير لليمين، و«التالي» لليسار. */
export const backIcon = 'chevron-forward' as const;
export const forwardIcon = 'chevron-back' as const;

export const radius = { sm: 8, md: 12, lg: 16, xl: 22 };

export const font = {
  largeTitle: 30,
  title: 20,
  body: 16,
  small: 14,
  tiny: 12,
};
