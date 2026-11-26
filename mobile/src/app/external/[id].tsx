/**
 * محادثة بريد خارجي: كل رسائلها من الأقدم للأحدث (المفتوحة وغير المقروءة
 * مفتوحة، والباقي سطر مختصر)، وشريط سفلي للرد على آخر رسالة واردة.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '@/components/Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar, Button, Empty, Header, Loading, T, tap } from '@/components/ui';
import { errorText } from '@/lib/api';
import {
  addressLine,
  externalApi,
  realAttachments,
  type ExternalDetail,
  type ExternalSummary,
  type MailboxInfo,
} from '@/lib/external';
import { openAttachment } from '@/lib/files';
import { formatBytes, fullDate, shortDate } from '@/lib/format';
import { colors, font, radius, row } from '@/lib/theme';

export default function ExternalScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const [opened, setOpened] = useState<ExternalDetail | null>(null);
  const [mailbox, setMailbox] = useState<MailboxInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    externalApi.me().then(setMailbox).catch(() => undefined);
    externalApi
      .get(id)
      .then((d) => {
        setOpened(d);
        const thread = d.thread?.length ? d.thread : [d];
        setOpen(new Set([id, ...thread.filter((t) => t.direction === 'in' && !t.read_at).map((t) => t.id)]));
      })
      .catch((err) => setError(errorText(err)));
  }, [id]);

  if (error || !opened) {
    return (
      <View style={{ flex: 1 }}>
        <Header title="" back />
        {error ? <Empty icon="alert-circle-outline" title="تعذر فتح الرسالة" hint={error} /> : <Loading />}
      </View>
    );
  }

  const thread = opened.thread?.length ? opened.thread : [opened];
  const subject = opened.content?.subject || opened.subject || '(بلا عنوان)';
  // الرد على آخر رسالة واردة في المحادثة (وإلا على المفتوحة).
  const lastIncoming = [...thread].reverse().find((t) => t.direction === 'in');
  const replyTarget = lastIncoming?.id ?? opened.id;
  const canSend = !!mailbox?.sending_enabled && !!mailbox?.sending_configured;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="" back />
      <ScrollView contentContainerStyle={{ paddingBottom: 130 }}>
        <View style={styles.top}>
          <T style={styles.subject}>{subject}</T>
          <View style={{ flexDirection: row, gap: 8, flexWrap: 'wrap' }}>
            <Text style={styles.badge}>خارجي</Text>
            {thread.length > 1 && <Text style={[styles.badge, { color: colors.textSoft, backgroundColor: colors.card }]}>{thread.length} رسائل</Text>}
          </View>
        </View>
        <View style={{ gap: 10, paddingHorizontal: 12 }}>
          {thread.map((item) => (
            <MessageCard
              key={item.id}
              item={item}
              preloaded={item.id === opened.id ? opened : null}
              mailboxAddress={mailbox?.address ?? ''}
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
      {canSend && (
        <View style={[styles.bottom, { paddingBottom: insets.bottom + 10, flexDirection: row }]}>
          {lastIncoming && (
            <Button
              title="رد"
              icon="arrow-undo"
              style={{ flex: 1 }}
              onPress={() => router.push({ pathname: '/external/compose', params: { reply: replyTarget } })}
            />
          )}
          {lastIncoming && (
            <Button
              title="رد على الكل"
              variant="secondary"
              style={{ flex: 1 }}
              onPress={() => router.push({ pathname: '/external/compose', params: { reply: replyTarget, all: '1' } })}
            />
          )}
          {!lastIncoming && (
            <Button
              title="رسالة أخرى"
              icon="create-outline"
              variant="secondary"
              style={{ flex: 1 }}
              onPress={() => router.push({ pathname: '/external/compose', params: { to: opened.recipients.join(', '), subject } })}
            />
          )}
        </View>
      )}
    </View>
  );
}

function MessageCard({
  item,
  preloaded,
  mailboxAddress,
  open,
  onToggle,
}: {
  item: ExternalSummary;
  preloaded: ExternalDetail | null;
  mailboxAddress: string;
  open: boolean;
  onToggle: () => void;
}) {
  const [detail, setDetail] = useState<ExternalDetail | null>(preloaded);
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const incoming = item.direction === 'in';
  const unread = incoming && !item.read_at;
  const who = incoming ? item.from_name || item.from : 'أنا';

  const fetchIt = useCallback(() => {
    if (detail) return;
    externalApi
      .get(item.id)
      .then(setDetail)
      .catch(() => setFailed(true));
  }, [detail, item.id]);

  useEffect(() => {
    if (!open) return;
    fetchIt();
    if (unread) void externalApi.read(item.id).catch(() => undefined);
  }, [open, fetchIt, unread, item.id]);

  const c = detail?.content;
  const files = c ? realAttachments(c) : [];
  const mine = mailboxAddress.toLowerCase();
  const nameOf = (a: { name: string; address: string }) => (a.address.toLowerCase() === mine ? 'أنا' : a.name || a.address);

  return (
    <View style={[styles.card, unread && { borderColor: colors.gold }]}>
      <Pressable onPress={onToggle} style={[styles.cardHead, { flexDirection: row }]}>
        <Avatar name={who} size={open ? 42 : 36} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: row, alignItems: 'center', gap: 6 }}>
            <T style={[styles.sender, unread && { fontWeight: '800' }]} numberOfLines={1}>
              {who}
            </T>
            {incoming && item.auth === 'pass' && <Ionicons name="shield-checkmark" size={14} color={colors.success} />}
            <Text style={styles.time}>{open ? '' : shortDate(item.created_at)}</Text>
          </View>
          {open ? (
            <T style={styles.meta}>{fullDate(item.created_at)}</T>
          ) : (
            <T style={styles.meta} numberOfLines={1}>
              {item.preview || item.subject}
            </T>
          )}
        </View>
      </Pressable>
      {open && (
        <View style={styles.cardBody}>
          {!c ? (
            failed ? (
              <T style={styles.meta}>تعذر عرض هذه الرسالة.</T>
            ) : (
              <ActivityIndicator color={colors.navy} />
            )
          ) : (
            <>
              {incoming && c.auth !== 'pass' && (
                <View style={[styles.warn, { flexDirection: row }]}>
                  <Ionicons name="warning" size={18} color={colors.danger} />
                  <T style={{ flex: 1, color: colors.danger, fontSize: font.tiny + 1 }}>
                    لم يُتحقق من هوية المرسل — قد يكون منتحلًا. لا تفتح روابط أو مرفقات لم تتوقعها.
                  </T>
                </View>
              )}
              <T style={styles.people} selectable>
                {incoming ? `من: ${addressLine(c.from)}\n` : ''}
                إلى: {c.to.map(nameOf).join('، ')}
                {c.cc.length ? `\nنسخة: ${c.cc.map(nameOf).join('، ')}` : ''}
              </T>
              <T style={styles.body} selectable>
                {c.body || '—'}
              </T>
              {files.length > 0 && (
                <View style={{ gap: 8, marginTop: 12 }}>
                  {files.map((a) => (
                    <Pressable
                      key={a.id}
                      onPress={() => {
                        tap();
                        setOpening(a.id);
                        openAttachment(a)
                          .catch((err) => Alert.alert('تعذر فتح الملف', errorText(err)))
                          .finally(() => setOpening(null));
                      }}
                      style={({ pressed }) => [styles.attachment, { flexDirection: row }, pressed && { backgroundColor: colors.navySoft }]}
                    >
                      {opening === a.id ? (
                        <ActivityIndicator color={colors.navy} />
                      ) : (
                        <Ionicons name="document-attach-outline" size={22} color={colors.navy} />
                      )}
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
              {c.removed_infected.length > 0 && (
                <T style={[styles.meta, { color: colors.danger, marginTop: 8 }]}>حُذفت مرفقات مصابة بفيروس: {c.removed_infected.join('، ')}</T>
              )}
            </>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  top: { paddingHorizontal: 16, paddingBottom: 14, gap: 8 },
  subject: { fontSize: 24, fontWeight: '800', lineHeight: 32 },
  badge: {
    fontSize: font.tiny,
    color: colors.goldText,
    backgroundColor: colors.goldSoft,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: 'hidden',
  },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  cardHead: { gap: 10, padding: 14, alignItems: 'center' },
  sender: { flex: 1, fontWeight: '700', fontSize: font.body },
  time: { fontSize: font.tiny, color: colors.textMuted },
  meta: { fontSize: font.tiny + 1, color: colors.textMuted },
  cardBody: { paddingHorizontal: 16, paddingBottom: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: 14, gap: 10 },
  warn: { alignItems: 'center', gap: 8, backgroundColor: colors.dangerSoft, borderRadius: radius.md, padding: 10 },
  people: { fontSize: font.tiny + 1, color: colors.textSoft, lineHeight: 20 },
  body: { fontSize: 16, lineHeight: 27, color: colors.text },
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
