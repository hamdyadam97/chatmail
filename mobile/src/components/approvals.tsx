import { StyleSheet, Text } from 'react-native';

import { STATUS_LABELS, type RequestStatus } from '@/lib/approvals';

const STYLES: Record<RequestStatus, { color: string; bg: string }> = {
  pending: { color: '#8A5A00', bg: '#FFF4DC' },
  approved: { color: '#1E6B35', bg: '#E5F5EA' },
  completed: { color: '#1E6B35', bg: '#E5F5EA' },
  rejected: { color: '#B3261E', bg: '#FDECEC' },
  returned: { color: '#A34A00', bg: '#FDEFE2' },
  cancelled: { color: '#5E5D72', bg: '#EEEEF2' },
};

export function StatusChip({ status }: { status: RequestStatus }) {
  const s = STYLES[status];
  return <Text style={[styles.chip, { color: s.color, backgroundColor: s.bg }]}>{STATUS_LABELS[status]}</Text>;
}

const styles = StyleSheet.create({
  chip: { fontSize: 11, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, overflow: 'hidden' },
});
