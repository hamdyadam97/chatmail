/** رسالة خارجية جديدة أو رد (يخرج عبر الإنترنت باسم الموظف ومن عنوانه). */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { T, success, tap } from '@/components/ui';
import { errorText } from '@/lib/api';
import {
  addressLine,
  externalApi,
  fileForSend,
  parseAddresses,
  type ExternalContact,
  type MailboxInfo,
} from '@/lib/external';
import { fullDate } from '@/lib/format';
import { colors, font, radius, row, textRight } from '@/lib/theme';
import { pickFile, type LocalFile } from '@/lib/upload';

const MAX_TOTAL = 15 * 1024 * 1024;

export default function ExternalComposeScreen() {
  const params = useLocalSearchParams<{ reply?: string; all?: string; to?: string; subject?: string }>();
  const insets = useSafeAreaInsets();
  const [mailbox, setMailbox] = useState<MailboxInfo | null>(null);
  const [contacts, setContacts] = useState<ExternalContact[]>([]);
  const [to, setTo] = useState(params.to ?? '');
  const [cc, setCc] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [field, setField] = useState<'to' | 'cc'>('to');
  const [subject, setSubject] = useState(params.subject ?? '');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);

  useEffect(() => {
    externalApi.me().then(setMailbox).catch(() => undefined);
    externalApi.contacts().then(setContacts).catch(() => undefined);
  }, []);

  // الرد: المرسل في «إلى» (والبقية في «نسخة» للرد على الكل)، و«Re:»، والنص الأصلي مقتبسًا.
  useEffect(() => {
    if (!params.reply) return;
    externalApi
      .get(params.reply)
      .then((d) => {
        const c = d.content;
        if (!c) return;
        setTo(c.from.address);
        setNames(Object.fromEntries([c.from, ...c.to, ...c.cc].filter((a) => a.name).map((a) => [a.address.toLowerCase(), a.name])));
        if (params.all === '1') {
          externalApi.me().then((mb) => {
            const skip = [(mb.address ?? '').toLowerCase(), c.from.address.toLowerCase()];
            const others = [...c.to, ...c.cc].map((a) => a.address).filter((a) => !skip.includes(a.toLowerCase()));
            if (others.length) {
              setCc(others.join(', '));
              setShowCc(true);
            }
          }).catch(() => undefined);
        }
        setSubject(/^(re|رد)\s*:/i.test(c.subject) ? c.subject : `Re: ${c.subject}`);
        const quoted = c.body.split('\n').slice(0, 60).map((l) => `> ${l}`).join('\n');
        setBody(`\n\n— كتب ${addressLine(c.from)} في ${fullDate(d.created_at)}:\n${quoted}`);
      })
      .catch((err) => Alert.alert('تعذر فتح الرسالة', errorText(err)));
  }, [params.reply, params.all]);

  const current = field === 'to' ? to : cc;
  const lastToken = current.split(/[,;،]/).pop()?.trim().toLowerCase() ?? '';
  const suggestions = useMemo(() => {
    if (lastToken.length < 2) return [];
    return contacts
      .filter((c) => c.address.includes(lastToken) || c.name.toLowerCase().includes(lastToken))
      .slice(0, 6);
  }, [contacts, lastToken]);

  const choose = (c: ExternalContact) => {
    tap();
    const set = field === 'to' ? setTo : setCc;
    const value = field === 'to' ? to : cc;
    const parts = value.split(/[,;،]/).map((x) => x.trim()).filter(Boolean);
    parts.pop();
    set([...parts, c.address].join(', ') + ', ');
    if (c.name) setNames((n) => ({ ...n, [c.address.toLowerCase()]: c.name }));
  };

  const canSend = !sending && to.trim().length > 0 && subject.trim().length > 0;

  const send = async () => {
    const t = parseAddresses(to);
    const k = parseAddresses(cc);
    const bad = [...t.bad, ...k.bad];
    if (bad.length) return Alert.alert('عنوان غير صالح', bad.join('\n'));
    if (!t.ok.length) return Alert.alert('أضف مستلمًا', 'اكتب عنوان بريد واحدًا على الأقل في «إلى».');
    const total = files.reduce((n, f) => n + (f.size ?? 0), 0);
    if (total > MAX_TOTAL) return Alert.alert('المرفقات كبيرة', 'المجموع أكبر من 15 م.ب.');
    setSending(true);
    try {
      const attachments = await Promise.all(files.map(fileForSend));
      const typed = Object.fromEntries([...t.ok, ...k.ok].filter((a) => a.name).map((a) => [a.address.toLowerCase(), a.name]));
      const sent = await externalApi.send({
        to: t.ok.map((a) => a.address),
        cc: k.ok.map((a) => a.address),
        subject: subject.trim(),
        body,
        attachments,
        reply_to_id: params.reply ?? null,
        names: { ...names, ...typed },
      });
      success();
      router.replace(`/external/${sent.id}`);
    } catch (err) {
      Alert.alert('لم تُرسل الرسالة', errorText(err));
    } finally {
      setSending(false);
    }
  };

  const cancel = () => {
    if (!body.trim() && !files.length) return router.back();
    Alert.alert('تجاهل الرسالة؟', 'الرسائل الخارجية لا تُحفظ كمسودة.', [
      { text: 'متابعة الكتابة', style: 'cancel' },
      { text: 'تجاهل', style: 'destructive', onPress: () => router.back() },
    ]);
  };

  const blocked = mailbox && (!mailbox.sending_enabled || !mailbox.sending_configured);

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: '#fff' }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.bar, { paddingTop: Platform.OS === 'ios' ? 14 : insets.top + 10, flexDirection: row }]}>
        <Pressable hitSlop={10} onPress={cancel}>
          <Text style={styles.cancel}>إلغاء</Text>
        </Pressable>
        <Text style={styles.barTitle}>{params.reply ? 'رد خارجي' : 'رسالة خارجية'}</Text>
        <Pressable hitSlop={10} disabled={!canSend || !!blocked} onPress={send} style={[styles.sendBtn, (!canSend || blocked) && { opacity: 0.4 }]}>
          {sending ? <ActivityIndicator color="#fff" /> : <Ionicons name="send" size={18} color="#fff" style={{ transform: [{ scaleX: -1 }] }} />}
        </Pressable>
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
        <View style={[styles.notice, { flexDirection: row }]}>
          <Ionicons name="globe-outline" size={18} color="#8A5A00" />
          <T style={{ flex: 1, fontSize: font.tiny + 1, color: '#5C3D00' }}>
            {blocked
              ? 'الإرسال للخارج غير مفعّل لحسابك — اطلبه من مسؤول النظام.'
              : `ستخرج إلى خارج النظام عبر الإنترنت${mailbox?.address ? ` من ${mailbox.address}` : ''}.`}
          </T>
        </View>
        <View style={[styles.line, { flexDirection: row }]}>
          <Text style={styles.label}>إلى</Text>
          <TextInput
            value={to}
            onChangeText={setTo}
            onFocus={() => setField('to')}
            placeholder="name@example.com"
            placeholderTextColor={colors.textMuted}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, { textAlign: 'left', writingDirection: 'ltr' }]}
          />
          {!showCc && (
            <Pressable hitSlop={8} onPress={() => setShowCc(true)}>
              <Text style={styles.ccToggle}>نسخة</Text>
            </Pressable>
          )}
        </View>
        {showCc && (
          <View style={[styles.line, { flexDirection: row }]}>
            <Text style={styles.label}>نسخة</Text>
            <TextInput
              value={cc}
              onChangeText={setCc}
              onFocus={() => setField('cc')}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.input, { textAlign: 'left', writingDirection: 'ltr' }]}
            />
          </View>
        )}
        {suggestions.length > 0 && (
          <View style={styles.suggestions}>
            {suggestions.map((c) => (
              <Pressable key={c.address} onPress={() => choose(c)} style={({ pressed }) => [styles.suggestion, pressed && { backgroundColor: colors.navySoft }]}>
                {!!c.name && <T style={{ fontWeight: '600' }}>{c.name}</T>}
                <Text style={styles.suggestionAddr}>{c.address}</Text>
              </Pressable>
            ))}
          </View>
        )}
        <View style={[styles.line, { flexDirection: row }]}>
          <Text style={styles.label}>الموضوع</Text>
          <TextInput value={subject} onChangeText={setSubject} style={[styles.input, textRight]} maxLength={300} />
          <Pressable hitSlop={10} onPress={() => pickFile((f) => setFiles((prev) => [...prev, f]))} accessibilityLabel="إرفاق">
            <Ionicons name="attach" size={24} color={colors.navy} />
          </Pressable>
        </View>
        {files.length > 0 && (
          <View style={[styles.files, { flexDirection: row }]}>
            {files.map((f, i) => (
              <View key={`${f.uri}-${i}`} style={[styles.file, { flexDirection: row }]}>
                <Ionicons name="document-attach-outline" size={16} color={colors.navy} />
                <Text style={styles.fileName} numberOfLines={1}>
                  {f.name}
                </Text>
                <Pressable hitSlop={8} onPress={() => setFiles((prev) => prev.filter((_, j) => j !== i))}>
                  <Ionicons name="close-circle" size={18} color={colors.textMuted} />
                </Pressable>
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
          autoFocus={!!params.reply}
          style={[styles.body, textRight]}
          textAlignVertical="top"
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  bar: { alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  cancel: { fontSize: 17, color: colors.navy },
  barTitle: { fontSize: 17, fontWeight: '700', color: colors.text },
  sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.navy, alignItems: 'center', justifyContent: 'center' },
  notice: { alignItems: 'center', gap: 8, backgroundColor: '#FFF8E6', paddingHorizontal: 16, paddingVertical: 10 },
  line: { alignItems: 'center', gap: 8, paddingHorizontal: 16, minHeight: 50, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  label: { fontSize: font.body, color: colors.textMuted },
  input: { flex: 1, fontSize: font.body, color: colors.text, paddingVertical: 6 },
  ccToggle: { color: colors.navy, fontSize: font.small, fontWeight: '600' },
  suggestions: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: '#FAFAFD' },
  suggestion: { paddingHorizontal: 16, paddingVertical: 10 },
  suggestionAddr: { fontSize: font.small, color: colors.textSoft, textAlign: 'right' },
  files: { flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  file: { alignItems: 'center', gap: 6, backgroundColor: colors.navySoft, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 6, maxWidth: '100%' },
  fileName: { fontSize: font.small, color: colors.navy, maxWidth: 200 },
  body: { minHeight: 300, fontSize: 17, lineHeight: 26, color: colors.text, padding: 16 },
});
