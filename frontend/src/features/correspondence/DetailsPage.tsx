import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  CheckCheck,
  Download,
  Forward,
  History,
  Lock,
  Paperclip,
  Reply,
  ShieldAlert,
  Star,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { Avatar, Button, Card, Label, Spinner } from '../../shared/ui';
import { cn } from '../../shared/lib/cn';
import { toUserMessage } from '../../shared/api';
import { useAuth } from '../auth/AuthContext';
import { ApprovalPanel } from '../approvals/components';
import {
  correspondenceApi,
  PRIORITY_LABELS,
  type CorrespondenceDetail,
  type Participant,
  type Priority,
} from './api';
import { ClassificationBadge, CryptoGate, E2EENote, PriorityBadge, formatDate, formatDay } from './components';
import { decryptAttachment, formatBytes, saveDecryptedFile, type AttachmentKey } from './content';
import {
  openCorrespondence,
  openThreadItems,
  replyToCorrespondence,
  type OpenResult,
  type StoredContent,
} from './service';

const EVENT_LABELS: Record<string, string> = {
  created: 'أُنشئت',
  sent: 'أُرسلت',
  read: 'قُرئت',
  replied: 'رُدّ عليها',
  forwarded: 'أُحيلت',
  closed: 'أُغلقت',
};

function ParticipantsLine({ label, people, showReceipts }: { label: string; people: Participant[]; showReceipts: boolean }) {
  if (people.length === 0) return null;
  return (
    <p className="text-sm text-gray-600">
      <span className="text-gray-500">{label}: </span>
      {people.map((p, i) => (
        <span key={p.user.id}>
          {i > 0 && '، '}
          {p.user.full_name}
          {showReceipts &&
            (p.read_at ? (
              <CheckCheck className="ms-1 inline h-3.5 w-3.5 text-emerald-600" aria-label={`قُرئت ${formatDate(p.read_at)}`} />
            ) : null)}
        </span>
      ))}
    </p>
  );
}

function AttachmentRow({ meta }: { meta: AttachmentKey }) {
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const download = async () => {
    setState('busy');
    setError(null);
    try {
      const blob = await correspondenceApi.downloadBlob(meta.id);
      const plain = await decryptAttachment(blob, meta);
      saveDecryptedFile(plain, meta.name);
      setState('idle');
    } catch (err) {
      setState('error');
      setError(err instanceof Error && !('status' in err) ? err.message : toUserMessage(err, 'تعذر تنزيل المرفق'));
    }
  };
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2 text-sm">
      <span className="flex min-w-0 items-center gap-2">
        <Paperclip className="h-4 w-4 shrink-0 text-gray-400" />
        <span className="truncate">{meta.name}</span>
        <span className="shrink-0 text-xs text-gray-400">{formatBytes(meta.size)}</span>
      </span>
      <span className="flex items-center gap-2">
        {error && <span className="text-xs text-red-600">{error}</span>}
        <Button type="button" size="sm" variant="outline" loading={state === 'busy'} onClick={() => void download()}>
          <Download className="h-4 w-4" />
          فك وتنزيل
        </Button>
      </span>
    </li>
  );
}

function ContentView({ opened }: { opened: OpenResult | null }) {
  if (!opened) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-gray-500">
        <Spinner size="sm" />
        جارٍ فك التشفير على جهازك…
      </div>
    );
  }
  if (opened.state === 'unavailable') {
    return (
      <div className="flex items-start gap-2 rounded-lg bg-gray-50 p-4 text-sm text-gray-600">
        <Lock className="mt-0.5 h-4 w-4 shrink-0" />
        {opened.reason}
      </div>
    );
  }
  const { content, senderVerified, bound } = opened.stored;
  return (
    <div className="space-y-4">
      {(!senderVerified || !bound) && (
        <div className="flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          {!senderVerified
            ? 'تعذر التحقق من أن هذا المحتوى صادر فعلًا من المرسل المعروض (هوية MLS لا تطابق). لا تعتمد عليه.'
            : 'هذا المحتوى ليس مربوطًا بهذه المراسلة — قد يكون مُبدَّلًا. لا تعتمد عليه.'}
        </div>
      )}
      {/* نص صريح فقط — لا HTML ولا dangerouslySetInnerHTML (حماية XSS، §21) */}
      <div className="whitespace-pre-wrap break-words text-sm leading-7 text-gray-800">{content.body || '—'}</div>
      {content.forwarded && (
        <div className="rounded-lg border-s-4 border-gray-300 bg-gray-50 p-4 text-sm">
          <p className="mb-2 text-xs text-gray-500">
            مراسلة محالة <span dir="ltr">{content.forwarded.reference_number}</span> — من {content.forwarded.sender_name} —{' '}
            {formatDate(content.forwarded.sent_at)}
          </p>
          <p className="font-medium text-gray-800">{content.forwarded.subject}</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-gray-700">{content.forwarded.body}</p>
        </div>
      )}
      {content.attachments.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-medium text-gray-700">المرفقات ({content.attachments.length})</h4>
          <ul className="space-y-2">
            {content.attachments.map((a) => (
              <AttachmentRow key={a.id} meta={a} />
            ))}
          </ul>
          <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            الخادم لا يستطيع فحص المرفقات المشفّرة بحثًا عن برمجيات ضارة. افحص الملف بمضاد الفيروسات على جهازك قبل فتحه، ولا
            تفتح ملفات تنفيذية من مصادر غير متوقعة.
          </p>
        </div>
      )}
    </div>
  );
}

function ReplyBox({
  detail,
  onSent,
  onCancel,
}: {
  detail: CorrespondenceDetail;
  onSent: (id: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [files, setFiles] = useState<File[]>([]);
  const [subjectBase, setSubjectBase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () =>
      replyToCorrespondence(detail, {
        subject: subjectBase.startsWith('رد:') ? subjectBase : `رد: ${subjectBase}`,
        body,
        priority,
        dueDate: null,
        files,
      }),
    onSuccess: (sent) => onSent(sent.id),
    onError: (err) => setError(err instanceof Error && !('status' in err) ? err.message : toUserMessage(err, 'تعذر إرسال الرد')),
  });
  useEffect(() => {
    openCorrespondence(detail)
      .then((r) => setSubjectBase(r.state === 'ok' ? r.stored.content.subject : `المراسلة ${detail.reference_number}`))
      .catch(() => setSubjectBase(`المراسلة ${detail.reference_number}`));
  }, [detail]);
  const recipients = detail.participants.filter((p) => p.kind !== 'bcc').length;
  return (
    <Card id="reply-box" className="space-y-3 p-5">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
          <Reply className="h-4 w-4" />
          رد على الجميع
        </h3>
        <span className="flex items-center gap-3 text-xs text-gray-500">
          يصل الرد إلى أطراف الخيط ({recipients}) فقط
          <button type="button" onClick={onCancel} className="rounded p-1 text-gray-500 hover:bg-gray-100" aria-label="إلغاء الرد">
            <X className="h-4 w-4" />
          </button>
        </span>
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={5}
        maxLength={100_000}
        autoFocus
        aria-label="نص الرد"
        className="w-full rounded-lg border border-gray-300 p-3 text-sm leading-7 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Label htmlFor="reply-priority" className="mb-0">
            الأولوية
          </Label>
          <select
            id="reply-priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority)}
            className="h-9 rounded-lg border border-gray-300 bg-white px-2 text-sm"
          >
            {(Object.keys(PRIORITY_LABELS) as Priority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-primary-700">
            <Paperclip className="h-4 w-4" />
            {files.length > 0 ? `${files.length} مرفق` : 'إرفاق'}
            <input type="file" multiple className="hidden" onChange={(e) => setFiles(e.target.files ? [...e.target.files] : [])} />
          </label>
        </div>
        <Button onClick={() => mutation.mutate()} loading={mutation.isPending} disabled={!body.trim()}>
          إرسال الرد مشفّرًا
        </Button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </Card>
  );
}

/** «رد: رد: الموضوع» ← «الموضوع» — عنوان المحادثة كما في Outlook. */
function conversationSubject(subject: string): string {
  return subject.replace(/^(\s*(رد|RE|Re|إحالة|FW|Fw)\s*:\s*)+/, '').trim() || subject;
}

/**
 * عرض المحادثة بأسلوب Outlook: كل رسائل الخيط تحت بعضها (الأحدث أولًا)، المفتوحة
 * تلقائيًا: الأحدث والمختارة وغير المقروءة؛ والباقي سطر مختصر يتوسع بنقرة.
 */
function Conversation({
  detail,
  names,
  isSender,
  onSubject,
}: {
  detail: CorrespondenceDetail;
  names: Map<string, string>;
  isSender: boolean;
  onSubject: (subject: string) => void;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [contents, setContents] = useState<Map<string, StoredContent | undefined> | null>(null);
  const items = useMemo(() => [...detail.thread_items].reverse(), [detail.thread_items]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    openThreadItems(detail)
      .then((m) => !cancelled && setContents(m))
      .catch(() => !cancelled && setContents(new Map()));
    return () => {
      cancelled = true;
    };
  }, [detail]);

  // إعادة الضبط عند تغيّر المحادثة أو وصول رد جديد فقط (لا عند كل إعادة جلب).
  const itemsKey = items.map((it) => it.id).join(',');
  useEffect(() => {
    const open = new Set<string>([detail.id]);
    if (items[0]) open.add(items[0].id);
    for (const it of items) if (it.unread) open.add(it.id);
    setExpanded(open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id, itemsKey]);

  // عنوان المحادثة من أقدم رسالة مفكوكة.
  useEffect(() => {
    if (!contents) return;
    const oldest = detail.thread_items.map((it) => contents.get(it.id)).find(Boolean);
    if (oldest) onSubject(conversationSubject(oldest.content.subject));
  }, [contents, detail.thread_items, onSubject]);

  // المعروض مفتوحًا يُعلَّم مقروءًا (الخادم يتجاهل المقروء ورسائلي أنا).
  useEffect(() => {
    const toMark = items.filter((it) => it.unread && expanded.has(it.id) && it.id !== detail.id && it.sender_id !== String(user?.id));
    if (toMark.length === 0) return;
    void Promise.all(toMark.map((it) => correspondenceApi.markRead(it.id).catch(() => undefined))).then(() => {
      void queryClient.invalidateQueries({ queryKey: ['correspondences'] });
      void queryClient.invalidateQueries({ queryKey: ['correspondence-counts'] });
    });
  }, [items, expanded, detail.id, user?.id, queryClient]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const to = detail.participants.filter((p) => p.kind === 'to');
  const cc = detail.participants.filter((p) => p.kind === 'cc');

  return (
    <div className="space-y-3" aria-label="رسائل المحادثة">
      {items.length > 2 && (
        <div className="flex justify-end gap-3 text-xs">
          <button type="button" className="text-primary-700 hover:underline" onClick={() => setExpanded(new Set(items.map((i) => i.id)))}>
            توسيع الكل
          </button>
          <button type="button" className="text-primary-700 hover:underline" onClick={() => setExpanded(new Set([items[0].id]))}>
            طيّ الكل
          </button>
        </div>
      )}
      {items.map((item) => {
        const stored = contents?.get(item.id);
        const isOpen = expanded.has(item.id);
        const sender = names.get(item.sender_id) ?? 'مشارك';
        const current = item.id === detail.id;
        return (
          <article
            key={item.id}
            className={cn(
              'rounded-lg border bg-white shadow-sm',
              current ? 'border-primary-200' : 'border-gray-200',
              item.unread && 'border-s-4 border-s-primary-600',
            )}
          >
            <button
              type="button"
              onClick={() => toggle(item.id)}
              aria-expanded={isOpen}
              className="flex w-full items-start gap-3 px-5 py-3 text-start"
            >
              <Avatar name={sender} size={isOpen ? 'lg' : 'md'} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className={cn('text-gray-900', item.unread ? 'font-bold' : 'font-semibold')}>{sender}</span>
                  <span className="flex items-center gap-2 text-xs text-gray-500">
                    <span dir="ltr" className="font-mono">
                      {item.reference_number}
                    </span>
                    {formatDate(item.sent_at)}
                  </span>
                </div>
                {!isOpen && (
                  <p className="truncate text-sm text-gray-500">
                    {contents === null
                      ? '…'
                      : stored
                        ? stored.content.body.replace(/\s+/g, ' ').slice(0, 160) || stored.content.subject
                        : '🔒 غير متاحة على هذا الجهاز'}
                  </p>
                )}
                {isOpen && current && (
                  <>
                    <ParticipantsLine label="إلى" people={to} showReceipts={isSender} />
                    <ParticipantsLine label="نسخة" people={cc} showReceipts={isSender} />
                    {detail.due_date && <p className="text-xs text-gray-500">الاستحقاق {formatDay(detail.due_date)}</p>}
                  </>
                )}
              </div>
            </button>
            {isOpen && (
              <div className="border-t border-gray-100 px-5 pb-5 pt-4">
                <ContentView
                  opened={
                    contents === null
                      ? null
                      : stored
                        ? { state: 'ok', stored }
                        : { state: 'unavailable', reason: 'هذه الرسالة غير متاحة على هذا الجهاز (أُرسلت قبل انضمامه أو تعذر فكها).' }
                  }
                />
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

export function Details({ id, embedded = false }: { id: string; embedded?: boolean }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  // المجلد الحالي في البريد (/mail/:folder/:id) — الإحالة تُكتب في لوحة القراءة نفسها.
  const { folder: folderSlug } = useParams<{ folder?: string }>();
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState<OpenResult | null>(null);
  const [showEvents, setShowEvents] = useState(false);
  const [replying, setReplying] = useState(false);
  const [threadSubject, setThreadSubject] = useState<string | null>(null);

  const { data: detail, isLoading, error } = useQuery({
    queryKey: ['correspondence', id],
    queryFn: () => correspondenceApi.get(id),
  });
  const { data: events } = useQuery({
    queryKey: ['correspondence-events', id],
    queryFn: () => correspondenceApi.events(id),
    enabled: showEvents,
  });

  useEffect(() => {
    let cancelled = false;
    setOpened(null);
    if (!detail) return;
    openCorrespondence(detail)
      .then((r) => !cancelled && setOpened(r))
      .catch((err) => !cancelled && setOpened({ state: 'unavailable', reason: err instanceof Error ? err.message : 'تعذر فك التشفير' }));
    return () => {
      cancelled = true;
    };
  }, [detail]);

  const isSender = detail?.sender.id === String(user?.id);
  useEffect(() => {
    if (detail && !isSender && !detail.read_at && detail.status !== 'draft') {
      correspondenceApi
        .markRead(detail.id)
        .then(() => {
          void queryClient.invalidateQueries({ queryKey: ['correspondences'] });
          void queryClient.invalidateQueries({ queryKey: ['correspondence-counts'] });
        })
        .catch(() => undefined);
    }
  }, [detail, isSender, queryClient]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['correspondence', id] });
    void queryClient.invalidateQueries({ queryKey: ['correspondences'] });
  };
  const flags = useMutation({
    mutationFn: (f: { archived?: boolean; important?: boolean }) => correspondenceApi.setFlags(id, f),
    onSuccess: refresh,
  });
  const close = useMutation({ mutationFn: () => correspondenceApi.close(id), onSuccess: refresh });
  const discard = useMutation({
    mutationFn: () => correspondenceApi.discard(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['correspondences'] });
      navigate('/mail/drafts', { replace: true });
    },
  });

  const names = useMemo(() => {
    const map = new Map<string, string>();
    if (detail) {
      map.set(detail.sender.id, detail.sender.full_name);
      for (const p of detail.participants) map.set(p.user.id, p.user.full_name);
    }
    return map;
  }, [detail]);

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }
  if (error || !detail) {
    return (
      <Card className="mx-auto mt-10 max-w-md p-8 text-center text-sm text-gray-600">
        {toUserMessage(error, 'لا تملك صلاحية الاطلاع على هذه المراسلة أو أنها غير موجودة')}
      </Card>
    );
  }

  const subject = opened?.state === 'ok' ? opened.stored.content.subject : null;
  const to = detail.participants.filter((p) => p.kind === 'to');
  const cc = detail.participants.filter((p) => p.kind === 'cc');
  const canReply = detail.status === 'sent';
  const canForward = detail.status !== 'draft' && opened?.state === 'ok';

  const toolbarButton =
    'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-40';

  return (
    <div className={cn(embedded ? 'space-y-4 px-6 pb-8' : 'mx-auto max-w-4xl space-y-4')}>
      {/* شريط الأوامر — أسلوب Outlook */}
      <div className={cn('flex flex-wrap items-center gap-1 border-b border-gray-200 bg-white py-1.5', embedded ? 'sticky top-0 z-10 -mx-6 px-4' : 'rounded-t-xl px-2')}>
        {canReply && (
          <button
            type="button"
            className={toolbarButton}
            onClick={() => {
              setReplying(true);
              requestAnimationFrame(() => document.getElementById('reply-box')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
            }}
          >
            <Reply className="h-4 w-4 text-primary-600" />
            رد على الجميع
          </button>
        )}
        {canForward && (
          <button type="button" className={toolbarButton} onClick={() => navigate(`/mail/${folderSlug ?? 'inbox'}/compose?forward=${detail.id}`)}>
            <Forward className="h-4 w-4 text-primary-600" />
            إحالة
          </button>
        )}
        {detail.status !== 'draft' && (
          <>
            <button type="button" className={toolbarButton} onClick={() => flags.mutate({ archived: !detail.archived })}>
              {detail.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
              {detail.archived ? 'إلغاء الأرشفة' : 'أرشفة'}
            </button>
            <button
              type="button"
              className={toolbarButton}
              onClick={() => flags.mutate({ important: !detail.is_important })}
              aria-label={detail.is_important ? 'إزالة من المهمة' : 'تعليم كمهمة'}
            >
              <Star className={cn('h-4 w-4', detail.is_important && 'fill-amber-400 text-amber-400')} />
              {detail.is_important ? 'مهمة' : 'تعليم كمهمة'}
            </button>
          </>
        )}
        {isSender && detail.status === 'sent' && (
          <button type="button" className={toolbarButton} onClick={() => close.mutate()} disabled={close.isPending}>
            <XCircle className="h-4 w-4" />
            إغلاق المعاملة
          </button>
        )}
        {isSender && detail.status === 'draft' && (
          <button type="button" className={cn(toolbarButton, 'text-red-600')} onClick={() => discard.mutate()} disabled={discard.isPending}>
            <Trash2 className="h-4 w-4" />
            حذف
          </button>
        )}
      </div>

      <div className="space-y-2">
        <h2 className="break-words text-xl font-semibold text-gray-900">
          {threadSubject ?? (subject ? conversationSubject(subject) : null) ?? (
            <span className="flex items-center gap-2 text-gray-400">
              <Lock className="h-5 w-5" />
              مشفّرة
            </span>
          )}
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
          {detail.thread_items.length > 1 && (
            <span className="rounded-full bg-gray-100 px-2 py-0.5">{detail.thread_items.length} رسائل</span>
          )}
          <PriorityBadge priority={detail.priority} />
          <ClassificationBadge classification={detail.classification} />
          {detail.status === 'closed' && <span className="rounded-full bg-gray-100 px-2 py-0.5">مغلقة</span>}
          {detail.is_forward && detail.forwarded_from_reference && (
            <span>
              إحالة من <span dir="ltr">{detail.forwarded_from_reference}</span>
            </span>
          )}
        </div>
      </div>

      {canReply && replying && (
        <ReplyBox
          key={detail.thread_items.length}
          detail={detail}
          onCancel={() => setReplying(false)}
          onSent={() => {
            // الرد يظهر أعلى المحادثة نفسها — لا ننتقل لمجلد آخر.
            setReplying(false);
            refresh();
          }}
        />
      )}

      {detail.thread_items.length > 0 ? (
        <Conversation detail={detail} names={names} isSender={isSender} onSubject={setThreadSubject} />
      ) : (
        <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-3 border-b border-gray-100 pb-4">
            <Avatar name={detail.sender.full_name || detail.sender.username} size="lg" />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold text-gray-900">{detail.sender.full_name}</span>
                <span className="text-xs text-gray-500">
                  {detail.sent_at ? formatDate(detail.sent_at) : `أُنشئت ${formatDate(detail.created_at)}`}
                </span>
              </div>
              <ParticipantsLine label="إلى" people={to} showReceipts={isSender} />
              <ParticipantsLine label="نسخة" people={cc} showReceipts={isSender} />
              <p className="text-xs text-gray-500">بلا رقم (لم تُرسل)</p>
            </div>
          </div>
          <ContentView opened={opened} />
        </div>
      )}
      <E2EENote />

      <ApprovalPanel detail={detail} isSender={isSender} />

      <Card className="p-5">
        <button
          type="button"
          onClick={() => setShowEvents((v) => !v)}
          className="flex items-center gap-2 text-sm font-semibold text-gray-900"
        >
          <History className="h-4 w-4" />
          السجل الزمني
        </button>
        {showEvents && (
          <ol className="mt-3 space-y-1 text-sm text-gray-600">
            {(events ?? []).map((e, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span>
                  {EVENT_LABELS[e.event_type] ?? e.event_type}
                  {e.actor && ` — ${e.actor.full_name}`}
                </span>
                <span className="text-xs text-gray-400">{formatDate(e.created_at)}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

export function DetailsPage() {
  const { id } = useParams<{ id: string }>();
  return <CryptoGate>{id ? <Details key={id} id={id} /> : null}</CryptoGate>;
}
