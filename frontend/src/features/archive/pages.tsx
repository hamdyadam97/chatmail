import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Archive, Lock, Search } from 'lucide-react';
import { Button, Card, EmptyState, Input, Spinner } from '../../shared/ui';
import { apiFetch, toUserMessage } from '../../shared/api';
import { cn } from '../../shared/lib/cn';
import { formatDate } from '../correspondence/components';
import type { AttachmentMeta, ForwardedQuote } from '../correspondence/api';
import { AttachmentRow } from '../correspondence/DetailsPage';

interface ArchivedSummary {
  correspondence_id: string;
  reference_number: string | null;
  sent_at: string | null;
  sender: string;
  institute: string | null;
  priority: string;
  reply_to_id: string | null;
  subject: string;
}

interface ArchivedDetail extends ArchivedSummary {
  body: string;
  forwarded: ForwardedQuote | null;
  attachments: AttachmentMeta[];
}

interface Page<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

const archiveApi = {
  status: () => apiFetch<{ is_officer: boolean }>('/archive/'),
  list: (page: number, q: string) =>
    apiFetch<Page<ArchivedSummary>>(`/archive/items/?page=${page}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  get: (id: string) => apiFetch<ArchivedDetail>(`/archive/items/${id}/`),
};

function ItemViewer({ id }: { id: string }) {
  const { data, isLoading, error } = useQuery({ queryKey: ['archive-item', id], queryFn: () => archiveApi.get(id) });
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-gray-500">
        <Spinner size="sm" />
        جارٍ التحميل…
      </div>
    );
  }
  if (error || !data) return <p className="p-6 text-sm text-red-600">{toUserMessage(error, 'تعذر فتح المراسلة')}</p>;
  return (
    <div className="space-y-4 p-6" data-testid="archive-viewer">
      <div>
        <h3 className="break-words text-lg font-semibold text-gray-900">{data.subject || '(بلا عنوان)'}</h3>
        <p className="mt-1 text-xs text-gray-500">
          <span dir="ltr" className="font-mono">{data.reference_number}</span> · {data.sender}
          {data.institute && ` · ${data.institute}`} · {data.sent_at ? formatDate(data.sent_at) : ''}
        </p>
      </div>
      {/* نص صريح فقط — لا HTML */}
      <div className="whitespace-pre-wrap break-words text-sm leading-7 text-gray-800">{data.body || '—'}</div>
      {data.forwarded && (
        <div className="rounded-lg border-s-4 border-gray-300 bg-gray-50 p-4 text-sm">
          <p className="mb-1 text-xs text-gray-500">مراسلة محالة من {data.forwarded.sender_name}</p>
          <p className="font-medium">{data.forwarded.subject}</p>
          <p className="mt-1 whitespace-pre-wrap text-gray-700">{data.forwarded.body}</p>
        </div>
      )}
      {data.attachments.length > 0 && (
        <ul className="space-y-2">
          {data.attachments.map((a) => (
            <AttachmentRow key={a.id} meta={a} />
          ))}
        </ul>
      )}
      <p className="text-xs text-gray-400">سُجّل هذا الاطلاع في سجل التدقيق.</p>
    </div>
  );
}

function Items() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['archive-items', page, query],
    queryFn: () => archiveApi.list(page, query),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
      <Card className="overflow-hidden lg:col-span-2">
        <form
          className="relative border-b border-gray-200 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setQuery(q.trim());
          }}
        >
          <Search className="pointer-events-none absolute start-5 top-5 h-4 w-4 text-gray-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="الرقم المرجعي أو المرسل أو النص…" className="ps-8" aria-label="بحث في الأرشيف" />
        </form>
        {isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : !data || data.results.length === 0 ? (
          <EmptyState icon={Archive} title="لا مراسلات مؤرشفة" description="تظهر هنا المراسلات المصنّفة «قابلة للأرشفة المؤسسية»." />
        ) : (
          <ul>
            {data.results.map((c) => (
              <li key={c.correspondence_id}>
                <button
                  type="button"
                  onClick={() => setOpenId(c.correspondence_id)}
                  className={cn(
                    'w-full border-b border-gray-100 px-4 py-3 text-start text-sm hover:bg-gray-50',
                    openId === c.correspondence_id && 'bg-primary-50',
                  )}
                >
                  <div className="flex justify-between gap-2">
                    <span className="font-medium text-gray-900">{c.sender}</span>
                    <span className="text-xs text-gray-500">{c.sent_at ? formatDate(c.sent_at) : ''}</span>
                  </div>
                  <p className="truncate text-gray-700">{c.subject || '(بلا عنوان)'}</p>
                  <div className="flex justify-between gap-2 text-xs text-gray-500">
                    <span dir="ltr" className="font-mono">{c.reference_number}</span>
                    <span>{c.reply_to_id ? 'رد' : c.institute}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
        {data && (data.next || data.previous) && (
          <div className="flex justify-between border-t border-gray-200 p-2 text-xs">
            <Button variant="ghost" size="sm" disabled={!data.previous} onClick={() => setPage((p) => p - 1)}>السابق</Button>
            <Button variant="ghost" size="sm" disabled={!data.next} onClick={() => setPage((p) => p + 1)}>التالي</Button>
          </div>
        )}
      </Card>
      <Card className="min-h-[16rem] lg:col-span-3">
        {openId ? (
          <ItemViewer key={openId} id={openId} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-sm text-gray-400">
            <Lock className="h-8 w-8" />
            اختر مراسلة لعرضها (يُسجَّل كل اطلاع)
          </div>
        )}
      </Card>
    </div>
  );
}

export function ArchivePage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['archive-status'], queryFn: archiveApi.status });
  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }
  if (error) return <Card className="p-6 text-sm text-red-600">{toUserMessage(error, 'تعذر تحميل الأرشيف')}</Card>;
  if (!data?.is_officer) {
    return (
      <EmptyState
        icon={Archive}
        title="الأرشيف المركزي لضباط الأرشيف"
        description="يفتح هذه الصفحة من أُسند إليه دور «ضابط الأرشيف المؤسسي» مركزيًا."
        className="mx-auto mt-8 max-w-lg"
      />
    );
  }
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">الأرشيف المركزي</h2>
        <p className="text-xs text-gray-500">
          المراسلات المصنّفة «قابلة للأرشفة المؤسسية» وردودها فقط. كل فتح يُسجَّل في سجل التدقيق.
        </p>
      </div>
      <Items />
    </div>
  );
}
