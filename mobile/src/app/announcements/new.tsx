/**
 * تعميم جديد (لمن يحق له حسب دوره): الجمهور، العنوان والنص، الأولوية، وطلب
 * الإقرار بموعد. «مراجعة الجمهور» تعرض من سيصله قبل النشر.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PeoplePicker } from '@/components/PeoplePicker';
import { Button, Empty, Header, Loading, T, success, tap } from '@/components/ui';
import { errorText } from '@/lib/api';
import {
  announcementsApi,
  newId,
  type Announcement,
  type AudienceTarget,
  type PersonRef,
  type PublishTargets,
  type TargetType,
} from '@/lib/chat';
import { colors, font, radius, row, textRight } from '@/lib/theme';
import type { DirectoryUser } from '@/lib/types';

const TARGET_LABELS: Record<TargetType, string> = {
  all: 'جميع المعاهد',
  branches: 'كل فروعي',
  institute: 'معهد',
  branch: 'فرع',
  users: 'موظفون محددون',
};

const PRIORITIES: { v: Announcement['priority']; label: string }[] = [
  { v: 'normal', label: 'عادي' },
  { v: 'high', label: 'مهم' },
  { v: 'urgent', label: 'عاجل' },
];

const DUE: { days: number | null; label: string }[] = [
  { days: null, label: 'بلا موعد' },
  { days: 1, label: 'يوم' },
  { days: 3, label: '3 أيام' },
  { days: 7, label: 'أسبوع' },
];

export default function NewAnnouncementScreen() {
  const insets = useSafeAreaInsets();
  const [targets, setTargets] = useState<PublishTargets | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [type, setType] = useState<TargetType | null>(null);
  const [unitId, setUnitId] = useState('');
  const [branchIds, setBranchIds] = useState<string[] | null>(null);
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<Announcement['priority']>('normal');
  const [requiresAck, setRequiresAck] = useState(true);
  const [dueDays, setDueDays] = useState<number | null>(3);
  const [review, setReview] = useState<{ target: AudienceTarget; people: PersonRef[] } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    announcementsApi.targets().then(setTargets).catch((err) => setLoadError(errorText(err)));
  }, []);

  // ما يحق لي حسب دوري — الأوسع أولًا.
  const allowed = useMemo<TargetType[]>(() => {
    if (!targets) return [];
    const t: TargetType[] = [];
    if (targets.all) t.push('all');
    if (targets.branches.length > 1 && !targets.all) t.push('branches');
    if (targets.institutes.length) t.push('institute');
    if (targets.branches.length) t.push('branch');
    if (t.length) t.push('users');
    return t;
  }, [targets]);

  useEffect(() => {
    if (!allowed.length || type) return;
    setType(allowed[0]);
    if (allowed[0] === 'branch' && targets?.branches.length === 1) setUnitId(targets.branches[0].id);
  }, [allowed, type, targets]);

  if (loadError) {
    return (
      <View style={{ flex: 1 }}>
        <Header title="تعميم جديد" back large={false} />
        <Empty icon="alert-circle-outline" title="تعذر التحميل" hint={loadError} />
      </View>
    );
  }
  if (!targets) {
    return (
      <View style={{ flex: 1 }}>
        <Header title="تعميم جديد" back large={false} />
        <Loading />
      </View>
    );
  }
  if (!allowed.length) {
    return (
      <View style={{ flex: 1 }}>
        <Header title="تعميم جديد" back large={false} />
        <Empty icon="megaphone-outline" title="إصدار التعاميم للمديرين" hint="اطلب من مسؤول النظام الدور المناسب إن كان عملك يتطلب ذلك." />
      </View>
    );
  }

  const units = type === 'institute' ? targets.institutes : type === 'branch' ? targets.branches : [];
  const chosenBranches = branchIds ?? targets.branches.map((b) => b.id);

  const prepare = async () => {
    if (!title.trim()) return Alert.alert('العنوان مطلوب');
    if (!body.trim()) return Alert.alert('النص مطلوب');
    if (!type) return;
    if ((type === 'institute' || type === 'branch') && !unitId) return Alert.alert('اختر الوحدة');
    if (type === 'users' && !users.length) return Alert.alert('اختر موظفًا واحدًا على الأقل');
    if (type === 'branches' && !chosenBranches.length) return Alert.alert('اختر فرعًا واحدًا على الأقل');
    const target: AudienceTarget = {
      target_type: type,
      target_id: type === 'institute' || type === 'branch' ? unitId : null,
      user_ids: type === 'users' ? users.map((u) => String(u.id)) : [],
      branch_ids: type === 'branches' ? chosenBranches : [],
    };
    setBusy(true);
    try {
      const r = await announcementsApi.preview(target);
      setReview({ target, people: r.recipients });
    } catch (err) {
      Alert.alert('تعذر إعداد التعميم', errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!review) return;
    setBusy(true);
    try {
      const due = requiresAck && dueDays ? new Date(Date.now() + dueDays * 86400000).toISOString() : null;
      const a = await announcementsApi.publish({
        ...review.target,
        priority,
        requires_ack: requiresAck,
        ack_due_at: due,
        client_ref: newId(),
        title: title.trim(),
        body,
      });
      success();
      router.replace(`/announcements/report/${a.id}`);
    } catch (err) {
      Alert.alert('تعذر نشر التعميم', errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (review) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <Header title="مراجعة قبل النشر" back={false} large={false} />
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 150 }}>
          <View style={styles.card}>
            <T style={{ fontWeight: '800', fontSize: font.title }}>{title}</T>
            <T style={{ color: colors.textSoft }} numberOfLines={4}>
              {body}
            </T>
          </View>
          <View style={styles.card}>
            <T style={{ fontWeight: '700' }}>
              يصل إلى {review.people.length} موظف — {TARGET_LABELS[review.target.target_type]}
            </T>
            {review.people.slice(0, 60).map((p) => (
              <T key={p.id} style={{ fontSize: font.small, color: colors.textSoft }} numberOfLines={1}>
                {p.full_name}
                {p.branch || p.institute ? ` — ${p.branch || p.institute}` : ''}
              </T>
            ))}
            {review.people.length > 60 && <T style={styles.hint}>و{review.people.length - 60} آخرون…</T>}
          </View>
        </ScrollView>
        <View style={[styles.bar, { paddingBottom: insets.bottom + 10 }]}>
          <Button title={`نشر إلى ${review.people.length}`} icon="megaphone" loading={busy} disabled={!review.people.length} onPress={publish} />
          <Button title="تعديل" variant="plain" onPress={() => setReview(null)} />
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Header title="تعميم جديد" back large={false} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 140 }}>
        <View style={styles.card}>
          <T style={styles.label}>إلى</T>
          <View style={{ flexDirection: row, flexWrap: 'wrap', gap: 8 }}>
            {allowed.map((t) => (
              <Chip
                key={t}
                label={TARGET_LABELS[t]}
                active={type === t}
                onPress={() => {
                  setType(t);
                  setUnitId(t === 'branch' && targets.branches.length === 1 ? targets.branches[0].id : '');
                }}
              />
            ))}
          </View>
          {(type === 'institute' || type === 'branch') && (
            <View style={{ flexDirection: row, flexWrap: 'wrap', gap: 8 }}>
              {units.map((u) => (
                <Chip key={u.id} label={u.name} active={unitId === u.id} onPress={() => setUnitId(u.id)} />
              ))}
            </View>
          )}
          {type === 'branches' && (
            <View style={{ flexDirection: row, flexWrap: 'wrap', gap: 8 }}>
              {targets.branches.map((b) => {
                const on = chosenBranches.includes(b.id);
                return (
                  <Chip
                    key={b.id}
                    label={b.name}
                    active={on}
                    onPress={() => setBranchIds(on ? chosenBranches.filter((x) => x !== b.id) : [...chosenBranches, b.id])}
                  />
                );
              })}
            </View>
          )}
          {type === 'users' && <PeoplePicker value={users} onChange={setUsers} />}
        </View>

        <View style={styles.card}>
          <T style={styles.label}>العنوان</T>
          <TextInput value={title} onChangeText={setTitle} maxLength={300} style={[styles.input, textRight]} placeholder="عنوان التعميم" placeholderTextColor={colors.textMuted} />
          <T style={styles.label}>النص</T>
          <TextInput
            value={body}
            onChangeText={setBody}
            multiline
            textAlignVertical="top"
            style={[styles.input, styles.bodyInput, textRight]}
            placeholder="نص التعميم…"
            placeholderTextColor={colors.textMuted}
          />
        </View>

        <View style={styles.card}>
          <T style={styles.label}>الأولوية</T>
          <View style={{ flexDirection: row, gap: 8 }}>
            {PRIORITIES.map((p) => (
              <Chip key={p.v} label={p.label} active={priority === p.v} onPress={() => setPriority(p.v)} />
            ))}
          </View>
          <View style={{ flexDirection: row, alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
            <T style={{ fontWeight: '600' }}>يتطلب إقرارًا بالاطلاع</T>
            <Switch value={requiresAck} onValueChange={setRequiresAck} trackColor={{ true: colors.navy }} />
          </View>
          {requiresAck && (
            <>
              <T style={styles.hint}>الإقرار مطلوب خلال:</T>
              <View style={{ flexDirection: row, flexWrap: 'wrap', gap: 8 }}>
                {DUE.map((d) => (
                  <Chip key={d.label} label={d.label} active={dueDays === d.days} onPress={() => setDueDays(d.days)} />
                ))}
              </View>
            </>
          )}
        </View>
      </ScrollView>
      <View style={[styles.bar, { paddingBottom: insets.bottom + 10 }]}>
        <Button title="مراجعة الجمهور" icon="people-outline" loading={busy} onPress={prepare} />
      </View>
    </KeyboardAvoidingView>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={() => {
        tap();
        onPress();
      }}
      style={[styles.chip, active && styles.chipActive, { flexDirection: row }]}
    >
      {active && <Ionicons name="checkmark" size={14} color="#fff" />}
      <Text style={[styles.chipText, active && { color: '#fff' }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: radius.lg, padding: 14, gap: 10 },
  label: { fontSize: font.small, color: colors.textMuted, fontWeight: '600' },
  hint: { fontSize: font.tiny + 1, color: colors.textMuted },
  input: { backgroundColor: colors.bg, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: font.body, color: colors.text },
  bodyInput: { minHeight: 180 },
  chip: { alignItems: 'center', gap: 4, paddingHorizontal: 14, height: 34, borderRadius: 17, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border },
  chipActive: { backgroundColor: colors.navy, borderColor: colors.navy },
  chipText: { fontSize: font.small, fontWeight: '600', color: colors.textSoft },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 16, gap: 6, backgroundColor: 'rgba(255,255,255,0.97)', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
});
