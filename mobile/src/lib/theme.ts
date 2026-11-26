/**
 * ألوان المؤسسة (من الشعار: الكحلي والذهبي) واتجاه الواجهة.
 *
 * الاتجاه: التطبيق المبني يفرض RTL (expo-localization ‏forcesRTL). في Expo Go
 * قد يبقى الاتجاه LTR إن كانت لغة الهاتف غير العربية، فنبني الصفوف والمحاذاة
 * بهذه المساعدات لتبقى الواجهة عربية في الحالتين.
 */
import { I18nManager, type TextStyle, type ViewStyle } from 'react-native';

export const colors = {
  navy: '#28255F',
  navyDark: '#1C1A47',
  navySoft: '#EEEDF7',
  gold: '#CB962B',
  goldSoft: '#FBF4E4',
  // أرضية «ورق» دافئة وخطوط فاصلة بنفس الدفء (تصميم الرئيسية 2026-11-26).
  bg: '#F5F3EE',
  card: '#FFFFFF',
  text: '#16152B',
  textSoft: '#5E5D72',
  textMuted: '#8E8DA0',
  border: '#E6E1D6',
  danger: '#C62828',
  dangerSoft: '#FDECEC',
  success: '#2E7D32',
};

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
