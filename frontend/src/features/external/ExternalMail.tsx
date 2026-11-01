import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  AtSign,
  ChevronDown,
  Copy,
  Download,
  File as FileIcon,
  FileImage,
  FileSpreadsheet,
  FileText,
  Forward,
  Globe,
  ImageOff,
  Paperclip,
  PenSquare,
  Reply,
  ReplyAll,
  Send,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Avatar, Button, Spinner } from '../../shared/ui';
import { toUserMessage } from '../../shared/api';
import { cn } from '../../shared/lib/cn';
import { formatDate } from '../correspondence/components';
import { AttachmentRow } from '../correspondence/DetailsPage';
import { correspondenceApi, type AttachmentMeta } from '../correspondence/api';
import { downloadAttachment, formatBytes } from '../correspondence/content';
import {
  externalApi,
  fileToBase64,
  openExternal,
  type ExternalSummary,
  type MailboxInfo,
} from './service';

export const useMailbox = () =>
  useQuery({ queryKey: ['external-mailbox'], queryFn: externalApi.me, staleTime: 30_000, refetchInterval: 60_000 });

function shortTime(iso: string): string {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('ar', { day: 'numeric', month: 'short' });
}

/** العناوين في العرض: يتجنب الخلط بين الاسم والعنوان (انتحال شائع في التصيّد). */
function addressLine(a: { name: string; address: string }): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

// --- القائمة ----------------------------------------------------------------------------------

const NO_ITEMS: ExternalSummary[] = [];

function ExternalList({
  mailbox,
  selectedId,
  mobileHidden,
  folderSelect,
}: {
  mailbox: MailboxInfo;
  selectedId?: string;
  mobileHidden: boolean;
  folderSelect: React.ReactNode;
}) {
  const navigate = useNavigate();
  const [box, setBox] = useState<'all' | 'in' | 'out'>('all');
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ['external-messages', box, page],
    queryFn: () => externalApi.list(page, box),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const items = data?.results ?? NO_ITEMS;

  return (
    <section className={cn('w-full shrink-0 flex-col border-e border-gray-200 bg-white md:flex md:w-[380px]', mobileHidden ? 'hidden' : 'flex')}>
      <div className="space-y-2 border-b border-gray-200 p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="hidden items-center gap-2 text-base font-semibold text-gray-900 md:flex">
            <Globe className="h-4 w-4 text-gray-500" />
            البريد الخارجي
          </h2>
          <div className="md:hidden">{folderSelect}</div>
          {mailbox.sending_enabled && mailbox.sending_configured && (
            <button
              type="button"
              onClick={() => navigate('/mail/external/compose')}
              className="flex items-center gap-1.5 rounded-md bg-primary-600 px-2.5 py-1.5 text-sm text-white hover:bg-primary-700"
            >
              <PenSquare className="h-4 w-4" />
              <span className="hidden sm:inline">رسالة خارجية</span>
            </button>
          )}
        </div>
        {mailbox.address && (
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(mailbox.address!).catch(() => undefined)}
            className="flex w-full items-center gap-1.5 truncate rounded-md bg-gray-50 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100"
            title="نسخ عنواني"
          >
            <AtSign className="h-3.5 w-3.5 shrink-0" />
            <span dir="ltr" className="truncate font-mono">{mailbox.address}</span>
            <Copy className="ms-auto h-3 w-3 shrink-0" />
          </button>
        )}
        <div className="flex rounded-md bg-gray-100 p-0.5 text-xs">
          {([['all', 'الكل'], ['in', 'الوارد'], ['out', 'المرسل']] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setBox(key);
                setPage(1);
              }}
              className={cn('flex-1 rounded px-2 py-1', box === key ? 'bg-white font-medium text-gray-900 shadow-sm' : 'text-gray-500')}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-sm text-gray-400">
            <Globe className="h-10 w-10 text-gray-300" />
            لا رسائل خارجية بعد.
            {mailbox.address && <span className="text-xs">أعطِ عنوانك أعلاه لمن يراسلك من خارج النظام.</span>}
          </div>
        ) : (
          items.map((item) => {
            const unread = item.direction === 'in' && !item.read_at;
            const who = item.direction === 'in' ? item.from_name || item.from : `إلى: ${item.recipients.join('، ')}`;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigate(`/mail/external/${item.id}`)}
                className={cn(
                  'relative flex w-full gap-3 border-b border-gray-100 px-3 py-2.5 text-start',
                  item.id === selectedId ? 'bg-primary-50' : 'hover:bg-gray-50',
                )}
              >
                {unread && <span className="absolute inset-y-0 start-0 w-1 bg-primary-600" aria-label="غير مقروءة" />}
                <Avatar name={who} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={cn('truncate text-sm', unread ? 'font-bold text-gray-900' : 'text-gray-800')}>{who}</span>
                    <span className="shrink-0 text-xs text-gray-500">{shortTime(item.created_at)}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {item.direction === 'out' && <Send className="h-3.5 w-3.5 shrink-0 text-gray-400" />}
                    {item.direction === 'in' && item.auth !== 'pass' && (
                      <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="مرسل غير موثّق" />
                    )}
                    <span className={cn('truncate text-sm', unread ? 'font-semibold text-primary-800' : 'text-gray-700')}>
                      {item.subject || '(بلا عنوان)'}
                    </span>
                    {item.attachment_count > 0 && <Paperclip className="ms-auto h-3.5 w-3.5 shrink-0 text-gray-400" />}
                  </div>
                  <p className="truncate text-xs text-gray-500">{item.preview}</p>
                </div>
              </button>
            );
          })
        )}
      </div>
      {data && (data.next || data.previous) && (
        <div className="flex justify-between border-t border-gray-200 p-2">
          <Button variant="ghost" size="sm" disabled={!data.previous} onClick={() => setPage((n) => n - 1)}>السابق</Button>
          <Button variant="ghost" size="sm" disabled={!data.next} onClick={() => setPage((n) => n + 1)}>التالي</Button>
        </div>
      )}
    </section>
  );
}

// --- القارئ -----------------------------------------------------------------------------------

/**
 * الرسالة المنسّقة كما أرسلها صاحبها (مثل Outlook). الخادم نظّفها بقائمة سماح
 * (لا سكربتات ولا نماذج ولا CSS يحمّل شيئًا). تُعرض في Shadow DOM معزولة عن
 * أنماط التطبيق، وسمات style تُطبَّق عبر CSSOM لأن CSP تمنع style المضمّنة.
 * الصور الخارجية لا تُحمَّل حتى يطلبها القارئ (صور التتبع تكشف فتح الرسالة)،
 * إلا من مرسل موثّق اختار القارئ إظهار صوره دائمًا.
 */
function EmailHtml({ html, autoImages, trustable }: { html: string; autoImages: boolean; trustable: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  const [showImages, setShowImages] = useState(autoImages);
  const [always, setAlways] = useState(autoImages);
  const [blocked, setBlocked] = useState(0);
  const trust = useMutation({
    mutationFn: (allow: boolean) => externalApi.imageSender(trustable!, allow),
    onSuccess: (_, allow) => {
      setAlways(allow);
      if (allow) setShowImages(true);
    },
  });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    const parsed = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
    const styled: Array<[HTMLElement, string]> = [];
    parsed.body.querySelectorAll<HTMLElement>('[style]').forEach((e) => {
      styled.push([e, e.getAttribute('style') ?? '']);
      e.removeAttribute('style');
    });
    let held = 0;
    parsed.body.querySelectorAll('img').forEach((img) => {
      if (!showImages && img.hasAttribute('src')) {
        img.removeAttribute('src');
        held += 1;
      }
      img.referrerPolicy = 'no-referrer';
      img.loading = 'lazy';
    });

    const box = document.createElement('div');
    box.dir = 'auto';
    box.style.cssText =
      'font-family:Tahoma,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1f2937;overflow-x:auto;overflow-wrap:anywhere';
    box.append(...Array.from(parsed.body.childNodes));
    for (const [e, css] of styled) e.style.cssText = css;
    box.querySelectorAll('img').forEach((img) => {
      img.style.maxWidth = '100%';
      img.style.height = 'auto';
    });
    root.replaceChildren(box);
    setBlocked(held);
  }, [html, showImages]);

  const link = 'font-medium text-primary-700 hover:underline disabled:opacity-50';
  return (
    <div className="space-y-3">
      {blocked > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-600 ring-1 ring-gray-200">
          <ImageOff className="h-4 w-4 shrink-0 text-gray-400" />
          <span>حُجبت الصور الخارجية لحمايتك.</span>
          <button type="button" onClick={() => setShowImages(true)} className={link}>
            إظهار الصور
          </button>
          {trustable && (
            <button type="button" onClick={() => trust.mutate(true)} disabled={trust.isPending} className={link}>
              إظهارها دائمًا من هذا المرسل
            </button>
          )}
        </div>
      )}
      {always && trustable && (
        <p className="text-xs text-gray-400">
          صور هذا المرسل تظهر تلقائيًا.{' '}
          <button type="button" onClick={() => trust.mutate(false)} disabled={trust.isPending} className="underline hover:text-gray-600">
            إيقاف
          </button>
        </p>
      )}
      <div ref={host} data-testid="external-html" />
    </div>
  );
}

function fileIcon(name: string, mime: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (mime.startsWith('image/')) return FileImage;
  if (['xls', 'xlsx', 'csv'].includes(ext)) return FileSpreadsheet;
  if (['pdf', 'doc', 'docx', 'txt', 'rtf'].includes(ext)) return FileText;
  return FileIcon;
}

/** المرفق كبطاقة صغيرة بنوعه وحجمه (أسلوب Outlook)؛ الضغط يُنزّله. */
function AttachmentChip({ meta }: { meta: AttachmentMeta }) {
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');
  const Icon = fileIcon(meta.name, meta.mime);
  const download = async () => {
    setState('busy');
    try {
      await downloadAttachment(meta);
      setState('idle');
    } catch {
      setState('error');
    }
  };
  return (
    <li>
      <button
        type="button"
        onClick={() => void download()}
        disabled={state === 'busy'}
        title={`تنزيل ${meta.name}`}
        className="flex w-56 max-w-full items-center gap-2.5 rounded-md border border-gray-200 bg-white px-2.5 py-2 text-start hover:border-primary-300 hover:bg-primary-50/40"
      >
        {state === 'busy' ? <Spinner size="sm" /> : <Icon className="h-7 w-7 shrink-0 text-primary-600" strokeWidth={1.5} />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-gray-800" dir="auto">{meta.name}</span>
          <span className={cn('block text-xs', state === 'error' ? 'text-red-600' : 'text-gray-500')}>
            {state === 'error' ? 'تعذر التنزيل' : formatBytes(meta.size)}
          </span>
        </span>
        <Download className="h-4 w-4 shrink-0 text-gray-400" />
      </button>
    </li>
  );
}

function ExternalReader({ id, mailbox }: { id: string; mailbox: MailboxInfo }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showRecipients, setShowRecipients] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: ['external-open', id], queryFn: () => openExternal(id), staleTime: Infinity });

  useEffect(() => {
    if (data?.state === 'ok' && data.stored.meta.direction === 'in') {
      externalApi
        .markRead(id)
        .then(() => {
          void queryClient.invalidateQueries({ queryKey: ['external-messages'] });
          void queryClient.invalidateQueries({ queryKey: ['external-mailbox'] });
        })
        .catch(() => undefined);
    }
  }, [data, id, queryClient]);

  const back = (
    <button type="button" onClick={() => navigate('/mail/external')} className="rounded-md p-1.5 text-gray-600 hover:bg-gray-100 md:hidden" aria-label="رجوع للقائمة">
      <ArrowRight className="h-5 w-5" />
    </button>
  );
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-gray-500">
        <Spinner size="sm" />
        جارٍ التحميل…
      </div>
    );
  }
  if (error || !data || data.state !== 'ok') {
    return (
      <div className="space-y-3 p-6">
        {back}
        <p className="text-sm text-gray-600">{data?.state === 'unavailable' ? data.reason : toUserMessage(error, 'تعذر فتح الرسالة')}</p>
      </div>
    );
  }
  const c = data.stored.content;
  const files = c.attachments.filter((a) => a.name !== 'original.eml' || a.mime !== 'message/rfc822');
  const original = c.attachments.find((a) => a.name === 'original.eml' && a.mime === 'message/rfc822');
  const incoming = c.direction === 'in';
  const verified = incoming && c.auth === 'pass';
  const mine = (mailbox.address ?? '').toLowerCase();
  const canSend = mailbox.sending_enabled && mailbox.sending_configured;
  const others = [...c.to, ...c.cc].filter((a) => a.address.toLowerCase() !== mine);
  const who = (a: { name: string; address: string }) => (a.address.toLowerCase() === mine ? 'أنا' : a.name || a.address);
  const action = (label: string, Icon: typeof Reply, to: string) => (
    <button
      type="button"
      onClick={() => navigate(to)}
      className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
    >
      <Icon className="h-4 w-4 text-primary-600" />
      {label}
    </button>
  );

  return (
    <div className="min-h-full bg-white" data-testid="external-reader">
      <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-gray-200 bg-white px-2 py-1.5 md:px-4">
        {back}
        {canSend && incoming && action('رد', Reply, `/mail/external/compose?reply=${id}`)}
        {canSend && incoming && others.length > 0 && action('رد على الكل', ReplyAll, `/mail/external/compose?reply=${id}&all=1`)}
        {canSend && action('إعادة توجيه', Forward, `/mail/external/compose?forward=${id}`)}
      </div>

      <article className="mx-auto max-w-4xl space-y-5 px-4 py-5 md:px-8">
        <h2 className="break-words text-2xl font-semibold leading-snug text-gray-900" dir="auto">
          {c.subject || '(بلا عنوان)'}
        </h2>

        {incoming && !verified && (
          <p className="flex items-start gap-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            لم يُتحقق من هوية المرسل — قد يكون منتحلًا. لا تفتح روابط أو مرفقات لم تتوقعها.
          </p>
        )}

        <div className="flex items-start gap-3">
          <Avatar name={c.from.name || c.from.address} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-semibold text-gray-900" dir="auto">{c.from.name || c.from.address}</span>
              {c.from.name && (
                <span dir="ltr" className="truncate text-xs text-gray-500">&lt;{c.from.address}&gt;</span>
              )}
              {verified && <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" aria-label="مرسل موثّق" />}
              <span
                className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700 ring-1 ring-amber-100"
                title={incoming ? 'وصلت من خارج النظام عبر الإنترنت' : 'خرجت إلى خارج النظام عبر الإنترنت'}
              >
                <Globe className="h-3 w-3" />
                خارجي
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowRecipients((v) => !v)}
              className="mt-0.5 flex max-w-full items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
              aria-expanded={showRecipients}
            >
              <span className="truncate">
                إلى: {c.to.map(who).join('، ')}
                {c.cc.length > 0 && ` · نسخة: ${c.cc.map(who).join('، ')}`}
              </span>
              <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', showRecipients && 'rotate-180')} />
            </button>
            {showRecipients && (
              <div className="mt-1 space-y-0.5 rounded-md bg-gray-50 px-2.5 py-1.5 text-xs text-gray-600">
                <p>
                  <span className="text-gray-400">من: </span>
                  <span dir="ltr">{addressLine(c.from)}</span>
                </p>
                <p>
                  <span className="text-gray-400">إلى: </span>
                  <span dir="ltr">{c.to.map(addressLine).join(', ')}</span>
                </p>
                {c.cc.length > 0 && (
                  <p>
                    <span className="text-gray-400">نسخة: </span>
                    <span dir="ltr">{c.cc.map(addressLine).join(', ')}</span>
                  </p>
                )}
              </div>
            )}
          </div>
          <span className="shrink-0 pt-0.5 text-xs text-gray-500">{formatDate(data.stored.meta.created_at)}</span>
        </div>

        {(files.length > 0 || c.removed_infected.length > 0) && (
          <div className="space-y-2">
            {files.length > 0 && (
              <ul className="flex flex-wrap gap-2" aria-label={`المرفقات (${files.length})`}>
                {files.map((a) => (
                  <AttachmentChip key={a.id} meta={a} />
                ))}
              </ul>
            )}
            {incoming && files.length > 0 && c.virus_scan === 'off' && (
              <p className="flex items-start gap-1.5 text-xs text-amber-700">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                لم تُفحص المرفقات من الفيروسات على الخادم. افحصها على جهازك قبل فتحها.
              </p>
            )}
            {c.removed_infected.length > 0 && (
              <p className="flex items-start gap-1.5 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                حُذفت مرفقات مصابة بفيروس: {c.removed_infected.join('، ')}
              </p>
            )}
          </div>
        )}

        <div className="border-t border-gray-100 pt-5">
          {c.html ? (
            <EmailHtml html={c.html} autoImages={data.stored.meta.images_allowed} trustable={verified ? c.from.address : null} />
          ) : (
            <div className="whitespace-pre-wrap break-words text-sm leading-7 text-gray-800" dir="auto">
              {c.body || '—'}
            </div>
          )}
        </div>

        {original && (
          <details className="border-t border-gray-100 pt-3 text-xs text-gray-400">
            <summary className="cursor-pointer hover:text-gray-600">الرسالة الأصلية (.eml) — للأرشفة أو الإحالة لجهة فنية</summary>
            <ul className="mt-2">
              <AttachmentRow meta={original} />
            </ul>
          </details>
        )}
      </article>
    </div>
  );
}

// --- الإنشاء ----------------------------------------------------------------------------------

function splitAddresses(text: string): string[] {
  return text
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function ExternalCompose({ mailbox }: { mailbox: MailboxInfo }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const replyId = params.get('reply');
  const replyAll = params.get('all') === '1';
  const forwardId = params.get('forward');
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sourceId = replyId ?? forwardId;
    if (!sourceId) return;
    let alive = true;
    void openExternal(sourceId).then(async (r) => {
      if (r.state !== 'ok' || !alive) return;
      const c = r.stored.content;
      const when = formatDate(r.stored.meta.created_at);
      if (forwardId) {
        setSubject(/^(fwd?|توجيه)\s*:/i.test(c.subject) ? c.subject : `Fwd: ${c.subject}`);
        setBody(
          `\n\n---------- رسالة محوّلة ----------\nمن: ${addressLine(c.from)}\nالتاريخ: ${when}\n`
            + `العنوان: ${c.subject}\nإلى: ${c.to.map(addressLine).join(', ')}\n\n${c.body}`,
        );
        const originals = c.attachments.filter((a) => a.name !== 'original.eml' || a.mime !== 'message/rfc822');
        const loaded = await Promise.all(
          originals.map(async (a) => new File([await correspondenceApi.download(a.id)], a.name, { type: a.mime })),
        ).catch(() => []);
        if (alive) setFiles(loaded);
        return;
      }
      const mine = (mailbox.address ?? '').toLowerCase();
      setTo(c.from.address);
      if (replyAll) {
        const sender = c.from.address.toLowerCase();
        setCc(
          [...c.to, ...c.cc]
            .map((a) => a.address)
            .filter((a) => ![mine, sender].includes(a.toLowerCase()))
            .join(', '),
        );
      }
      setSubject(/^(re|رد)\s*:/i.test(c.subject) ? c.subject : `Re: ${c.subject}`);
      const quoted = c.body
        .split('\n')
        .slice(0, 60)
        .map((l) => `> ${l}`)
        .join('\n');
      setBody(`\n\n— كتب ${addressLine(c.from)} في ${when}:\n${quoted}`);
    });
    return () => {
      alive = false;
    };
  }, [replyId, replyAll, forwardId, mailbox.address]);

  const send = useMutation({
    mutationFn: async () =>
      externalApi.send({
        to: splitAddresses(to),
        cc: splitAddresses(cc),
        subject,
        body,
        attachments: await Promise.all(
          files.map(async (f) => ({ name: f.name, mime: f.type || 'application/octet-stream', data: await fileToBase64(f) })),
        ),
        reply_to_id: replyId,
      }),
    onSuccess: (sent) => {
      void queryClient.invalidateQueries({ queryKey: ['external-messages'] });
      navigate(`/mail/external/${sent.id}`);
    },
    onError: (err) => setError(toUserMessage(err, 'تعذر الإرسال')),
  });

  if (!mailbox.sending_enabled || !mailbox.sending_configured) {
    return (
      <div className="p-6 text-sm text-gray-600">
        {!mailbox.sending_configured ? 'الإرسال الخارجي غير مُعد على هذا الخادم.' : 'الإرسال للخارج غير مفعّل لحسابك — اطلبه من مسؤول النظام.'}
      </div>
    );
  }
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    send.mutate();
  };
  const field = 'w-full border-0 border-b border-gray-200 bg-transparent px-1 py-2 text-sm focus:border-primary-500 focus:outline-none';
  return (
    <form onSubmit={onSubmit} className="flex min-h-full flex-col bg-white" data-testid="external-compose">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2">
        <span className="flex items-center gap-2 font-semibold text-gray-900">
          <Globe className="h-4 w-4" />
          {replyId ? 'رد خارجي' : forwardId ? 'إعادة توجيه' : 'رسالة خارجية'}
        </span>
        <button type="button" onClick={() => navigate('/mail/external')} className="rounded p-1 text-gray-500 hover:bg-gray-100" aria-label="إلغاء">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="m-4 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 ring-1 ring-red-100">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        هذه الرسالة ستخرج إلى خارج النظام عبر الإنترنت. لا ترسل معلومات سرية؛ وللزملاء استخدم المراسلات الداخلية.
      </div>
      <div className="space-y-1 px-4">
        <p className="text-xs text-gray-500">
          من: <span dir="ltr" className="font-mono">{mailbox.address}</span>
        </p>
        <input id="ext-to" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} placeholder="إلى: name@example.com" className={field} aria-label="إلى" required />
        <input id="ext-cc" dir="ltr" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="نسخة (اختياري)" className={field} aria-label="نسخة" />
        <input id="ext-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="العنوان" className={cn(field, 'font-medium')} aria-label="العنوان" required />
      </div>
      <textarea
        id="ext-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        dir="auto"
        className="min-h-[16rem] flex-1 resize-none px-5 py-4 text-sm leading-7 focus:outline-none"
        aria-label="نص الرسالة"
      />
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2 px-4">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs">
              <Paperclip className="h-3.5 w-3.5 text-gray-400" />
              <span className="max-w-[12rem] truncate">{f.name}</span>
              <span className="text-gray-400">{formatBytes(f.size)}</span>
              <button type="button" onClick={() => setFiles((all) => all.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-600" aria-label={`إزالة ${f.name}`}>
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mx-4 mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <div className="flex items-center gap-2 border-t border-gray-200 px-4 py-3">
        <Button type="submit" loading={send.isPending}>
          <Send className="h-4 w-4" />
          إرسال للخارج
        </Button>
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-gray-600 hover:bg-gray-100">
          <Paperclip className="h-4 w-4" />
          إرفاق
          <input type="file" multiple className="hidden" onChange={(e) => {
              const picked = e.target.files ? [...e.target.files] : [];
              setFiles((all) => [...all, ...picked]);
              e.target.value = '';
            }} />
        </label>
      </div>
    </form>
  );
}

// --- التخطيط ------------------------------------------------------------------------------------

export function ExternalMail({ id, composing, folderSelect }: { id?: string; composing: boolean; folderSelect: React.ReactNode }) {
  const { data: mailbox, isLoading } = useMailbox();
  const paneOpen = Boolean(id) || composing;
  const content = useMemo(() => {
    if (!mailbox) return null;
    if (composing) return <ExternalCompose mailbox={mailbox} />;
    if (id) return <ExternalReader key={id} id={id} mailbox={mailbox} />;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-gray-400">
        <Globe className="h-12 w-12 text-gray-200" />
        <p className="text-sm">اختر رسالة لقراءتها</p>
      </div>
    );
  }, [mailbox, id, composing]);

  if (isLoading) {
    return (
      <div className="flex flex-1 justify-center py-16">
        <Spinner />
      </div>
    );
  }
  if (!mailbox?.receiving_configured) {
    return <div className="flex-1 p-6 text-sm text-gray-600">البريد الخارجي غير مُعد على هذا الخادم.</div>;
  }
  return (
    <>
      <ExternalList mailbox={mailbox} selectedId={id} mobileHidden={paneOpen} folderSelect={folderSelect} />
      <section className={cn('min-w-0 flex-1 overflow-y-auto bg-gray-50', !paneOpen && 'hidden md:block')}>{content}</section>
    </>
  );
}
