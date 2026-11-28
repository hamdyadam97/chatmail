/** رسالة جديدة (اختيار المستلمين من دليل الموظفين) أو رد داخل المحادثة. */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '@/components/Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar, T, success, tap } from '@/components/ui';
import { api, errorText } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { colors, font, radius, row, textRight } from '@/lib/theme';
import type { AttachmentMeta, DirectoryUser, MailDetail } from '@/lib/types';
import { pickFile, uploadAttachment } from '@/lib/upload';

/** مرفق في المحرر: بلا meta = يُرفع الآن. */
interface Attached {
  key: string;
  name: string;
  meta?: AttachmentMeta;
}

function clientRef(): string {
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

const unit = (u: DirectoryUser) => u.primary_membership?.branch || u.primary_membership?.institute || '';

export default function ComposeScreen() {
  const { replyTo, subject: replySubject, draftId } = useLocalSearchParams<{ replyTo?: string; subject?: string; draftId?: string }>();
  const isReply = !!replyTo;
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [to, setTo] = useState<DirectoryUser[]>([]);
  const [cc, setCc] = useState<DirectoryUser[]>([]);
  const [field, setField] = useState<'to' | 'cc'>('to');
  const [showCc, setShowCc] = useState(false);
  const [query, setQuery] = useState('');
  const [subject, setSubject] = useState(isReply ? `رد: ${(replySubject ?? '').replace(/^(رد:\s*)+/, '')}` : '');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [files, setFiles] = useState<Attached[]>([]);
  const uploading = files.some((f) => !f.meta);

  useEffect(() => {
    api<DirectoryUser[] | { results: DirectoryUser[] }>('/users/')
      .then((d) => setUsers(Array.isArray(d) ? d : d.results ?? []))
      .catch(() => undefined);
  }, []);

  // الرد: المستلمون كما يختارهم الخادم (المرسل في «إلى» والباقون نسخة، أو نفس
  // «إلى»/«نسخة» لمتابعة رسالتي)، ثم يضيف المستخدم أو يحذف.
  useEffect(() => {
    if (!replyTo) return;
    api<MailDetail>(`/correspondences/${replyTo}/`)
      .then((d) => {
        const me = String(user?.id ?? '');
        const ref = (p: { id: string; full_name: string; username: string }) => ({ id: p.id, full_name: p.full_name, username: p.username });
        const people = d.participants.filter((p) => (p.kind === 'to' || p.kind === 'cc') && String(p.user.id) !== me);
        let toList, ccList;
        if (String(d.sender.id) !== me) {
          toList = [ref(d.sender)];
          ccList = people.filter((p) => String(p.user.id) !== String(d.sender.id)).map((p) => ref(p.user));
        } else {
          toList = people.filter((p) => p.kind === 'to').map((p) => ref(p.user));
          ccList = people.filter((p) => p.kind === 'cc').map((p) => ref(p.user));
        }
        setTo(toList);
        setCc(ccList);
        setShowCc(ccList.length > 0);
      })
      .catch(() => undefined);
  }, [replyTo, user]);

  // من أُرشف حسابه لا يبقى مستلمًا (الخادم يرفض المعطّل).
  useEffect(() => {
    if (!isReply || !users.length) return;
    const active = new Set(users.map((u) => String(u.id)));
    setTo((v) => v.filter((u) => active.has(String(u.id))));
    setCc((v) => v.filter((u) => active.has(String(u.id))));
  }, [isReply, users]);

  // فتح مسودة محفوظة: المستلمون والموضوع والنص ومرفقاتها.
  useEffect(() => {
    if (!draftId) return;
    api<MailDetail>(`/correspondences/${draftId}/`)
      .then((d) => {
        const people = (kind: 'to' | 'cc') =>
          d.participants.filter((p) => p.kind === kind).map((p) => ({ id: p.user.id, full_name: p.user.full_name, username: p.user.username }));
        setTo(people('to'));
        const ccList = people('cc');
        setCc(ccList);
        setShowCc(ccList.length > 0);
        setSubject(d.content?.subject ?? d.subject ?? '');
        setBody(d.content?.body ?? '');
        setFiles((d.content?.attachments ?? []).map((meta) => ({ key: meta.id, name: meta.name, meta })));
      })
      .catch((err) => Alert.alert('تعذر فتح المسودة', errorText(err)));
  }, [draftId]);

  const attach = () =>
    pickFile((f) => {
      const key = `${Date.now()}-${Math.random()}`;
      setFiles((prev) => [...prev, { key, name: f.name }]);
      uploadAttachment(f)
        .then((meta) => setFiles((prev) => prev.map((x) => (x.key === key ? { ...x, meta } : x))))
        .catch((err) => {
          setFiles((prev) => prev.filter((x) => x.key !== key));
          Alert.alert('تعذر إرفاق الملف', errorText(err));
        });
    });

  const attachmentIds = files.filter((f) => f.meta).map((f) => f.meta!.id);

  const draftBody = () => ({
    to_user_ids: to.map((u) => String(u.id)),
    cc_user_ids: cc.map((u) => String(u.id)),
    priority: 'normal',
    classification: 'normal',
    due_date: null,
    subject: subject.trim(),
    body,
    attachment_ids: attachmentIds,
  });

  const saveDraft = async () => {
    setSending(true);
    try {
      if (draftId) await api(`/correspondences/${draftId}/`, { method: 'PATCH', body: draftBody() });
      else await api('/correspondences/', { method: 'POST', body: { ...draftBody(), client_ref: clientRef(), send: false } });
      success();
      router.back();
    } catch (err) {
      Alert.alert('تعذر حفظ المسودة', errorText(err));
    } finally {
      setSending(false);
    }
  };

  const chosen = useMemo(() => new Set([...to, ...cc].map((u) => String(u.id)).concat(String(user?.id))), [to, cc, user]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return users
      .filter((u) => !chosen.has(String(u.id)))
      .filter((u) => (u.full_name ?? '').toLowerCase().includes(q) || (u.username ?? '').toLowerCase().includes(q) || unit(u).toLowerCase().includes(q))
      .slice(0, 20);
  }, [users, query, chosen]);

  const pick = (u: DirectoryUser) => {
    tap();
    (field === 'to' ? setTo : setCc)((prev) => [...prev, u]);
    setQuery('');
  };

  const canSend = !sending && !uploading && body.trim().length > 0 && to.length > 0 && (isReply || subject.trim().length > 0);

  const send = async () => {
    setSending(true);
    try {
      if (isReply) {
        await api(`/correspondences/${replyTo}/reply/`, {
          method: 'POST',
          body: {
            client_ref: clientRef(),
            priority: 'normal',
            due_date: null,
            subject: subject.trim(),
            body,
            attachment_ids: attachmentIds,
            to_user_ids: to.map((u) => String(u.id)),
            cc_user_ids: cc.map((u) => String(u.id)),
          },
        });
      } else if (draftId) {
        await api(`/correspondences/${draftId}/`, { method: 'PATCH', body: draftBody() });
        await api(`/correspondences/${draftId}/send/`, { method: 'POST' });
      } else {
        await api('/correspondences/', { method: 'POST', body: { ...draftBody(), client_ref: clientRef(), send: true } });
      }
      success();
      router.back();
    } catch (err) {
      Alert.alert('لم تُرسل الرسالة', errorText(err));
    } finally {
      setSending(false);
    }
  };

  const cancel = () => {
    if (!body.trim() && (isReply || !to.length) && !files.length) return router.back();
    if (isReply) {
      return Alert.alert('تجاهل الرد؟', 'لن يُحفظ.', [
        { text: 'متابعة الكتابة', style: 'cancel' },
        { text: 'تجاهل', style: 'destructive', onPress: () => router.back() },
      ]);
    }
    Alert.alert('حفظ كمسودة؟', 'تجدها في «المسودات» وتكملها من أي جهاز.', [
      { text: 'حفظ كمسودة', onPress: () => void saveDraft() },
      { text: 'تجاهل', style: 'destructive', onPress: () => router.back() },
      { text: 'متابعة الكتابة', style: 'cancel' },
    ]);
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.card }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.bar, { paddingTop: Platform.OS === 'ios' ? 14 : insets.top + 10, flexDirection: row }]}>
        <Pressable hitSlop={10} onPress={cancel}>
          <Text style={styles.cancel}>إلغاء</Text>
        </Pressable>
        <Text style={styles.barTitle}>{isReply ? 'رد' : 'رسالة جديدة'}</Text>
        <Pressable hitSlop={10} disabled={!canSend} onPress={send} style={[styles.sendBtn, !canSend && { opacity: 0.4 }]}>
          {sending ? <ActivityIndicator color="#fff" /> : <Ionicons name="send" size={18} color="#fff" style={{ transform: [{ scaleX: -1 }] }} />}
        </Pressable>
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
        {(
          <>
            <Recipients
              label="إلى"
              people={to}
              active={field === 'to'}
              onFocus={() => setField('to')}
              onRemove={(id) => setTo((p) => p.filter((u) => String(u.id) !== id))}
              query={field === 'to' ? query : ''}
              onQuery={(q) => {
                setField('to');
                setQuery(q);
              }}
              trailing={
                !showCc && (
                  <Pressable hitSlop={8} onPress={() => setShowCc(true)}>
                    <Text style={styles.ccToggle}>نسخة</Text>
                  </Pressable>
                )
              }
            />
            {showCc && (
              <Recipients
                label="نسخة"
                people={cc}
                active={field === 'cc'}
                onFocus={() => setField('cc')}
                onRemove={(id) => setCc((p) => p.filter((u) => String(u.id) !== id))}
                query={field === 'cc' ? query : ''}
                onQuery={(q) => {
                  setField('cc');
                  setQuery(q);
                }}
              />
            )}
            {matches.length > 0 && (
              <View style={styles.suggestions}>
                {matches.map((u) => (
                  <Pressable key={String(u.id)} onPress={() => pick(u)} style={({ pressed }) => [styles.suggestion, { flexDirection: row }, pressed && { backgroundColor: colors.navySoft }]}>
                    <Avatar name={u.full_name} size={36} />
                    <View style={{ flex: 1 }}>
                      <T style={{ fontWeight: '600' }}>{u.full_name || u.username}</T>
                      {!!unit(u) && <T style={{ fontSize: font.tiny, color: colors.textMuted }}>{unit(u)}</T>}
                    </View>
                  </Pressable>
                ))}
              </View>
            )}
            {isReply && (
              <Text style={styles.hint}>من تضيفه يرى هذا الرد وما بعده فقط، لا الرسائل السابقة.</Text>
            )}
          </>
        )}

        <View style={[styles.line, { flexDirection: row }]}>
          <Text style={styles.label}>الموضوع</Text>
          <TextInput value={subject} onChangeText={setSubject} style={[styles.input, textRight]} placeholder="" maxLength={300} />
          <Pressable hitSlop={10} onPress={attach} accessibilityLabel="إرفاق">
            <Ionicons name="attach" size={24} color={colors.navy} />
          </Pressable>
        </View>
        {files.length > 0 && (
          <View style={[styles.files, { flexDirection: row }]}>
            {files.map((f) => (
              <View key={f.key} style={[styles.file, { flexDirection: row }]}>
                {f.meta ? <Ionicons name="document-attach-outline" size={16} color={colors.navy} /> : <ActivityIndicator size="small" color={colors.navy} />}
                <Text style={styles.fileName} numberOfLines={1}>
                  {f.name}
                </Text>
                {f.meta && (
                  <Pressable hitSlop={8} onPress={() => setFiles((prev) => prev.filter((x) => x.key !== f.key))}>
                    <Ionicons name="close-circle" size={18} color={colors.textMuted} />
                  </Pressable>
                )}
              </View>
            ))}
          </View>
        )}
        <TextInput
          value={body}
          onChangeText={setBody}
          placeholder="اكتب رسالتك…"
          placeholderTextColor={colors.textMuted}
          multiline
          autoFocus={isReply}
          style={[styles.body, textRight]}
          textAlignVertical="top"
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Recipients({
  label,
  people,
  active,
  onFocus,
  onRemove,
  query,
  onQuery,
  trailing,
}: {
  label: string;
  people: DirectoryUser[];
  active: boolean;
  onFocus: () => void;
  onRemove: (id: string) => void;
  query: string;
  onQuery: (q: string) => void;
  trailing?: ReactNode;
}) {
  return (
    <View style={[styles.line, { flexDirection: row, flexWrap: 'wrap' }]}>
      <Text style={styles.label}>{label}</Text>
      {people.map((u) => (
        <Pressable key={String(u.id)} onPress={() => onRemove(String(u.id))} style={[styles.pill, { flexDirection: row }]}>
          <Text style={styles.pillText}>{u.full_name || u.username}</Text>
          <Ionicons name="close" size={14} color={colors.navy} />
        </Pressable>
      ))}
      <TextInput
        value={active ? query : ''}
        onFocus={onFocus}
        onChangeText={onQuery}
        placeholder={people.length ? '' : 'اكتب اسم الموظف'}
        placeholderTextColor={colors.textMuted}
        style={[styles.input, { minWidth: 120 }, textRight]}
        autoCorrect={false}
      />
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  cancel: { fontSize: 17, color: colors.navy },
  barTitle: { fontSize: 17, fontWeight: '700', color: colors.text },
  sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.navyFill, alignItems: 'center', justifyContent: 'center' },
  line: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    minHeight: 50,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  label: { fontSize: font.body, color: colors.textMuted },
  input: { flex: 1, fontSize: font.body, color: colors.text, paddingVertical: 6 },
  hint: { fontSize: font.tiny, color: colors.textMuted, paddingHorizontal: 16, paddingVertical: 6 },
  ccToggle: { color: colors.navy, fontSize: font.small, fontWeight: '600' },
  pill: { alignItems: 'center', gap: 4, backgroundColor: colors.navySoft, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  pillText: { color: colors.navy, fontSize: font.small, fontWeight: '600' },
  suggestions: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.bg },
  suggestion: { alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10 },
  files: { flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  file: { alignItems: 'center', gap: 6, backgroundColor: colors.navySoft, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 6, maxWidth: '100%' },
  fileName: { fontSize: font.small, color: colors.navy, maxWidth: 200 },
  body: { minHeight: 300, fontSize: 17, lineHeight: 26, color: colors.text, padding: 16 },
});
