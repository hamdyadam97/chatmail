import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Forward, Paperclip, Save, Send, Trash2 } from 'lucide-react';
import { Button, Card, Input, Label, Spinner } from '../../shared/ui';
import { toUserMessage } from '../../shared/api';
import { correspondenceApi, CLASSIFICATION_LABELS, PRIORITY_LABELS, type Classification, type Priority } from './api';
import { CryptoGate, E2EENote, RecipientPicker, formatDate, useDirectory } from './components';
import { formatBytes } from './content';
import { deleteDraft, getDraft, newDraftId, saveDraft } from './drafts';
import { openCorrespondence, sendCorrespondence, type ForwardSource } from './service';

const MAX_FILES = 20;
const MAX_FILE_BYTES = 25 * 1024 * 1024 - 64; // حد الخادم للـblob ناقص IV/tag

function ComposeForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const draftParam = params.get('draft');
  const forwardParam = params.get('forward');
  const { data: directory } = useDirectory();

  const draftId = useRef(draftParam ?? newDraftId());
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [priority, setPriority] = useState<Priority>('normal');
  const [classification, setClassification] = useState<Classification>('normal');
  const [dueDate, setDueDate] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [forwardOf, setForwardOf] = useState<ForwardSource | null>(null);
  const [loading, setLoading] = useState(Boolean(draftParam || forwardParam));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (draftParam) {
          const draft = await getDraft(draftParam);
          if (draft && !cancelled) {
            setTo(draft.to);
            setCc(draft.cc);
            setPriority(draft.priority);
            setClassification(draft.classification);
            setDueDate(draft.dueDate ?? '');
            setSubject(draft.subject);
            setBody(draft.body);
          }
        }
        if (forwardParam) {
          const detail = await correspondenceApi.get(forwardParam);
          const opened = await openCorrespondence(detail);
          if (opened.state !== 'ok') throw new Error(`لا يمكن إحالة مراسلة لم تُفك على هذا الجهاز: ${opened.reason}`);
          if (!cancelled) {
            setForwardOf({ detail, stored: opened.stored });
            setSubject(`إحالة: ${opened.stored.content.subject}`);
            setClassification(detail.classification);
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : toUserMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draftParam, forwardParam]);

  const nameOf = useMemo(() => {
    const map = new Map((directory ?? []).map((u) => [String(u.id), u.full_name ?? u.username ?? String(u.id)]));
    return (id: string) => map.get(id) ?? id;
  }, [directory]);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const incoming = [...list];
    const tooBig = incoming.find((f) => f.size > MAX_FILE_BYTES);
    if (tooBig) {
      setError(`الملف «${tooBig.name}» يتجاوز الحد المسموح (25 م.ب)`);
      return;
    }
    setFiles((prev) => [...prev, ...incoming].slice(0, MAX_FILES));
  };

  const onSaveDraft = async () => {
    await saveDraft({
      id: draftId.current,
      to,
      cc,
      priority,
      classification,
      dueDate: dueDate || null,
      subject,
      body,
    });
    setNotice('حُفظت المسودة على هذا الجهاز (مشفّرة محليًا، دون المرفقات).');
  };

  const onSend = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (to.length === 0) return setError('حدد مستلمًا واحدًا على الأقل في «إلى»');
    if (!subject.trim()) return setError('العنوان مطلوب');
    setSending(true);
    try {
      const sent = await sendCorrespondence(
        { to, cc, priority, classification, dueDate: dueDate || null, subject: subject.trim(), body, files },
        forwardOf ?? undefined,
      );
      if (draftParam) await deleteDraft(draftParam);
      await queryClient.invalidateQueries({ queryKey: ['correspondences'] });
      navigate(`/correspondence/${sent.id}`, { replace: true });
    } catch (err) {
      const unreachable = (err as { unreachableUserIds?: string[] }).unreachableUserIds;
      if (unreachable?.length) {
        setError(
          `لا يمكن الإرسال: ${unreachable.map(nameOf).join('، ')} لم يفعّل التشفير على أي جهاز بعد (عليه تسجيل الدخول مرة واحدة على الأقل).`,
        );
      } else {
        setError(err instanceof Error && !('status' in err) ? err.message : toUserMessage(err, 'تعذر إرسال المراسلة'));
      }
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <form onSubmit={onSend} className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
          {forwardOf && <Forward className="h-5 w-5 text-gray-500" />}
          {forwardOf ? 'إحالة مراسلة' : 'مراسلة جديدة'}
        </h2>
        <E2EENote />
      </div>

      <Card className="space-y-4 p-6">
        <RecipientPicker id="to" label="إلى" value={to} onChange={setTo} exclude={cc} />
        <RecipientPicker id="cc" label="نسخة إلى" value={cc} onChange={setCc} exclude={to} />

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <Label htmlFor="priority">الأولوية</Label>
            <select
              id="priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
              className="mt-1 h-10 w-full rounded-lg border border-gray-300 bg-white px-2 text-sm"
            >
              {(Object.keys(PRIORITY_LABELS) as Priority[]).map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="classification">التصنيف</Label>
            <select
              id="classification"
              value={classification}
              onChange={(e) => setClassification(e.target.value as Classification)}
              className="mt-1 h-10 w-full rounded-lg border border-gray-300 bg-white px-2 text-sm"
            >
              {(Object.keys(CLASSIFICATION_LABELS) as Classification[]).map((c) => (
                <option key={c} value={c}>
                  {CLASSIFICATION_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="due">تاريخ الاستحقاق (اختياري)</Label>
            <Input id="due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="mt-1" />
          </div>
        </div>
        {classification === 'institutional_archive_eligible' && (
          <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
            هذا التصنيف يعلن أن المعاملة تخضع لسياسة حفظ مؤسسية. في المرحلة الحالية هو علامة وصفية فقط: لا تُنشأ أي نسخة
            مؤسسية ولا يحصل أي طرف إضافي على مفتاح فك. أي نسخة مؤسسية مستقبلًا ستُشفّر لمستلم مؤسسي معلن قبل الإرسال.
          </p>
        )}

        <div>
          <Label htmlFor="subject">العنوان</Label>
          <Input id="subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={500} className="mt-1" autoComplete="off" />
        </div>
        <div>
          <Label htmlFor="body">نص المراسلة</Label>
          <textarea
            id="body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={12}
            maxLength={100_000}
            className="mt-1 w-full rounded-lg border border-gray-300 p-3 text-sm leading-7 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
          />
        </div>

        {forwardOf && (
          <div className="rounded-lg border-s-4 border-gray-300 bg-gray-50 p-4 text-sm text-gray-700">
            <p className="mb-2 text-xs text-gray-500">
              المراسلة المحالة <span dir="ltr">{forwardOf.detail.reference_number}</span> — من {forwardOf.detail.sender.full_name} —{' '}
              {formatDate(forwardOf.detail.sent_at)}
            </p>
            <p className="font-medium">{forwardOf.stored.content.subject}</p>
            <p className="mt-1 line-clamp-4 whitespace-pre-wrap">{forwardOf.stored.content.body}</p>
            {forwardOf.stored.content.attachments.length > 0 && (
              <p className="mt-2 text-xs text-gray-500">
                تُعاد مشاركة {forwardOf.stored.content.attachments.length} مرفق مع المستلمين الجدد.
              </p>
            )}
            <p className="mt-2 text-xs text-gray-500">
              المستلم الجديد يرى ما تحيله فقط في خيط جديد — لا يُضاف إلى خيط المراسلة الأصلية ولا يرى ردودها.
            </p>
          </div>
        )}

        <div>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-primary-700 hover:text-primary-800">
            <Paperclip className="h-4 w-4" />
            إرفاق ملفات
            <input type="file" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
          </label>
          {files.length > 0 && (
            <ul className="mt-2 space-y-1">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm">
                  <span className="truncate">
                    {f.name} <span className="text-xs text-gray-400">({formatBytes(f.size)})</span>
                  </span>
                  <button
                    type="button"
                    aria-label="إزالة المرفق"
                    onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                    className="text-gray-400 hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-xs text-gray-500">تُشفّر الملفات على جهازك بمفتاح عشوائي لكل ملف قبل رفعها.</p>
        </div>
      </Card>

      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {notice && <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</p>}

      <div className="flex items-center justify-end gap-2">
        {!forwardOf && (
          <Button type="button" variant="outline" onClick={() => void onSaveDraft()} disabled={sending}>
            <Save className="h-4 w-4" />
            حفظ كمسودة
          </Button>
        )}
        <Button type="submit" loading={sending}>
          <Send className="h-4 w-4" />
          {sending ? 'جارٍ التشفير والإرسال…' : 'إرسال مشفّر'}
        </Button>
      </div>
    </form>
  );
}

export function ComposePage() {
  const [params] = useSearchParams();
  return (
    <CryptoGate>
      <ComposeForm key={`${params.get('draft') ?? ''}:${params.get('forward') ?? ''}`} />
    </CryptoGate>
  );
}
