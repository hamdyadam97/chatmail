/** قراءة المراسلة كمحادثة: الرسائل من الأقدم للأحدث، الأحدث وغير المقروء مفتوح، وشريط سفلي للرد. */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar, Button, Empty, Header, IconButton, Loading, T, tap } from '@/components/ui';
import { api, errorText } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatBytes, fullDate, shortDate } from '@/lib/format';
import { colors, font, radius, row } from '@/lib/theme';
import type { MailDetail, ThreadItem } from '@/lib/types';

export default function MailDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const [detail, setDetail] = useState<MailDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = async () => {
    try {
      const d = await api<MailDetail>(`/correspondences/${id}/`);
      setDetail(d);
      const items = d.thread_items;
      const last = items[items.length - 1];
      setOpen(new Set([...(last ? [last.id] : []), id, ...items.filter((i) => i.unread).map((i) => i.id)]));
      // المعروض يُعلَّم مقروءًا (الخادم يتجاهل رسائلي والمقروء أصلًا).
      const toMark = items.filter((i) => i.unread && i.sender_id !== user?.id).map((i) => i.id);
      if (d.sender.id !== user?.id && !d.read_at) toMark.push(d.id);
      void Promise.all([...new Set(toMark)].map((m) => api(`/correspondences/${m}/read/`, { method: 'POST' }).catch(() => undefined)));
    } catch (err) {
      setError(errorText(err));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const names = useMemo(() => {
    const m = new Map<string, string>();
    if (detail) {
      m.set(detail.sender.id, detail.sender.full_name || detail.sender.username);
      for (const p of detail.participants) m.set(p.user.id, p.user.full_name || p.user.username);
    }
    return m;
  }, [detail]);

  const flag = async (body: Record<string, boolean>) => {
    if (!detail) return;
    try {
      const f = await api<{ archived: boolean; is_important: boolean }>(`/correspondences/${detail.id}/flags/`, { method: 'POST', body });
      setDetail({ ...detail, archived: f.archived, is_important: f.is_important });
      if (body.archived) router.back();
    } catch (err) {
      Alert.alert('تعذر التنفيذ', errorText(err));
    }
  };

  if (error) {
    return (
      <View style={{ flex: 1 }}>
        <Header title="" back />
        <Empty icon="alert-circle-outline" title="تعذر فتح الرسالة" hint={error} />
      </View>
    );
  }
  if (!detail) {
    return (
      <View style={{ flex: 1 }}>
        <Header title="" back />
        <Loading />
      </View>
    );
  }

  const subject = detail.thread_items[0]?.subject || detail.subject || '(بلا عنوان)';
  const to = detail.participants.filter((p) => p.kind === 'to').map((p) => p.user.full_name || p.user.username);
  const cc = detail.participants.filter((p) => p.kind === 'cc').map((p) => p.user.full_name || p.user.username);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header
        title=""
        back
        right={
          <>
            <IconButton name={detail.is_important ? 'star' : 'star-outline'} color={detail.is_important ? colors.gold : colors.navy} onPress={() => void flag({ important: !detail.is_important })} />
            <IconButton name={detail.archived ? 'arrow-undo-outline' : 'archive-outline'} onPress={() => void flag({ archived: !detail.archived })} />
          </>
        }
      />
      <ScrollView contentContainerStyle={{ paddingBottom: 120 }}>
        <View style={styles.top}>
          <T style={styles.subject}>{subject}</T>
          <View style={{ flexDirection: row, gap: 8, flexWrap: 'wrap' }}>
            {!!detail.reference_number && <Text style={styles.ref}>{detail.reference_number}</Text>}
            {(detail.priority === 'urgent' || detail.priority === 'high') && (
              <Text style={[styles.ref, { color: colors.danger, backgroundColor: colors.dangerSoft }]}>
                {detail.priority === 'urgent' ? 'عاجلة' : 'أولوية عالية'}
              </Text>
            )}
          </View>
          <T style={styles.people} numberOfLines={3}>
            إلى: {to.join('، ') || '—'}
            {cc.length ? `\nنسخة: ${cc.join('، ')}` : ''}
          </T>
        </View>

        <View style={{ gap: 10, paddingHorizontal: 12 }}>
          {detail.thread_items.map((item) => (
            <Message
              key={item.id}
              item={item}
              sender={names.get(item.sender_id) ?? 'مشارك'}
              open={open.has(item.id)}
              onToggle={() => {
                tap();
                setOpen((prev) => {
                  const next = new Set(prev);
                  if (next.has(item.id)) next.delete(item.id);
                  else next.add(item.id);
                  return next;
                });
              }}
            />
          ))}
        </View>
      </ScrollView>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + 10, flexDirection: row }]}>
        <Button
          title="رد"
          icon="arrow-undo"
          style={{ flex: 1 }}
          onPress={() => router.push({ pathname: '/compose', params: { replyTo: detail.id, subject } })}
        />
      </View>
    </View>
  );
}

function Message({ item, sender, open, onToggle }: { item: ThreadItem; sender: string; open: boolean; onToggle: () => void }) {
  return (
    <View style={[styles.card, item.unread && { borderColor: colors.gold }]}>
      <Pressable onPress={onToggle} style={[styles.cardHead, { flexDirection: row }]}>
        <Avatar name={sender} size={open ? 42 : 36} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: row, alignItems: 'center', gap: 6 }}>
            <T style={[styles.sender, item.unread && { fontWeight: '800' }]} numberOfLines={1}>
              {sender}
            </T>
            <Text style={styles.time}>{open ? '' : shortDate(item.sent_at)}</Text>
          </View>
          {open ? (
            <T style={styles.meta}>{fullDate(item.sent_at)}</T>
          ) : (
            <T style={styles.meta} numberOfLines={1}>
              {item.body.replace(/\s+/g, ' ').slice(0, 120) || item.subject}
            </T>
          )}
        </View>
      </Pressable>
      {open && (
        <View style={styles.cardBody}>
          <T style={styles.body} selectable>
            {item.body}
          </T>
          {item.forwarded && (
            <View style={styles.quote}>
              <T style={styles.meta}>
                رسالة محالة من {item.forwarded.sender_name} — {fullDate(item.forwarded.sent_at)}
              </T>
              <T style={[styles.body, { fontSize: 15 }]}>{item.forwarded.body}</T>
            </View>
          )}
          {item.attachments.length > 0 && (
            <View style={{ gap: 8, marginTop: 12 }}>
              {item.attachments.map((a) => (
                <Pressable
                  key={a.id}
                  onPress={() => Alert.alert('المرفقات', 'فتح المرفقات من التطبيق في التحديث القادم — افتحها حاليًا من الموقع.')}
                  style={[styles.attachment, { flexDirection: row }]}
                >
                  <Ionicons name="document-attach-outline" size={22} color={colors.navy} />
                  <View style={{ flex: 1 }}>
                    <T style={{ fontSize: font.small, fontWeight: '600' }} numberOfLines={1}>
                      {a.name}
                    </T>
                    <T style={{ fontSize: font.tiny, color: colors.textMuted }}>{formatBytes(a.size)}</T>
                  </View>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  top: { paddingHorizontal: 16, paddingBottom: 14, gap: 8 },
  subject: { fontSize: 24, fontWeight: '800', lineHeight: 32 },
  ref: {
    fontSize: font.tiny,
    color: colors.navy,
    backgroundColor: colors.navySoft,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: 'hidden',
  },
  people: { fontSize: font.small, color: colors.textSoft, lineHeight: 21 },
  card: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  cardHead: { gap: 10, padding: 14, alignItems: 'center' },
  sender: { flex: 1, fontWeight: '700', fontSize: font.body },
  time: { fontSize: font.tiny, color: colors.textMuted },
  meta: { fontSize: font.tiny + 1, color: colors.textMuted },
  cardBody: { paddingHorizontal: 16, paddingBottom: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: 14 },
  body: { fontSize: 16, lineHeight: 27, color: colors.text },
  quote: { marginTop: 12, padding: 12, borderRadius: radius.md, backgroundColor: colors.bg, gap: 6 },
  attachment: { alignItems: 'center', gap: 10, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingTop: 10,
    backgroundColor: 'rgba(255,255,255,0.97)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: 10,
  },
});
