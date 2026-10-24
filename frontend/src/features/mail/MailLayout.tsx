/**
 * البريد بأسلوب Outlook: ثلاث لوحات — المجلدات | قائمة الرسائل | لوحة القراءة.
 *
 *   /mail/:folder            قائمة المجلد، لوحة القراءة فارغة
 *   /mail/:folder/:id        الرسالة مفتوحة في لوحة القراءة
 *   /mail/compose[?draft|?forward]   رسالة جديدة في لوحة القراءة
 *   /correspondence/:id      (روابط قديمة/إشعارات) = الوارد + الرسالة
 *
 * كل فك التشفير على الجهاز (CryptoGate + خدمات المراسلات)؛ القائمة تعرض
 * العناوين والمقتطفات من الكاش المحلي المغلّف فقط.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileText,
  Forward,
  Inbox,
  Lock,
  Mail,
  PenSquare,
  Reply,
  Search,
  Send,
  Star,
} from 'lucide-react';
import { Avatar, Spinner } from '../../shared/ui';
import { cn } from '../../shared/lib/cn';
import { toUserMessage } from '../../shared/api';
import { correspondenceApi, FOLDER_LABELS, type CorrespondenceSummary, type Folder } from '../correspondence/api';
import { ComposeForm } from '../correspondence/ComposePage';
import { CryptoGate } from '../correspondence/components';
import { Details } from '../correspondence/DetailsPage';
import { DraftsPage } from '../correspondence/DraftsPage';
import { getStoredContent, openCorrespondence } from '../correspondence/service';

const FOLDERS: Array<{ key: Folder; slug: string; icon: typeof Inbox }> = [
  { key: 'inbox', slug: 'inbox', icon: Inbox },
  { key: 'sent', slug: 'sent', icon: Send },
  { key: 'drafts', slug: 'drafts', icon: FileText },
  { key: 'important', slug: 'important', icon: Star },
  { key: 'pending_replies', slug: 'pending', icon: Clock },
  { key: 'archived', slug: 'archived', icon: Archive },
];

const slugToFolder = (slug?: string): Folder => FOLDERS.find((f) => f.slug === slug)?.key ?? 'inbox';
const folderToSlug = (folder: Folder) => FOLDERS.find((f) => f.key === folder)?.slug ?? 'inbox';

// ---------------------------------------------------------------------------
// لوحة المجلدات
// ---------------------------------------------------------------------------

function FolderPane({ folder }: { folder: Folder }) {
  const navigate = useNavigate();
  const { data: counts } = useQuery({
    queryKey: ['correspondence-counts'],
    queryFn: correspondenceApi.counts,
    refetchInterval: 30_000,
  });
  const badge: Partial<Record<Folder, number>> = {
    inbox: counts?.inbox_unread,
    pending_replies: counts?.pending_replies,
  };
  return (
    <aside className="flex w-56 shrink-0 flex-col border-e border-gray-200 bg-gray-50">
      <div className="p-3">
        <button
          type="button"
          // كما في Outlook: الرسالة الجديدة تُفتح في لوحة القراءة والمجلد والقائمة باقيان.
          onClick={() => navigate(`/mail/${folderToSlug(folder)}/compose`)}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-primary-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-primary-700"
        >
          <PenSquare className="h-4 w-4" />
          رسالة جديدة
        </button>
      </div>
      <nav className="flex-1 space-y-0.5 px-2" aria-label="المجلدات">
        {FOLDERS.map(({ key, slug, icon: Icon }) => {
          const active = key === folder;
          const n = badge[key];
          return (
            <Link
              key={key}
              to={`/mail/${slug}`}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-1.5 text-sm',
                active ? 'bg-primary-100 font-semibold text-primary-900' : 'text-gray-700 hover:bg-gray-200/60',
              )}
            >
              <Icon className={cn('h-4 w-4', active ? 'text-primary-700' : 'text-gray-500')} />
              <span className="flex-1">{FOLDER_LABELS[key]}</span>
              {n ? <span className={cn('text-xs font-semibold', key === 'inbox' ? 'text-primary-700' : 'text-gray-500')}>{n}</span> : null}
            </Link>
          );
        })}
      </nav>
      <p className="flex items-start gap-1.5 p-3 text-[11px] leading-5 text-gray-500">
        <Lock className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
        كل الرسائل مشفّرة طرفًا لطرف وتُفك على هذا الجهاز فقط.
      </p>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// قائمة الرسائل
// ---------------------------------------------------------------------------

const NO_ITEMS: CorrespondenceSummary[] = [];

interface Preview {
  subject: string;
  snippet: string;
  attachments: number;
}

/** العناوين والمقتطفات من الكاش المحلي، ويُفك غير المفكوك في الخلفية بالتتابع. */
function usePreviews(items: CorrespondenceSummary[]): Map<string, Preview> {
  const [previews, setPreviews] = useState<Map<string, Preview>>(new Map());
  useEffect(() => {
    let cancelled = false;
    const toPreview = (c: { subject: string; body: string; attachments: unknown[] }): Preview => ({
      subject: c.subject,
      snippet: c.body.replace(/\s+/g, ' ').slice(0, 120),
      attachments: c.attachments.length,
    });
    (async () => {
      const found = new Map<string, Preview>();
      for (const item of items) {
        const stored = await getStoredContent(item.id);
        if (stored) found.set(item.id, toPreview(stored.content));
      }
      if (!cancelled) setPreviews((prev) => (prev.size === found.size && [...found.keys()].every((k) => prev.has(k)) ? prev : new Map(found)));
      for (const item of items) {
        if (cancelled || found.has(item.id) || item.status === 'draft') continue;
        try {
          const opened = await openCorrespondence(await correspondenceApi.get(item.id));
          if (opened.state === 'ok' && !cancelled) {
            found.set(item.id, toPreview(opened.stored.content));
            setPreviews(new Map(found));
          }
        } catch {
          // يبقى «مشفّرة» — لوحة القراءة تعرض السبب.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [items]);
  return previews;
}

function timeLabel(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('ar', sameYear ? { day: 'numeric', month: 'short' } : { dateStyle: 'short' });
}

interface ConversationGroup {
  latest: CorrespondenceSummary;
  ids: string[];
  unread: boolean;
}

/** رسائل الخيط الواحد في صف واحد (أسلوب Outlook «عرض كمحادثات»)، بترتيب الأحدث. */
function groupByConversation(items: CorrespondenceSummary[], folder: Folder): ConversationGroup[] {
  const groups = new Map<string, ConversationGroup>();
  for (const item of items) {
    const key = item.status === 'draft' ? `draft:${item.id}` : item.thread_id;
    const unread = folder !== 'sent' && item.my_kind !== 'from' && !item.read_at;
    const g = groups.get(key);
    if (g) {
      g.ids.push(item.id);
      g.unread ||= unread;
    } else {
      groups.set(key, { latest: item, ids: [item.id], unread });
    }
  }
  // مثل Outlook: المحادثة ترتفع بآخر نشاط فيها (ولو كان ردّي أنا).
  const lastAt = (g: ConversationGroup) => g.latest.thread_last_at ?? g.latest.sent_at ?? g.latest.created_at;
  return [...groups.values()].sort((a, b) => lastAt(b).localeCompare(lastAt(a)));
}

function MessageRow({
  item,
  folder,
  preview,
  selected,
  count,
  unread,
  onOpen,
}: {
  item: CorrespondenceSummary;
  folder: Folder;
  preview?: Preview;
  selected: boolean;
  count: number;
  unread: boolean;
  onOpen: () => void;
}) {
  const outgoing = folder === 'sent' || item.my_kind === 'from';
  const counterpart = outgoing
    ? item.participants.filter((p) => p.kind === 'to').map((p) => p.user.full_name).join('، ') || '—'
    : item.sender.full_name;
  const overdue = item.due_date && item.status === 'sent' && new Date(item.due_date) < new Date();
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'relative flex w-full gap-3 border-b border-gray-100 px-3 py-2.5 text-start transition-colors',
        selected ? 'bg-primary-50' : 'hover:bg-gray-50',
      )}
    >
      {unread && <span className="absolute inset-y-0 start-0 w-1 bg-primary-600" aria-label="غير مقروءة" />}
      <Avatar name={counterpart} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={cn('truncate text-sm', unread ? 'font-bold text-gray-900' : 'text-gray-800')}>
            {outgoing ? `إلى: ${counterpart}` : counterpart}
          </span>
          {count > 1 && (
            <span className="shrink-0 rounded-full bg-gray-100 px-1.5 text-xs text-gray-600" title="رسائل في هذه المحادثة">
              {count}
            </span>
          )}
          <span className={cn('shrink-0 text-xs', unread ? 'font-semibold text-primary-700' : 'text-gray-500')}>
            {timeLabel(item.thread_last_at ?? item.sent_at ?? item.created_at)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {item.reply_to_id && <Reply className="h-3.5 w-3.5 shrink-0 text-gray-400" />}
          {item.is_forward && <Forward className="h-3.5 w-3.5 shrink-0 text-gray-400" />}
          <span className={cn('truncate text-sm', unread ? 'font-semibold text-primary-800' : 'text-gray-700')}>
            {preview ? preview.subject || '(بلا عنوان)' : item.status === 'draft' ? 'لم يكتمل إرسالها' : (
              <span className="inline-flex items-center gap-1 text-gray-400">
                <Lock className="h-3 w-3" />
                مشفّرة…
              </span>
            )}
          </span>
          <span className="ms-auto flex shrink-0 items-center gap-1">
            {preview && preview.attachments > 0 && <span className="text-xs text-gray-400" title="مرفقات">📎</span>}
            {item.priority === 'urgent' && <span className="text-xs font-bold text-red-600" title="عاجلة">!</span>}
            {item.priority === 'high' && <span className="text-xs font-bold text-amber-600" title="عالية">!</span>}
            {item.is_important && <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />}
          </span>
        </div>
        <p className="truncate text-xs text-gray-500">
          {preview?.snippet ?? ''}
          {overdue && <span className="ms-1 text-red-600">· متأخرة</span>}
        </p>
      </div>
    </button>
  );
}

function MessageList({ folder, selectedId }: { folder: Folder; selectedId?: string }) {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  useEffect(() => setPage(1), [folder, query, unreadOnly]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['correspondences', folder, page, query, unreadOnly],
    queryFn: () => correspondenceApi.list({ folder, page, q: query, unread: unreadOnly }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const items = data?.results ?? NO_ITEMS;
  const previews = usePreviews(items);
  const groups = useMemo(() => groupByConversation(items, folder), [items, folder]);

  return (
    <section className="flex w-[380px] shrink-0 flex-col border-e border-gray-200 bg-white">
      <div className="space-y-2 border-b border-gray-200 p-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">{FOLDER_LABELS[folder]}</h2>
          {folder !== 'sent' && (
            <div className="flex rounded-md bg-gray-100 p-0.5 text-xs">
              {(['الكل', 'غير المقروءة'] as const).map((label, i) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setUnreadOnly(i === 1)}
                  className={cn('rounded px-2 py-0.5', unreadOnly === (i === 1) ? 'bg-white font-medium text-gray-900 shadow-sm' : 'text-gray-500')}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(q.trim());
          }}
          className="relative"
        >
          <Search className="pointer-events-none absolute start-2.5 top-2 h-4 w-4 text-gray-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="بحث بالرقم المرجعي…"
            aria-label="بحث بالرقم المرجعي"
            className="h-8 w-full rounded-md border border-gray-200 bg-gray-50 ps-8 text-sm focus:border-primary-500 focus:bg-white focus:outline-none"
          />
        </form>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : error ? (
          <p className="p-4 text-sm text-red-600">{toUserMessage(error, 'تعذر تحميل الرسائل')}</p>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center text-sm text-gray-400">
            <Mail className="h-10 w-10 text-gray-300" />
            {query ? 'لا نتائج' : 'لا رسائل في هذا المجلد'}
          </div>
        ) : (
          groups.map(({ latest, ids, unread }) => (
            <MessageRow
              key={latest.id}
              item={latest}
              folder={folder}
              preview={previews.get(latest.id)}
              selected={selectedId !== undefined && ids.includes(selectedId)}
              count={Math.max(ids.length, latest.thread_count ?? 1)}
              unread={unread}
              onOpen={() => navigate(`/mail/${folderToSlug(folder)}/${latest.id}`)}
            />
          ))
        )}
      </div>
      {data && (data.next || data.previous) && (
        <div className="flex items-center justify-between border-t border-gray-200 px-3 py-2 text-xs text-gray-500">
          <span>
            {(page - 1) * 25 + 1}–{(page - 1) * 25 + items.length} من {data.count}
          </span>
          <span className="flex gap-1">
            <button type="button" disabled={!data.previous} onClick={() => setPage((p) => p - 1)} className="rounded p-1 hover:bg-gray-100 disabled:opacity-30" aria-label="السابق">
              <ChevronRight className="h-4 w-4" />
            </button>
            <button type="button" disabled={!data.next} onClick={() => setPage((p) => p + 1)} className="rounded p-1 hover:bg-gray-100 disabled:opacity-30" aria-label="التالي">
              <ChevronLeft className="h-4 w-4" />
            </button>
          </span>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// التخطيط
// ---------------------------------------------------------------------------

function ReadingPlaceholder() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-gray-400">
      <Mail className="h-16 w-16 text-gray-200" />
      <p className="text-sm">اختر رسالة لقراءتها</p>
    </div>
  );
}

export function MailLayout({ mode }: { mode?: 'compose' | 'legacy' }) {
  const params = useParams<{ folder?: string; id?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const folder = mode === 'legacy' ? 'inbox' : slugToFolder(params.folder);
  const composeKey = useMemo(() => location.search, [location.search]);
  const selectedId = params.id;
  const composing = mode === 'compose';

  // المسودات محلية على الجهاز: قائمتها هي صفحة المسودات نفسها.
  const list =
    folder === 'drafts' ? (
      <section className={cn('min-w-0 overflow-y-auto border-e border-gray-200 bg-white p-4', composing ? 'w-[380px] shrink-0' : 'flex-1')}>
        <DraftsPage />
      </section>
    ) : (
      <MessageList folder={folder} selectedId={selectedId} />
    );

  return (
    <CryptoGate>
      <div className="flex h-full">
        <FolderPane folder={folder} />
        {list}
        {(folder !== 'drafts' || composing) && (
          <section className="min-w-0 flex-1 overflow-y-auto bg-gray-50">
            {composing ? (
              <ComposeForm key={composeKey} embedded onCancel={() => navigate(`/mail/${folderToSlug(folder)}`)} />
            ) : selectedId ? (
              <Details key={selectedId} id={selectedId} embedded />
            ) : (
              <ReadingPlaceholder />
            )}
          </section>
        )}
      </div>
    </CryptoGate>
  );
}
