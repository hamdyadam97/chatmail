/**
 * صفحة الطلب: الملف، الخطوات، السجل، والقرار (اعتماد بتوقيع، رفض، إعادة، تأجيل).
 * المدير التنفيذي قبل وصول دوره: «اعتماد مباشر» أو «رفض» فقط.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '@/components/Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { StatusChip } from '@/components/approvals';
import { SignaturePad } from '@/components/SignaturePad';
import { Avatar, Button, Empty, ErrorBox, Field, Header, Loading, T, success, tap } from '@/components/ui';
import { errorText } from '@/lib/api';
import {
  approvalsApi,
  EVENT_LABELS,
  requestTitle,
  resubmitRequest,
  STEP_LABELS,
  type ApprovalRequest,
  type Decision,
  type FileMeta,
} from '@/lib/approvals';
import { useAuth } from '@/lib/auth';
import { openAttachment } from '@/lib/files';
import { fullDate, shortDate } from '@/lib/format';
import { colors, font, radius, row, textRight } from '@/lib/theme';
import { pickFile, type LocalFile } from '@/lib/upload';

type Action = Decision | 'deferred';

const ACTION_TITLES: Record<Action, string> = {
  approved: 'اعتماد الطلب',
  rejected: 'رفض الطلب',
  returned: 'إعادة للمراجعة',
  deferred: 'تأجيل',
};

export default function ApprovalScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const [req, setReq] = useState<ApprovalRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);

  const load = useCallback(async () => {
    try {
      setReq(await approvalsApi.get(id));
    } catch (err) {
      setError(errorText(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error || !req) {
    return (
      <View style={{ flex: 1 }}>
        <Header title="" back />
        {error ? <Empty icon="alert-circle-outline" title="تعذر فتح الطلب" hint={error} /> : <Loading />}
      </View>
    );
  }

  const early = !req.my_slot && req.my_early_step != null;
  const canDecide = !!req.my_slot || early;
  const mine = req.requested_by.id === user?.id;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="" back />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: canDecide ? 140 : 40 }}>
        <View style={{ gap: 6 }}>
          {!!req.workflow_name && <T style={{ color: colors.gold, fontWeight: '700' }}>{req.workflow_name}</T>}
          <T style={styles.title}>{requestTitle(req)}</T>
          <View style={{ flexDirection: row, gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <StatusChip status={req.status} />
            <Text style={styles.meta}>
              {req.requested_by.full_name} — {shortDate(req.created_at)}
            </Text>
          </View>
        </View>

        {early && (
          <View style={[styles.notice, { flexDirection: row }]}>
            <Ionicons name="hourglass-outline" size={22} color="#8A5A00" />
            <T style={{ flex: 1, fontSize: font.small, lineHeight: 22, color: '#5C3D00' }}>
              الطلب بانتظار موافقة المدير المباشر. يمكنك الانتظار، أو اعتماده أو رفضه مباشرة الآن — تُتخطى الخطوات السابقة ويُبلَّغ أصحابها.
            </T>
          </View>
        )}
        {early && (
          <Button
            title="تذكير بالتوقيع"
            icon="notifications-outline"
            variant="secondary"
            onPress={() =>
              approvalsApi
                .remind(req.id)
                .then((r) => {
                  setReq(r);
                  success();
                  Alert.alert('أُرسل التذكير', `وصل إشعار إلى ${r.reminded} ممن لم يوقّع بعد.`);
                })
                .catch((err) => Alert.alert('تعذر إرسال التذكير', errorText(err)))
            }
          />
        )}
        {early && !!req.reminded_at && <T style={styles.meta}>آخر تذكير {fullDate(req.reminded_at)} — مرة كل ساعة</T>}

        {req.can_withdraw && (
          <Button
            title="سحب اعتمادي"
            icon="arrow-undo-outline"
            variant="secondary"
            onPress={() =>
              Alert.alert(
                'سحب اعتمادك؟',
                req.signable
                  ? 'يُزال توقيعك ويعود الطلب لأوله على الملف الأصلي لتعتمده من جديد (مثلًا بعد تغيير توقيعك).'
                  : 'يعود الطلب لأوله لتعتمده من جديد.',
                [
                  { text: 'تراجع', style: 'cancel' },
                  {
                    text: 'سحب',
                    style: 'destructive',
                    onPress: () =>
                      approvalsApi
                        .withdraw(req.id)
                        .then((r) => {
                          setReq(r);
                          success();
                        })
                        .catch((err) => Alert.alert('تعذر سحب الاعتماد', errorText(err))),
                  },
                ],
              )
            }
          />
        )}

        {(req.deliver_to?.length ?? 0) > 0 && (
          <Pressable
            disabled={!req.delivered_correspondence}
            onPress={() => req.delivered_correspondence && router.push(`/mail/${req.delivered_correspondence.id}`)}
            style={[styles.notice, { flexDirection: row, backgroundColor: '#E8F4FB' }]}
          >
            <Ionicons name={req.delivered_correspondence ? 'paper-plane' : 'paper-plane-outline'} size={20} color="#0B5E86" />
            <T style={{ flex: 1, fontSize: font.small, lineHeight: 22, color: '#0B4A6B' }}>
              {req.delivered_correspondence ? 'أُرسل الخطاب المعتمد إلى: ' : 'بعد الاعتماد يُرسل إلى: '}
              {req.deliver_to!.map((u) => u.full_name).join('، ')}
              {req.deliver_cc?.length ? ` — نسخة: ${req.deliver_cc.map((u) => u.full_name).join('، ')}` : ''}
            </T>
          </Pressable>
        )}

        {req.can_resubmit && <ResubmitPanel request={req} onDone={(r) => setReq(r)} />}

        {(req.source_file || req.signed_file) && (
          <View style={styles.card}>
            {req.signed_file && <FileRow file={req.signed_file} label={`النسخة الموقّعة (${req.signature_count} توقيع)`} primary />}
            {req.source_file && <FileRow file={req.source_file} label="الملف الأصلي" />}
          </View>
        )}

        <View style={styles.card}>
          <T style={styles.section}>خطوات الاعتماد</T>
          {req.steps.map((s) => (
            <View key={s.step_order} style={[styles.step, s.status === 'active' && { borderColor: '#F0C36D', backgroundColor: '#FFFBF1' }]}>
              <View style={{ flexDirection: row, justifyContent: 'space-between' }}>
                <T style={{ fontWeight: '700', fontSize: font.small }}>الخطوة {s.step_order}</T>
                <Text style={styles.meta}>{STEP_LABELS[s.status]}</Text>
              </View>
              {s.approvers.map((a) => (
                <View key={a.user.id} style={{ flexDirection: row, alignItems: 'center', gap: 8, marginTop: 8 }}>
                  <Avatar name={a.user.full_name} size={30} />
                  <T style={{ flex: 1, fontSize: font.small }} numberOfLines={1}>
                    {a.user.full_name}
                  </T>
                  {a.decision ? (
                    <DecisionMark decision={a.decision.decision} />
                  ) : a.deferred_at && req.status === 'pending' ? (
                    <Text style={[styles.meta, { color: '#0B6E99' }]}>مؤجَّل</Text>
                  ) : null}
                </View>
              ))}
            </View>
          ))}
        </View>

        {req.events.length > 0 && (
          <View style={styles.card}>
            <T style={styles.section}>سجل الطلب</T>
            {req.events.map((e, i) => (
              <View key={i} style={{ gap: 2, paddingVertical: 6 }}>
                <T style={{ fontSize: font.small }}>
                  <Text style={{ fontWeight: '700' }}>{e.actor.full_name}</Text> {EVENT_LABELS[e.kind] ?? e.kind}
                </T>
                {!!e.note && <T style={styles.note}>«{e.note}»</T>}
                <T style={styles.meta}>{fullDate(e.created_at)}</T>
              </View>
            ))}
          </View>
        )}

        {mine && req.status === 'pending' && (
          <Button
            title="إلغاء الطلب"
            variant="secondary"
            onPress={() =>
              Alert.alert('إلغاء الطلب؟', 'لن يستطيع أحد اعتماده بعد الإلغاء.', [
                { text: 'تراجع', style: 'cancel' },
                {
                  text: 'إلغاء الطلب',
                  style: 'destructive',
                  onPress: () => approvalsApi.cancel(req.id).then(setReq).catch((err) => Alert.alert('تعذر الإلغاء', errorText(err))),
                },
              ])
            }
          />
        )}
      </ScrollView>

      {canDecide && (
        <View style={[styles.bar, { paddingBottom: insets.bottom + 10 }]}>
          <View style={{ flexDirection: row, gap: 10 }}>
            <Button title={early ? 'اعتماد مباشر' : 'اعتماد'} icon="checkmark" style={{ flex: 1 }} onPress={() => setAction('approved')} />
            <Button title="رفض" variant="danger" style={{ flex: 1 }} onPress={() => setAction('rejected')} />
          </View>
          {!early && (
            <View style={{ flexDirection: row, gap: 10 }}>
              <Button title="إعادة للمراجعة" variant="secondary" style={{ flex: 1 }} onPress={() => setAction('returned')} />
              <Button title="تأجيل" variant="secondary" icon="time-outline" style={{ flex: 1 }} onPress={() => setAction('deferred')} />
            </View>
          )}
        </View>
      )}

      <DecisionSheet
        request={req}
        action={action}
        early={early}
        onClose={() => setAction(null)}
        onDone={(updated) => {
          setAction(null);
          setReq(updated);
          success();
        }}
      />
    </View>
  );
}

/** «أُعيد إليك الطلب»: ملاحظة لمن أعاده، وملف جديد اختياريًا (للطلبات بتوقيع — يوقّع الجميع من جديد). */
function ResubmitPanel({ request, onDone }: { request: ApprovalRequest; onDone: (r: ApprovalRequest) => void }) {
  const [note, setNote] = useState('');
  const [file, setFile] = useState<LocalFile | null>(null);
  const [busy, setBusy] = useState(false);
  const returned = [...request.events].reverse().find((e) => e.kind === 'returned');
  const submit = async () => {
    setBusy(true);
    try {
      const r = await resubmitRequest(request.id, note.trim(), file);
      success();
      setNote('');
      setFile(null);
      onDone(r);
    } catch (err) {
      Alert.alert('تعذرت إعادة الإرسال', errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={[styles.card, { borderWidth: 1, borderColor: '#F0C36D' }]}>
      <View style={{ flexDirection: row, alignItems: 'center', gap: 8 }}>
        <Ionicons name="arrow-undo-circle" size={24} color="#A34A00" />
        <T style={[styles.section, { flex: 1 }]}>أُعيد إليك الطلب</T>
      </View>
      {returned && (
        <T style={{ fontSize: font.small, color: colors.textSoft }}>
          أعاده {returned.actor.full_name}
          {returned.note ? `: «${returned.note}»` : ''}
        </T>
      )}
      <TextInput
        value={note}
        onChangeText={setNote}
        placeholder="ملاحظة لمن أعاده (ماذا عدّلت)…"
        placeholderTextColor={colors.textMuted}
        multiline
        maxLength={1000}
        style={[styles.noteInput, textRight]}
      />
      {request.signable && (
        <Pressable
          onPress={() => {
            tap();
            pickFile((f) => setFile(f));
          }}
          style={({ pressed }) => [styles.file, { flexDirection: row }, pressed && { backgroundColor: colors.navySoft }]}
        >
          <Ionicons name={file ? 'document-text' : 'cloud-upload-outline'} size={22} color={colors.navy} />
          <View style={{ flex: 1 }}>
            <T style={{ fontWeight: '700', fontSize: font.small }}>{file ? file.name : 'ملف جديد (اختياري)'}</T>
            <T style={styles.meta}>
              {file ? 'يبدأ التوقيع من الأول على الملف الجديد' : 'بدونه يعود الطلب لمن أعاده وتبقى التوقيعات السابقة'}
            </T>
          </View>
          {file && (
            <Pressable hitSlop={8} onPress={() => setFile(null)}>
              <Ionicons name="close-circle" size={20} color={colors.textMuted} />
            </Pressable>
          )}
        </Pressable>
      )}
      <Button title="إعادة الإرسال" icon="send" loading={busy} onPress={submit} />
    </View>
  );
}

function DecisionMark({ decision }: { decision: Decision }) {
  const map = {
    approved: { icon: 'checkmark-circle', color: colors.success, text: 'اعتمد' },
    rejected: { icon: 'close-circle', color: colors.danger, text: 'رفض' },
    returned: { icon: 'arrow-undo-circle', color: '#A34A00', text: 'أعاد' },
  } as const;
  const m = map[decision];
  return (
    <View style={{ flexDirection: row, alignItems: 'center', gap: 4 }}>
      <Ionicons name={m.icon} size={18} color={m.color} />
      <Text style={{ color: m.color, fontSize: font.tiny, fontWeight: '700' }}>{m.text}</Text>
    </View>
  );
}

function FileRow({ file, label, primary }: { file: FileMeta; label: string; primary?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <Pressable
      onPress={() => {
        tap();
        setBusy(true);
        openAttachment(file)
          .catch((err) => Alert.alert('تعذر فتح الملف', errorText(err)))
          .finally(() => setBusy(false));
      }}
      style={({ pressed }) => [styles.file, { flexDirection: row }, primary && { borderColor: colors.navy }, pressed && { backgroundColor: colors.navySoft }]}
    >
      {busy ? <ActivityIndicator color={colors.navy} /> : <Ionicons name="document-text-outline" size={24} color={colors.navy} />}
      <View style={{ flex: 1 }}>
        <T style={{ fontWeight: '700', fontSize: font.small }}>{label}</T>
        <T style={styles.meta} numberOfLines={1}>
          {file.name}
        </T>
      </View>
      <Ionicons name="open-outline" size={18} color={colors.textMuted} />
    </Pressable>
  );
}

function DecisionSheet({
  request,
  action,
  early,
  onClose,
  onDone,
}: {
  request: ApprovalRequest;
  action: Action | null;
  early: boolean;
  onClose: () => void;
  onDone: (r: ApprovalRequest) => void;
}) {
  const insets = useSafeAreaInsets();
  const [note, setNote] = useState('');
  const [password, setPassword] = useState('');
  const [page, setPage] = useState(1);
  const [hasSignature, setHasSignature] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signing = action === 'approved' && request.signable;
  const pages = request.page_count ?? 1;

  useEffect(() => {
    if (!action) return;
    setNote('');
    setPassword('');
    setError(null);
    setPage(pages);
    if (signing) approvalsApi.signature().then((s) => setHasSignature(s.has_signature)).catch(() => setHasSignature(null));
  }, [action, signing, pages]);

  if (!action) return null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const updated =
        action === 'deferred'
          ? await approvalsApi.defer(request.id, note)
          : await approvalsApi.decide(request.id, {
              decision: action,
              note,
              ...(signing ? { password, page } : {}),
            });
      onDone(updated);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const noteLabel =
    action === 'returned'
      ? 'ما المطلوب تعديله؟ (يظهر لمقدّم الطلب)'
      : action === 'rejected'
        ? 'سبب الرفض (اختياري)'
        : action === 'deferred'
          ? 'سبب التأجيل أو موعد البتّ (اختياري)'
          : 'ملاحظة (اختياري)';

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdrop}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.grabber} />
          <T style={styles.sheetTitle}>{early && action !== 'deferred' ? `${ACTION_TITLES[action]} مباشرة` : ACTION_TITLES[action]}</T>
          {early && <T style={styles.meta}>دون انتظار المدير المباشر — تُتخطى خطوته.</T>}

          {signing && hasSignature === false && (
            <>
              <T style={styles.label}>ارسم توقيعك مرة واحدة — يُحفظ لحسابك ويُختم على الطلبات التي تعتمدها</T>
              <SignaturePad onSaved={() => setHasSignature(true)} />
            </>
          )}
          {signing && hasSignature !== false && (
            <>
              <T style={styles.label}>الصفحة التي يُختم عليها توقيعك</T>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, flexDirection: row }}>
                {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
                  <Pressable key={n} onPress={() => setPage(n)} style={[styles.page, page === n && styles.pageActive]}>
                    <Text style={[styles.pageText, page === n && { color: '#fff' }]}>{n}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              <Field icon="lock-closed-outline" placeholder="كلمة المرور للتأكيد" secure value={password} onChangeText={setPassword} />
            </>
          )}

          <T style={styles.label}>{noteLabel}</T>
          <TextInput
            value={note}
            onChangeText={setNote}
            multiline
            maxLength={1000}
            style={[styles.noteInput, textRight]}
            placeholderTextColor={colors.textMuted}
            textAlignVertical="top"
          />
          <ErrorBox message={error} />
          <Button
            title={signing ? 'توقيع واعتماد' : action === 'deferred' ? 'تأجيل' : 'تأكيد'}
            variant={action === 'rejected' ? 'danger' : 'primary'}
            loading={busy}
            disabled={(signing && (!password || hasSignature === false)) || (action === 'returned' && !note.trim())}
            onPress={submit}
          />
          <Button title="تراجع" variant="plain" onPress={onClose} />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 24, fontWeight: '800', lineHeight: 32 },
  meta: { fontSize: font.tiny, color: colors.textMuted },
  notice: { gap: 10, alignItems: 'center', backgroundColor: '#FFF4DC', padding: 14, borderRadius: radius.md },
  card: { backgroundColor: '#fff', borderRadius: radius.lg, padding: 14, gap: 10 },
  section: { fontWeight: '800', fontSize: font.body },
  step: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12 },
  note: { fontSize: font.small, color: colors.textSoft, fontStyle: 'italic' },
  file: { alignItems: 'center', gap: 12, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingTop: 10,
    gap: 10,
    backgroundColor: 'rgba(255,255,255,0.97)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, gap: 12 },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: colors.border, marginBottom: 4 },
  sheetTitle: { fontSize: 20, fontWeight: '800' },
  label: { fontSize: font.small, color: colors.textSoft, fontWeight: '600' },
  page: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  pageActive: { backgroundColor: colors.navy, borderColor: colors.navy },
  pageText: { fontSize: 16, fontWeight: '700', color: colors.text },
  noteInput: {
    minHeight: 80,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 12,
    fontSize: font.body,
    color: colors.text,
  },
});
