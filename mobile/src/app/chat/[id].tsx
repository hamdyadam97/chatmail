/** المحادثة: فقاعات، تحديث كل 3 ثوانٍ وهي مفتوحة، تعليم المقروء، وتحميل الأقدم بالسحب لأعلى. */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '@/components/Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Header, T, tap } from '@/components/ui';
import { errorText } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { chatApi, conversationName, newId, type ChatMessage, type Conversation } from '@/lib/chat';
import { colors, font, RTL, row, textRight } from '@/lib/theme';

/** رسائلي على الطرف الأيسر (كتطبيقات المراسلة بالعربية)، ورسائل الآخرين يمينًا. */
const LEFT = RTL ? 'flex-end' : 'flex-start';
const RIGHT = RTL ? 'flex-start' : 'flex-end';

interface Pending extends ChatMessage {
  pending?: boolean;
  failed?: boolean;
}

function time(iso: string): string {
  const d = new Date(iso);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = h < 12 ? 'ص' : 'م';
  h = h % 12 || 12;
  return `${h}:${m} ${s}`;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const diff = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  if (diff === 0) return 'اليوم';
  if (diff === 1) return 'أمس';
  return d.toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' });
}

export default function ConversationScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const [conv, setConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Pending[] | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [olderDone, setOlderDone] = useState(false);
  const loadingOlder = useRef(false);
  const lastSeq = useRef(0);
  const readSeq = useRef(0);

  const names = useMemo(() => new Map((conv?.members ?? []).map((m) => [m.id, m.full_name || m.username])), [conv]);

  const markRead = useCallback(
    (seq: number) => {
      if (seq > readSeq.current) {
        readSeq.current = seq;
        void chatApi.read(id, seq).catch(() => undefined);
      }
    },
    [id],
  );

  const merge = useCallback(
    (incoming: ChatMessage[]) => {
      if (!incoming.length) return;
      setMessages((prev) => {
        const list = [...(prev ?? [])];
        for (const m of incoming) {
          const pendingIdx = list.findIndex((x) => x.pending && x.client_msg_id && x.client_msg_id === m.client_msg_id);
          if (pendingIdx >= 0) list.splice(pendingIdx, 1);
          if (!list.some((x) => !x.pending && x.seq === m.seq)) list.push(m);
        }
        return list.sort((a, b) => (a.pending ? 1 : 0) - (b.pending ? 1 : 0) || a.seq - b.seq);
      });
      const max = Math.max(...incoming.map((m) => m.seq));
      lastSeq.current = Math.max(lastSeq.current, max);
      markRead(lastSeq.current);
    },
    [markRead],
  );

  useEffect(() => {
    chatApi
      .list()
      .then((all) => setConv(all.find((c) => c.id === id) ?? null))
      .catch(() => undefined);
    chatApi
      .latest(id)
      .then((r) => {
        setMessages([]);
        merge(r.messages);
        if (r.messages.length < 50) setOlderDone(true);
      })
      .catch((err) => {
        setMessages([]);
        setError(errorText(err));
      });
  }, [id, merge]);

  // وهي مفتوحة والتطبيق ظاهر: رسائل جديدة كل 3 ثوانٍ.
  useFocusEffect(
    useCallback(() => {
      const poll = () => {
        if (AppState.currentState !== 'active' || messages === null) return;
        chatApi.after(id, lastSeq.current).then((r) => merge(r.messages)).catch(() => undefined);
      };
      const t = setInterval(poll, 3000);
      return () => clearInterval(t);
    }, [id, merge, messages === null]), // eslint-disable-line react-hooks/exhaustive-deps
  );

  const older = async () => {
    if (olderDone || loadingOlder.current || !messages?.length) return;
    loadingOlder.current = true;
    const first = messages.find((m) => !m.pending);
    try {
      const r = await chatApi.before(id, first?.seq ?? 1);
      if (r.messages.length < 50) setOlderDone(true);
      setMessages((prev) => [...r.messages.filter((m) => !(prev ?? []).some((x) => x.seq === m.seq)), ...(prev ?? [])]);
    } catch {
      // لا شيء — يُعاد عند السحب التالي.
    }
    loadingOlder.current = false;
  };

  const send = async (body = text.trim(), retryOf?: string) => {
    if (!body) return;
    tap();
    const clientMsgId = retryOf ?? newId();
    if (!retryOf) setText('');
    setMessages((prev) => [
      ...(prev ?? []).filter((m) => m.client_msg_id !== clientMsgId),
      { seq: Number.MAX_SAFE_INTEGER, sender_user_id: user?.id ?? null, content: { text: body }, client_msg_id: clientMsgId, created_at: new Date().toISOString(), pending: true },
    ]);
    try {
      merge([await chatApi.send(id, body, clientMsgId)]);
    } catch {
      setMessages((prev) => (prev ?? []).map((m) => (m.client_msg_id === clientMsgId ? { ...m, failed: true } : m)));
    }
  };

  const title = name || (conv ? conversationName(conv, user?.id) : '');
  const reversed = [...(messages ?? [])].reverse();

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: '#EFEDE8' }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Header title={title} back large={false} />
      {messages === null ? (
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <ActivityIndicator color={colors.navy} />
        </View>
      ) : (
        <FlatList
          inverted
          data={reversed}
          keyExtractor={(m) => (m.pending ? `p-${m.client_msg_id}` : String(m.seq))}
          onEndReached={older}
          onEndReachedThreshold={0.3}
          contentContainerStyle={{ padding: 12, gap: 4, flexGrow: 1 }}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', padding: 30, transform: [{ scaleY: -1 }] }}>
              <Text style={{ color: colors.textMuted }}>{error ?? 'ابدأ المحادثة'}</Text>
            </View>
          }
          renderItem={({ item: m, index }) => {
            const mine = m.sender_user_id === user?.id;
            const next = reversed[index + 1]; // the message before it in time
            const newDay = !next || new Date(next.created_at).toDateString() !== new Date(m.created_at).toDateString();
            const sameSender = next && !newDay && next.sender_user_id === m.sender_user_id;
            return (
              <View>
                {newDay && (
                  <View style={styles.day}>
                    <Text style={styles.dayText}>{dayLabel(m.created_at)}</Text>
                  </View>
                )}
                <Pressable
                  disabled={!m.failed}
                  onPress={() => void send(m.content?.text ?? '', m.client_msg_id)}
                  style={[styles.bubble, mine ? styles.mine : styles.theirs, { alignSelf: mine ? LEFT : RIGHT }, !sameSender && { marginTop: 6 }]}
                >
                  {!mine && conv?.type === 'group' && !sameSender && (
                    <T style={styles.sender}>{names.get(m.sender_user_id ?? '') ?? 'عضو سابق'}</T>
                  )}
                  <T style={[styles.text, mine && { color: '#fff' }]} selectable>
                    {m.content?.text ?? 'تعذر عرض الرسالة'}
                  </T>
                  <View style={{ flexDirection: row, alignItems: 'center', gap: 4, alignSelf: 'flex-end' }}>
                    {m.failed ? (
                      <Text style={[styles.time, { color: '#FFD6D6' }]}>لم تُرسل — اضغط لإعادة المحاولة</Text>
                    ) : (
                      <Text style={[styles.time, mine && { color: 'rgba(255,255,255,0.75)' }]}>{m.pending ? 'يُرسل…' : time(m.created_at)}</Text>
                    )}
                  </View>
                </Pressable>
              </View>
            );
          }}
        />
      )}
      <View style={[styles.composer, { paddingBottom: insets.bottom + 8, flexDirection: row }]}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="اكتب رسالة"
          placeholderTextColor={colors.textMuted}
          multiline
          style={[styles.input, textRight]}
        />
        <Pressable onPress={() => void send()} disabled={!text.trim()} style={[styles.sendBtn, !text.trim() && { opacity: 0.4 }]}>
          <Ionicons name="send" size={20} color="#fff" style={{ transform: [{ scaleX: -1 }] }} />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  bubble: { maxWidth: '82%', borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8, gap: 2 },
  mine: { backgroundColor: colors.navy },
  theirs: { backgroundColor: '#fff' },
  sender: { fontSize: font.tiny, fontWeight: '800', color: colors.gold },
  text: { fontSize: 16, lineHeight: 23, color: colors.text },
  time: { fontSize: 11, color: colors.textMuted },
  day: { alignSelf: 'center', backgroundColor: 'rgba(255,255,255,0.85)', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 3, marginVertical: 10 },
  dayText: { fontSize: font.tiny, color: colors.textSoft, fontWeight: '600' },
  composer: { alignItems: 'flex-end', gap: 8, paddingHorizontal: 10, paddingTop: 8, backgroundColor: '#F7F7F7', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  input: { flex: 1, maxHeight: 130, minHeight: 42, backgroundColor: '#fff', borderRadius: 21, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10, fontSize: 16, color: colors.text },
  sendBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.navy, alignItems: 'center', justifyContent: 'center' },
});
