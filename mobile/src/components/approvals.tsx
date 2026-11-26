import { StyleSheet } from 'react-native';
import { Text } from '@/components/Text';

import { STATUS_LABELS, type RequestStatus } from '@/lib/approvals';
import { colors } from '@/lib/theme';

const STYLES: Record<RequestStatus, { color: string; bg: string }> = {
  pending: { color: colors.goldText, bg: colors.goldSoft },
  approved: { color: colors.successText, bg: colors.successSoft },
  completed: { color: colors.successText, bg: colors.successSoft },
  rejected: { color: colors.danger, bg: colors.dangerSoft },
  returned: { color: colors.goldText, bg: colors.goldSoft },
  cancelled: { color: colors.textSoft, bg: colors.bg },
};

export function StatusChip({ status }: { status: RequestStatus }) {
  const s = STYLES[status];
  return <Text style={[styles.chip, { color: s.color, backgroundColor: s.bg }]}>{STATUS_LABELS[status]}</Text>;
}

const styles = StyleSheet.create({
  chip: { fontSize: 11, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, overflow: 'hidden' },
});
