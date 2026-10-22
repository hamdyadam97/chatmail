import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Forward, Inbox, Lock, Reply, Search, Star } from 'lucide-react';
import { Button, Card, EmptyState, Input, Spinner } from '../../shared/ui';
import { cn } from '../../shared/lib/cn';
import { toUserMessage } from '../../shared/api';
import { correspondenceApi, FOLDER_LABELS, type CorrespondenceSummary, type Folder, type Priority } from './api';
import { ClassificationBadge, CryptoGate, PriorityBadge, formatDate, formatDay } from './components';
import { getStoredContent, openCorrespondence } from './service';

const NO_ITEMS: CorrespondenceSummary[] = [];

/** عنوان مفكوك من الكاش المحلي فقط؛ غير المفكوك يُعرض كمشفّر حتى يُفتح. */
function useSubjects(items: CorrespondenceSummary[]): Map<string, string> {
  const [subjects, setSubjects] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const found = new Map<string, string>();
      for (const item of items) {
        const stored = await getStoredContent(item.id);
        if (stored) found.set(item.id, stored.content.subject);
      }
      // لا تحديث حالة بلا تغيير — وإلا حلقة إعادة رسم مع كل جلب.
      if (!cancelled) setSubjects((prev) => (sameEntries(prev, found) ? prev : new Map(found)));
      // فك المتبقي في الخلفية بالتتابع (كل خيط يُغذّى مرة واحدة ويُخزن كل ما فيه).
      for (const item of items) {
        if (cancelled || found.has(item.id) || item.status === 'draft') continue;
        try {
          const detail = await correspondenceApi.get(item.id);
          const opened = await openCorrespondence(detail);
          if (opened.state === 'ok' && !cancelled) {
            found.set(item.id, opened.stored.content.subject);
            setSubjects(new Map(found));
          }
        } catch {
          // يُترك مشفّرًا؛ صفحة التفاصيل تعرض السبب.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [items]);
  return subjects;
}

function sameEntries(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of b) if (a.get(k) !== v) return false;
  return true;
}

function counterpart(item: CorrespondenceSummary, folder: Folder): string {
  if (folder === 'sent' || folder === 'drafts' || item.my_kind === 'from') {
    const to = item.participants.filter((p) => p.kind === 'to').map((p) => p.user.full_name);
    const more = item.participants.length - to.length;
    return `إلى: ${to.join('، ')}${more > 0 ? ` (+${more})` : ''}`;
  }
  return item.sender.full_name;
}

function Row({ item, folder, subject }: { item: CorrespondenceSummary; folder: Folder; subject?: string }) {
  const unread = item.my_kind !== 'from' && !item.read_at;
  const overdue = item.due_date && item.status === 'sent' && new Date(item.due_date) < new Date();
  return (
    <Link
      to={`/correspondence/${item.id}`}
      className={cn(
        'flex items-center gap-3 border-b border-gray-100 px-4 py-3 text-sm transition-colors last:border-0 hover:bg-gray-50',
        unread && 'bg-primary-50/40',
      )}
    >
      <span className={cn('h-2 w-2 shrink-0 rounded-full', unread ? 'bg-primary-600' : 'bg-transparent')} />
      <div className="w-44 shrink-0 truncate">
        <span className={cn(unread ? 'font-semibold text-gray-900' : 'text-gray-700')}>{counterpart(item, folder)}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {item.reply_to_id && <Reply className="h-3.5 w-3.5 shrink-0 text-gray-400" />}
          {item.is_forward && <Forward className="h-3.5 w-3.5 shrink-0 text-gray-400" />}
          {subject !== undefined ? (
            <span className={cn('truncate', unread ? 'font-semibold text-gray-900' : 'text-gray-800')}>
              {subject || '(بلا عنوان)'}
            </span>
          ) : (
            <span className="flex items-center gap-1 truncate text-gray-400">
              <Lock className="h-3.5 w-3.5" />
              {item.status === 'draft' ? 'لم يكتمل إرسالها' : 'مشفّرة — جارٍ الفك على جهازك'}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
          <span dir="ltr">{item.reference_number ?? '—'}</span>
          <PriorityBadge priority={item.priority} />
          <ClassificationBadge classification={item.classification} />
          {item.due_date && (
            <span className={cn(overdue ? 'text-red-600' : 'text-gray-500')}>الاستحقاق: {formatDay(item.due_date)}</span>
          )}
          {item.status === 'closed' && <span className="text-gray-400">مغلقة</span>}
        </div>
      </div>
      {item.is_important && <Star className="h-4 w-4 shrink-0 fill-amber-400 text-amber-400" />}
      <span className="w-36 shrink-0 text-end text-xs text-gray-500">{formatDate(item.sent_at ?? item.created_at)}</span>
    </Link>
  );
}

function FolderList({ folder }: { folder: Folder }) {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [priority, setPriority] = useState<Priority | ''>('');
  const [unread, setUnread] = useState(false);

  useEffect(() => setPage(1), [folder, query, priority, unread]);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['correspondences', folder, page, query, priority, unread],
    queryFn: () => correspondenceApi.list({ folder, page, q: query, priority, unread }),
    placeholderData: keepPreviousData,
    refetchInterval: 20_000,
  });
  const items = data?.results ?? NO_ITEMS;
  const subjects = useSubjects(items);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-gray-900">{FOLDER_LABELS[folder]}</h2>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(q.trim());
          }}
        >
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-3 h-4 w-4 text-gray-400" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="بحث بالرقم المرجعي"
              className="w-56 ps-9"
              dir="auto"
              aria-label="بحث بالرقم المرجعي"
            />
          </div>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority | '')}
            className="h-10 rounded-lg border border-gray-300 bg-white px-2 text-sm"
            aria-label="الأولوية"
          >
            <option value="">كل الأولويات</option>
            <option value="urgent">عاجلة</option>
            <option value="high">عالية</option>
            <option value="normal">عادية</option>
            <option value="low">منخفضة</option>
          </select>
          {folder !== 'sent' && folder !== 'drafts' && (
            <label className="flex items-center gap-1.5 text-sm text-gray-600">
              <input type="checkbox" checked={unread} onChange={(e) => setUnread(e.target.checked)} className="accent-primary-600" />
              غير المقروءة
            </label>
          )}
          <Button type="submit" variant="outline">
            بحث
          </Button>
        </form>
      </div>
      <p className="text-xs text-gray-500">
        بحث الخادم يقتصر على البيانات الوصفية (الرقم المرجعي)؛ المحتوى مشفّر ولا يُفهرس على الخادم.
      </p>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : error ? (
        <Card className="p-6 text-sm text-red-600">{toUserMessage(error, 'تعذر تحميل المراسلات')}</Card>
      ) : items.length === 0 ? (
        <EmptyState icon={Inbox} title="لا توجد مراسلات" description={query ? 'لا نتائج مطابقة للبحث' : undefined} />
      ) : (
        <Card className="overflow-hidden">
          {items.map((item) => (
            <Row key={item.id} item={item} folder={folder} subject={subjects.get(item.id)} />
          ))}
        </Card>
      )}

      {data && data.count > items.length && (
        <div className="flex items-center justify-center gap-3 text-sm text-gray-600">
          <Button variant="outline" size="sm" disabled={!data.previous || isFetching} onClick={() => setPage((p) => p - 1)}>
            <ChevronRight className="h-4 w-4" />
            السابق
          </Button>
          <span>صفحة {page}</span>
          <Button variant="outline" size="sm" disabled={!data.next || isFetching} onClick={() => setPage((p) => p + 1)}>
            التالي
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

export function FolderPage({ folder }: { folder: Folder }) {
  return (
    <CryptoGate>
      <FolderList key={folder} folder={folder} />
    </CryptoGate>
  );
}
