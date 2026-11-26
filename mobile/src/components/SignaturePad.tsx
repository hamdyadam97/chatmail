/**
 * رسم التوقيع بالإصبع. الخطوط تُرسل للخادم ({strokes, width, height}) فيرسمها
 * صورة PNG ويحفظها مختومة كالتوقيع المرفوع من الموقع.
 */
import { useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Text } from '@/components/Text';
import Svg, { Path } from 'react-native-svg';

import { Button, ErrorBox, success } from '@/components/ui';
import { api, errorText } from '@/lib/api';
import { colors, radius, row } from '@/lib/theme';

type Point = [number, number];

function pathOf(points: Point[]): string {
  if (!points.length) return '';
  const [first, ...rest] = points;
  return `M${first[0]} ${first[1]} ${rest.map(([x, y]) => `L${x} ${y}`).join(' ')}${rest.length ? '' : ` L${first[0] + 0.1} ${first[1]}`}`;
}

export function SignaturePad({ onSaved }: { onSaved: () => void }) {
  const [strokes, setStrokes] = useState<Point[][]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<Point[] | null>(null);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          const p: Point = [Math.round(e.nativeEvent.locationX), Math.round(e.nativeEvent.locationY)];
          current.current = [p];
          setStrokes((s) => [...s, [p]]);
        },
        onPanResponderMove: (e) => {
          if (!current.current) return;
          const p: Point = [Math.round(e.nativeEvent.locationX), Math.round(e.nativeEvent.locationY)];
          const last = current.current[current.current.length - 1];
          if (Math.abs(last[0] - p[0]) + Math.abs(last[1] - p[1]) < 2) return;
          current.current.push(p);
          const copy = [...current.current];
          setStrokes((s) => [...s.slice(0, -1), copy]);
        },
        onPanResponderRelease: () => {
          current.current = null;
        },
      }),
    [],
  );

  const onLayout = (e: LayoutChangeEvent) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/approvals/signature/', { method: 'PUT', body: { strokes, width: Math.round(size.w), height: Math.round(size.h) } });
      success();
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 10 }}>
      <View style={styles.pad} onLayout={onLayout} {...responder.panHandlers}>
        <Svg width="100%" height="100%">
          {strokes.map((s, i) => (
            <Path key={i} d={pathOf(s)} stroke="#14183C" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          ))}
        </Svg>
        {!strokes.length && (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <Text style={styles.hint}>وقّع هنا بإصبعك</Text>
          </View>
        )}
        <View pointerEvents="none" style={styles.line} />
      </View>
      <ErrorBox message={error} />
      <View style={{ flexDirection: row, gap: 10 }}>
        <Button title="حفظ التوقيع" icon="checkmark" style={{ flex: 1 }} loading={busy} disabled={!strokes.length} onPress={save} />
        <Button title="مسح" variant="secondary" style={{ flex: 1 }} disabled={!strokes.length || busy} onPress={() => setStrokes([])} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pad: {
    height: 190,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.navy,
    overflow: 'hidden',
  },
  hint: { textAlign: 'center', marginTop: 70, color: colors.textMuted, fontSize: 15 },
  line: { position: 'absolute', left: 24, right: 24, bottom: 44, height: 1, backgroundColor: colors.border },
});
