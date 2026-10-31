import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { FileText, Globe, Megaphone, MessageCircle, Search as SearchIcon } from 'lucide-react';
import { Button, Card, EmptyState, Input, Spinner } from '../../shared/ui';
import { apiFetch, toUserMessage } from '../../shared/api';

type Kind = 'correspondence' | 'announcement' | 'external' | 'chat';

interface SearchHit {
  kind: Kind;
  id: string;
  title: string;
  snippet: string;
  meta: string;
  date: string | null;
  link: string;
}

const KIND_META: Record<Kind, { label: string; icon: typeof FileText }> = {
  correspondence: { label: 'مراسلة', icon: FileText },
  announcement: { label: 'تعميم', icon: Megaphone },
  external: { label: 'بريد خارجي', icon: Globe },
  chat: { label: 'محادثة', icon: MessageCircle },
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** إبراز كلمات البحث كما كُتبت (الخادم يطابق مع توحيد الحروف العربية). */
function Highlight({ text, query }: { text: string; query: string }) {
  const words = query.split(/\s+/).filter((w) => w.length > 1).map(escapeRe);
  if (words.length === 0) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.join('|')})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-amber-100 px-0.5 text-gray-900">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function formatDate(iso?: string | null): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('ar', { dateStyle: 'medium' }).format(new Date(iso));
}

export function SearchPage() {
  const location = useLocation();
  const initial = (location.state as { q?: string } | null)?.q ?? '';
  const [q, setQ] = useState(initial);
  const [searched, setSearched] = useState('');
  const [kind, setKind] = useState<Kind | ''>('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (query: string) => {
    const text = query.trim();
    if (text.length < 2) {
      setHits(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ q: text });
      if (kind) params.set('kind', kind);
      const data = await apiFetch<{ results: SearchHit[] }>(`/search/?${params}`);
      setHits(data.results);
      setSearched(text);
    } catch (err) {
      setError(toUserMessage(err, 'تعذر البحث'));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void run(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">البحث في المحتوى</h2>
        <p className="mt-1 text-xs text-gray-500">يبحث في بريدك ومحادثاتك وتعاميمك فقط — ما يحق لك قراءته.</p>
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
            placeholder="ابحث في العناوين والنصوص والأرقام المرجعية والمحادثات…"
            className="ps-9"
            autoFocus
            aria-label="نص البحث"
            autoComplete="off"
          />
        </div>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as Kind | '')}
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

      {error && <p className="text-sm text-red-600">{error}</p>}
      {busy && hits === null ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : hits === null ? null : hits.length === 0 ? (
        <EmptyState icon={SearchIcon} title="لا نتائج" description="جرّب كلمات أخرى." />
      ) : (
        <Card className="overflow-hidden">
          {hits.map((hit) => {
            const meta = KIND_META[hit.kind];
            return (
              <Link key={`${hit.kind}:${hit.id}`} to={hit.link} className="block border-b border-gray-100 px-4 py-3 last:border-0 hover:bg-gray-50">
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <meta.icon className="h-3.5 w-3.5" />
                  <span>{meta.label}</span>
                  {hit.meta && <span>· {hit.meta}</span>}
                  {hit.date && <span className="ms-auto">{formatDate(hit.date)}</span>}
                </div>
                {hit.title && (
                  <p className="mt-1 font-medium text-gray-900">
                    <Highlight text={hit.title} query={searched} />
                  </p>
                )}
                <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-sm text-gray-600">
                  <Highlight text={hit.snippet} query={searched} />
                </p>
              </Link>
            );
          })}
        </Card>
      )}
    </div>
  );
}
