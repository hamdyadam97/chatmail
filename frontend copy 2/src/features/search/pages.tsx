import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { FileText, Lock, Megaphone, MessageCircle, RefreshCw, Search as SearchIcon, Globe } from 'lucide-react';
import { Button, Card, EmptyState, Input, Spinner } from '../../shared/ui';
import { cn } from '../../shared/lib/cn';
import { CryptoGate } from '../correspondence/components';
import { decryptEverything, getLocalIndex, invalidateLocalIndex, type IndexProgress } from './localSearch';
import { highlightParts, type SearchDoc, type SearchHit } from './searchIndex';

const KIND_META: Record<SearchDoc['kind'], { label: string; icon: typeof FileText }> = {
  correspondence: { label: 'مراسلة', icon: FileText },
  announcement: { label: 'تعميم', icon: Megaphone },
  external: { label: 'بريد خارجي', icon: Globe },
  chat: { label: 'محادثة', icon: MessageCircle },
};

function Highlight({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, i) =>
        part.match ? (
          <mark key={i} className="rounded bg-amber-100 px-0.5 text-gray-900">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

function formatDate(iso?: string | null): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('ar', { dateStyle: 'medium' }).format(new Date(iso));
}

function SearchView() {
  const location = useLocation();
  const initial = (location.state as { q?: string } | null)?.q ?? '';
  const [q, setQ] = useState(initial);
  const [kind, setKind] = useState<SearchDoc['kind'] | ''>('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [indexSize, setIndexSize] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<IndexProgress | null>(null);

  const run = async (query: string, force = false) => {
    setBusy(true);
    try {
      const index = await getLocalIndex(force);
      setIndexSize(index.size);
      setHits(query.trim() ? index.search(query, 100, kind || undefined) : null);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void run(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const indexAll = async () => {
    setProgress({ done: 0, total: 0, failed: 0 });
    const final = await decryptEverything(setProgress);
    setProgress(final);
    invalidateLocalIndex();
    await run(q, true);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">البحث في المحتوى</h2>
        <p className="mt-1 flex items-start gap-1.5 text-xs text-gray-500">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
          البحث يجري على جهازك فقط في المحتوى الذي فُك عليه؛ لا يُرسل أي مصطلح بحث إلى الخادم، والفهرس في الذاكرة ويُمحى بإغلاق
          الصفحة. للبحث بالرقم المرجعي على الخادم استخدم بحث صناديق المراسلات.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(q);
        }}
        className="flex flex-wrap gap-2"
      >
        <div className="relative min-w-[16rem] flex-1">
          <SearchIcon className="pointer-events-none absolute start-3 top-3 h-4 w-4 text-gray-400" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ابحث في العناوين والنصوص وأسماء المرفقات والمحادثات…"
            className="ps-9"
            autoFocus
            aria-label="نص البحث"
            autoComplete="off"
          />
        </div>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as SearchDoc['kind'] | '')}
          className="h-10 rounded-lg border border-gray-300 bg-white px-2 text-sm"
          aria-label="النوع"
        >
          <option value="">الكل</option>
          <option value="correspondence">المراسلات</option>
          <option value="announcement">التعاميم</option>
          <option value="external">البريد الخارجي</option>
          <option value="chat">المحادثات</option>
        </select>
        <Button type="submit" loading={busy}>
          بحث
        </Button>
      </form>

      <Card className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
        <span className="text-gray-600">
          {indexSize === null ? '…' : `${indexSize} عنصرًا مفهرسًا على هذا الجهاز.`}{' '}
          {progress && progress.total > 0 && (
            <span className="text-gray-500">
              فُك {progress.done}/{progress.total}
              {progress.failed > 0 && ` (تعذر ${progress.failed} — غالبًا سابقة لإضافة هذا الجهاز)`}
            </span>
          )}
        </span>
        <Button variant="outline" size="sm" onClick={() => void indexAll()} disabled={Boolean(progress && progress.done < progress.total)}>
          <RefreshCw className={cn('h-4 w-4', progress && progress.done < progress.total && 'animate-spin')} />
          فك وفهرسة كل مراسلاتي وتعاميمي
        </Button>
      </Card>

      {busy && hits === null ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : hits === null ? null : hits.length === 0 ? (
        <EmptyState icon={SearchIcon} title="لا نتائج" description="جرّب كلمات أخرى، أو فك وفهرسة كل المراسلات أولًا." />
      ) : (
        <Card className="overflow-hidden">
          {hits.map(({ doc, snippet }) => {
            const Kind = KIND_META[doc.kind];
            return (
              <Link key={doc.id} to={doc.link} className="block border-b border-gray-100 px-4 py-3 last:border-0 hover:bg-gray-50">
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <Kind.icon className="h-3.5 w-3.5" />
                  <span>{Kind.label}</span>
                  {doc.meta && <span>· {doc.meta}</span>}
                  {doc.date && <span className="ms-auto">{formatDate(doc.date)}</span>}
                </div>
                {doc.title && (
                  <p className="mt-1 font-medium text-gray-900">
                    <Highlight text={doc.title} query={q} />
                  </p>
                )}
                <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-sm text-gray-600">
                  <Highlight text={snippet} query={q} />
                </p>
              </Link>
            );
          })}
        </Card>
      )}
    </div>
  );
}

export function SearchPage() {
  return (
    <CryptoGate>
      <SearchView />
    </CryptoGate>
  );
}
