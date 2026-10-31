import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Trash2 } from 'lucide-react';
import { Button, Card, EmptyState, Spinner } from '../../shared/ui';
import { correspondenceApi } from './api';
import { CryptoGate, formatDate } from './components';
import { deleteDraft, listDrafts, type LocalDraft } from './drafts';

function Drafts() {
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<LocalDraft[] | null>(null);
  const reload = () => listDrafts().then(setDrafts).catch(() => setDrafts([]));
  useEffect(() => {
    void reload();
  }, []);

  // صفوف أُعدّت على الخادم ولم يكتمل إرسالها (انقطاع أثناء الإرسال مثلًا).
  const { data: unsent } = useQuery({
    queryKey: ['correspondences', 'drafts'],
    queryFn: () => correspondenceApi.list({ folder: 'drafts' }),
  });

  if (drafts === null) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  const stale = unsent?.results ?? [];
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <h2 className="text-lg font-semibold text-gray-900">المسودات</h2>
      <p className="text-xs text-gray-500">
        المسودات محفوظة على هذا الجهاز فقط ومشفّرة محليًا؛ لا تُرفع إلى الخادم ولا تظهر على أجهزتك الأخرى.
      </p>
      {drafts.length === 0 ? (
        <EmptyState icon={FileText} title="لا مسودات على هذا الجهاز" />
      ) : (
        <Card className="overflow-hidden">
          {drafts.map((d) => (
            <div key={d.id} className="flex items-center gap-3 border-b border-gray-100 px-4 py-3 text-sm last:border-0">
              <Link to={`/mail/drafts/compose?draft=${d.id}`} className="min-w-0 flex-1 hover:text-primary-700">
                <p className="truncate font-medium text-gray-900">{d.subject || '(بلا عنوان)'}</p>
                <p className="truncate text-xs text-gray-500">{d.body.slice(0, 120)}</p>
              </Link>
              <span className="text-xs text-gray-400">{formatDate(d.updated_at)}</span>
              <Button
                variant="ghost"
                size="sm"
                aria-label="حذف المسودة"
                onClick={() => void deleteDraft(d.id).then(reload)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </Card>
      )}

      {stale.length > 0 && (
        <Card className="space-y-2 p-5">
          <h3 className="text-sm font-semibold text-gray-900">مراسلات لم يكتمل إرسالها</h3>
          <p className="text-xs text-gray-500">أُعدّت على الخادم دون محتوى، ولا يراها المستلمون. يمكنك حذفها وإعادة الإرسال.</p>
          {stale.map((item) => (
            <div key={item.id} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm">
              <span>
                إلى {item.participants.filter((p) => p.kind === 'to').map((p) => p.user.full_name).join('، ')} —{' '}
                {formatDate(item.created_at)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void correspondenceApi
                    .discard(item.id)
                    .then(() => queryClient.invalidateQueries({ queryKey: ['correspondences'] }))
                }
              >
                <Trash2 className="h-4 w-4" />
                حذف
              </Button>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

export function DraftsPage() {
  return (
    <CryptoGate>
      <Drafts />
    </CryptoGate>
  );
}
