import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Paperclip, Save, Send, Trash2 } from 'lucide-react';
import { Button, Spinner } from '../../shared/ui';
import { toUserMessage } from '../../shared/api';
import { cn } from '../../shared/lib/cn';
import {
  correspondenceApi,
  CLASSIFICATION_LABELS,
  PRIORITY_LABELS,
  type AttachmentMeta,
  type Classification,
  type CorrespondenceDetail,
  type Priority,
} from './api';
import { ArchiveNotice, PrivacyNote, RecipientPicker, formatDate } from './components';
import { formatBytes } from './content';
import { saveDraft, sendCorrespondence, type ComposeInput } from './service';

const MAX_FILES = 20;
const MAX_FILE_BYTES = 25 * 1024 * 1024; // حد الخادم للملف

export function ComposeForm({ embedded = false, onCancel }: { embedded?: boolean; onCancel?: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const draftParam = params.get('draft');
  const forwardParam = params.get('forward');

  // المسودة على الخادم: أول حفظ ينشئها، وما بعده يحدّثها (من أي جهاز).
  const draftId = useRef<string | null>(draftParam);
  const clientRef = useRef(crypto.randomUUID());
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [priority, setPriority] = useState<Priority>('normal');
  const [classification, setClassification] = useState<Classification>('normal');
  const [dueDate, setDueDate] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [saved, setSaved] = useState<AttachmentMeta[]>([]);
  const [forwardOf, setForwardOf] = useState<CorrespondenceDetail | null>(null);
  const [loading, setLoading] = useState(Boolean(draftParam || forwardParam));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (draftParam) {
          const draft = await correspondenceApi.get(draftParam);
          if (!cancelled) {
            setTo(draft.participants.filter((p) => p.kind === 'to').map((p) => p.user.id));
            setCc(draft.participants.filter((p) => p.kind === 'cc').map((p) => p.user.id));
            setPriority(draft.priority);
            setClassification(draft.classification);
            setDueDate(draft.due_date ?? '');
            setSubject(draft.content?.subject ?? '');
            setBody(draft.content?.body ?? '');
            setSaved(draft.content?.attachments ?? []);
          }
        }
        if (forwardParam) {
          const detail = await correspondenceApi.get(forwardParam);
          if (!cancelled) {
            setForwardOf(detail);
            setSubject(`إحالة: ${detail.content?.subject ?? ''}`);
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

  const input = (): ComposeInput => ({
    to,
    cc,
    priority,
    classification,
    dueDate: dueDate || null,
    subject: subject.trim(),
    body,
    attachments: saved,
    files,
  });

  const onSaveDraft = async () => {
    setError(null);
    setSending(true);
    try {
      const draft = draftId.current
        ? await saveDraft(draftId.current, input())
        : await sendCorrespondence(input(), { send: false, clientRef: clientRef.current });
      draftId.current = draft.id;
      setSaved(draft.content?.attachments ?? []);
      setFiles([]);
      await queryClient.invalidateQueries({ queryKey: ['correspondences'] });
      setNotice('حُفظت المسودة — تجدها في «المسودات» من أي جهاز.');
    } catch (err) {
      setError(toUserMessage(err, 'تعذر حفظ المسودة'));
    } finally {
      setSending(false);
    }
  };

  const onSend = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (to.length === 0) return setError('حدد مستلمًا واحدًا على الأقل في «إلى»');
    if (!subject.trim()) return setError('العنوان مطلوب');
    setSending(true);
    try {
      const sent = draftId.current
        ? await saveDraft(draftId.current, input(), true)
        : await sendCorrespondence(input(), { forwardOfId: forwardOf?.id, clientRef: clientRef.current });
      await queryClient.invalidateQueries({ queryKey: ['correspondences'] });
      navigate(`/mail/sent/${sent.id}`, { replace: true });
    } catch (err) {
      setError(toUserMessage(err, 'تعذر إرسال المراسلة'));
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

  const optionSelect = 'h-7 rounded border border-gray-300 bg-white px-1.5 text-xs text-gray-700';

  return (
    <form onSubmit={onSend} className={cn('flex min-h-full flex-col bg-white', !embedded && 'mx-auto max-w-4xl rounded-xl border')}>
      {/* شريط أوامر المحرر — أسلوب Outlook */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-1 border-b border-gray-200 bg-white px-4 py-2">
        <Button type="submit" size="sm" loading={sending}>
          <Send className="h-4 w-4 -scale-x-100" />
          {sending ? 'جارٍ الإرسال…' : 'إرسال'}
        </Button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={sending} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100">
            <Trash2 className="h-4 w-4" />
            تجاهل
          </button>
        )}
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100">
          <Paperclip className="h-4 w-4" />
          إرفاق
          <input type="file" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
        </label>
        {!forwardOf && (
          <button type="button" onClick={() => void onSaveDraft()} disabled={sending} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100">
            <Save className="h-4 w-4" />
            حفظ كمسودة
          </button>
        )}
        <span className="ms-auto hidden xl:block">
          <PrivacyNote />
        </span>
      </div>

      <div className="divide-y divide-gray-200 border-b border-gray-200 px-4">
        <div className="py-1.5">
          <RecipientPicker id="to" label="إلى" value={to} onChange={setTo} exclude={cc} inline />
        </div>
        <div className="py-1.5">
          <RecipientPicker id="cc" label="نسخة" value={cc} onChange={setCc} exclude={to} inline />
        </div>
        <div className="py-1">
          <input
            id="subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={500}
            autoComplete="off"
            placeholder={forwardOf ? 'إحالة: …' : 'أضف عنوانًا'}
            aria-label="العنوان"
            className="h-9 w-full border-0 bg-transparent text-base outline-none placeholder:text-gray-400"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 py-2 text-xs text-gray-600">
          <label className="flex items-center gap-1.5" htmlFor="priority">
            الأولوية
            <select id="priority" value={priority} onChange={(e) => setPriority(e.target.value as Priority)} className={optionSelect}>
              {(Object.keys(PRIORITY_LABELS) as Priority[]).map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5" htmlFor="classification">
            التصنيف
            <select
              id="classification"
              value={classification}
              onChange={(e) => setClassification(e.target.value as Classification)}
              className={optionSelect}
            >
              {(Object.keys(CLASSIFICATION_LABELS) as Classification[]).map((c) => (
                <option key={c} value={c}>
                  {CLASSIFICATION_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5" htmlFor="due">
            الاستحقاق
            <input id="due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={optionSelect} />
          </label>
        </div>
      </div>

      {classification === 'institutional_archive_eligible' && (
        <div className="mx-4 mt-3">
          <ArchiveNotice />
        </div>
      )}

      {(saved.length > 0 || files.length > 0) && (
        <ul className="flex flex-wrap gap-2 px-4 pt-3">
          {saved.map((a) => (
            <li key={a.id} className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs">
              <Paperclip className="h-3.5 w-3.5 text-gray-400" />
              <span className="max-w-[12rem] truncate">{a.name}</span>
              <span className="text-gray-400">{formatBytes(a.size)}</span>
              <button
                type="button"
                aria-label="إزالة المرفق"
                onClick={() => setSaved((prev) => prev.filter((x) => x.id !== a.id))}
                className="text-gray-400 hover:text-red-600"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs">
              <Paperclip className="h-3.5 w-3.5 text-gray-400" />
              <span className="max-w-[12rem] truncate">{f.name}</span>
              <span className="text-gray-400">{formatBytes(f.size)}</span>
              <button
                type="button"
                aria-label="إزالة المرفق"
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                className="text-gray-400 hover:text-red-600"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {(error || notice) && (
        <div className="px-4 pt-3">
          {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
          {notice && <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</p>}
        </div>
      )}

      <textarea
        id="body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={100_000}
        placeholder="اكتب رسالتك هنا…"
        aria-label="نص المراسلة"
        className="min-h-[18rem] w-full flex-1 resize-none border-0 bg-transparent px-4 py-4 text-[15px] leading-7 outline-none placeholder:text-gray-400"
      />

      {forwardOf && (
        <div className="mx-4 mb-4 rounded-lg border-s-4 border-gray-300 bg-gray-50 p-4 text-sm text-gray-700">
          <p className="mb-2 text-xs text-gray-500">
            ---------- المراسلة المحالة <span dir="ltr">{forwardOf.reference_number}</span> — من {forwardOf.sender.full_name} —{' '}
            {formatDate(forwardOf.sent_at)}
          </p>
          <p className="font-medium">{forwardOf.content?.subject}</p>
          <p className="mt-1 whitespace-pre-wrap">{forwardOf.content?.body}</p>
          {(forwardOf.content?.attachments.length ?? 0) > 0 && (
            <p className="mt-2 text-xs text-gray-500">تُرسل {forwardOf.content?.attachments.length} مرفق مع الإحالة.</p>
          )}
          <p className="mt-2 text-xs text-gray-500">
            المستلم الجديد يرى ما تحيله فقط في خيط جديد — لا يُضاف إلى خيط المراسلة الأصلية ولا يرى ردودها.
          </p>
        </div>
      )}
    </form>
  );
}
