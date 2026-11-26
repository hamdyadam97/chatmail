/**
 * Text وTextInput بخط IBM Plex Sans Arabic في كل التطبيق.
 *
 * React Native لا يختار وزن الخط المخصص من fontWeight (خاصة على أندرويد)،
 * فكل وزن عائلة مستقلة: نحوّل fontWeight إلى العائلة المناسبة ونحذفه حتى لا
 * يُرسم «عريضًا مزيفًا». ما يحدد fontFamily بنفسه (monospace مثلًا) يبقى كما هو،
 * وقبل تحميل الخط (أو إن فشل) يُستعمل خط النظام.
 */
import { forwardRef, type ComponentRef } from 'react';
import {
  StyleSheet,
  Text as RNText,
  TextInput as RNTextInput,
  type TextInputProps,
  type TextProps,
  type TextStyle,
} from 'react-native';

import { colors } from '@/lib/theme';

export const FONTS = {
  regular: 'IBMPlexSansArabic_400Regular',
  medium: 'IBMPlexSansArabic_500Medium',
  semibold: 'IBMPlexSansArabic_600SemiBold',
  bold: 'IBMPlexSansArabic_700Bold',
};

let loaded = false;
/** يُستدعى من الجذر بعد تحميل الخطوط. */
export function setFontsLoaded(v: boolean) {
  loaded = v;
}

function family(weight: TextStyle['fontWeight']): string {
  switch (String(weight ?? '400')) {
    case '500':
      return FONTS.medium;
    case '600':
      return FONTS.semibold;
    case '700':
    case '800':
    case '900':
    case 'bold':
      return FONTS.bold;
    default:
      return FONTS.regular;
  }
}

function withFont(style: TextProps['style']): TextProps['style'] {
  const flat = (StyleSheet.flatten(style) ?? {}) as TextStyle;
  // نص بلا لون صريح = لون النص في المظهر الحالي (في الليلي لا يبقى أسود).
  const color = flat.color ?? colors.text;
  if (!loaded || flat.fontFamily) return { ...flat, color };
  const { fontWeight, ...rest } = flat;
  return { ...rest, color, fontFamily: family(fontWeight) };
}

export const Text = forwardRef<ComponentRef<typeof RNText>, TextProps>(function Text({ style, ...props }, ref) {
  return <RNText ref={ref} {...props} style={withFont(style)} />;
});

export const TextInput = forwardRef<ComponentRef<typeof RNTextInput>, TextInputProps>(function TextInput({ style, ...props }, ref) {
  return <RNTextInput ref={ref} {...props} style={withFont(style) as TextInputProps['style']} />;
});
