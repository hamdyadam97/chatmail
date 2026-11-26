/**
 * سجل الطلب مع «رد» تحت كل ملاحظة وخانة تعليق في آخره (نفس الموقع)، وشريط
 * «ملاحظة من …» لمقدّم الطلب حين يكتب معتمد ملاحظة لم يرد عليها.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { Text, TextInput } from '@/components/Text';
import { T, success, tap } from '@/components/ui';
import { errorText } from '@/lib/api';
import { approvalsApi, EVENT_LABELS, type ApprovalEvent, type ApprovalRequest } from '@/lib/approvals';
import { fullDate } from '@/lib/format';
import { colors, font, radius, row, textRight } from '@/lib/theme';

const BANNER_KINDS = ['approved', 'rejected', 'returned', 'comment'];

/** آخر ملاحظة من معتمد لم يرد عليها مقدّم الطلب. */
export function pendingNote(req: ApprovalRequest, meId?: string): ApprovalEvent | undefined {
  if (!meId || req.requested_by.id !== meId || req.status === 'cancelled') return undefined;
  const answered = new Set(req.events.filter((e) => e.reply_to && e.actor.id === meId).map((e) => e.reply_to));
  return [...req.events]
    .reverse()
    .find((e) => !e.reply_to && !!e.note && e.actor.id !== meId && !answered.has(e.id) && BANNER_KINDS.includes(e.kind));
}

export function NoteBanner({ note, onReply }: { note: ApprovalEvent; onReply: () => void }) {
  return (
    <View style={[styles.banner, { flexDirection: row }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <T style={styles.bannerWho}>ملاحظة من {note.actor.full_name}</T>
        <T style={{ fontSize: font.small, color: colors.text }}>{note.note}</T>
      </View>
      <Pressable
        onPress={() => {
          tap();
          onReply();
        }}
        style={[styles.bannerBtn, { flexDirection: row }]}
      >
        <Ionicons name="arrow-undo-outline" size={16} color="#fff" />
        <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>رد</Text>
      </Pressable>
    </View>
  );
}

export function RequestLog({
  req,
  onUpdated,
  replyTo,
  setReplyTo,
}: {
  req: ApprovalRequest;
  onUpdated: (r: ApprovalRequest) => void;
  replyTo: string | null;
  setReplyTo: (id: string | null) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const canComment = req.status !== 'cancelled';
  const top = req.events.filter((e) => !e.reply_to);
  if (!top.length && !canComment) return null;

  const send = async (text: string, to: string | null) => {
    setSending(true);
    try {
      onUpdated(await approvalsApi.comment(req.id, text, to));
      success();
      setReplyTo(null);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={styles.card}>
      <T style={styles.section}>سجل الطلب</T>
      {top.map((e) => {
        const replies = req.events.filter((r) => r.reply_to === e.id);
        return (
          <View key={e.id} style={{ gap: 3, paddingVertical: 6 }}>
            <T style={{ fontSize: font.small }}>
              <Text style={{ fontWeight: '700' }}>{e.actor.full_name}</Text> {EVENT_LABELS[e.kind] ?? e.kind}
            </T>
            {!!e.note && <T style={styles.note}>{e.note}</T>}
            <T style={styles.meta}>{fullDate(e.created_at)}</T>
            {replies.map((r) => (
              <View key={r.id} style={styles.reply}>
                <T style={styles.meta}>
                  <Text style={{ fontWeight: '700', color: colors.text }}>{r.actor.full_name}</Text> ردّ · {fullDate(r.created_at)}
                </T>
                <T style={{ fontSize: font.small, color: colors.text }}>{r.note}</T>
              </View>
            ))}
            {canComment && !!e.note && replyTo !== e.id && (
              <Pressable hitSlop={8} onPress={() => setReplyTo(e.id)} style={{ flexDirection: row, alignItems: 'center', gap: 4 }}>
                <Ionicons name="arrow-undo-outline" size={15} color={colors.navy} />
                <Text style={{ color: colors.navy, fontWeight: '600', fontSize: 13 }}>رد</Text>
              </Pressable>
            )}
            {replyTo === e.id && (
              <CommentBox
                autoFocus
                placeholder={`ردك على ${e.actor.full_name}…`}
                sending={sending}
                onCancel={() => setReplyTo(null)}
                onSend={(t) => void send(t, e.id)}
              />
            )}
          </View>
        );
      })}
      {canComment && replyTo === null && (
        <CommentBox placeholder="اكتب تعليقًا أو استفسارًا…" sending={sending} onSend={(t) => void send(t, null)} />
      )}
      {!!error && <T style={{ color: colors.danger, fontSize: font.small }}>{error}</T>}
    </View>
  );
}

function CommentBox({ placeholder, sending, onSend, onCancel, autoFocus }: {
  placeholder: string;
  sending: boolean;
  onSend: (text: string) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const ready = !!text.trim() && !sending;
  return (
    <View style={{ gap: 6, marginTop: 4 }}>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        multiline
        maxLength={1000}
        autoFocus={autoFocus}
        style={[styles.input, textRight]}
      />
      <View style={{ flexDirection: row, gap: 8, justifyContent: 'flex-end' }}>
        {onCancel && (
          <Pressable onPress={onCancel} style={[styles.btn, { backgroundColor: colors.bg }]}>
            <Text style={{ color: colors.textSoft, fontWeight: '600' }}>إلغاء</Text>
          </Pressable>
        )}
        <Pressable
          disabled={!ready}
          onPress={() => {
            tap();
            onSend(text.trim());
            setText('');
          }}
          style={[styles.btn, { backgroundColor: colors.navyFill, opacity: ready ? 1 : 0.5, flexDirection: row }]}
        >
          {sending ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name="send" size={15} color="#fff" />}
          <Text style={{ color: '#fff', fontWeight: '700' }}>إرسال</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 14, gap: 10 },
  section: { fontWeight: '800', fontSize: font.body },
  note: { fontSize: font.small, color: colors.text, backgroundColor: colors.bg, borderRadius: 10, padding: 10, overflow: 'hidden' },
  meta: { fontSize: font.tiny, color: colors.textMuted },
  reply: { marginTop: 4, marginStart: 12, paddingStart: 10, borderStartWidth: 2, borderStartColor: '#E3E1F1', gap: 2 },
  input: {
    minHeight: 64,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: font.small,
    color: colors.text,
    textAlignVertical: 'top',
  },
  btn: { height: 38, paddingHorizontal: 14, borderRadius: 12, alignItems: 'center', justifyContent: 'center', gap: 6 },
  banner: { backgroundColor: colors.goldSoft, borderWidth: 1, borderColor: '#F6E7C4', borderRadius: radius.lg, padding: 12, gap: 10, alignItems: 'center' },
  bannerWho: { fontSize: 12, fontWeight: '700', color: colors.goldText },
  bannerBtn: { backgroundColor: colors.navyFill, borderRadius: 12, paddingHorizontal: 12, height: 36, alignItems: 'center', gap: 5 },
});
