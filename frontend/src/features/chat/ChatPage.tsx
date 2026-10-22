import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import { Button, Card, Spinner } from '../../shared/ui';
import { resetCryptoBootstrap, useCryptoBootstrap } from '../../crypto/useCryptoBootstrap';
import { chatApi, type Conversation } from './api';
import { ConversationList } from './ConversationList';
import { ThreadView } from './ThreadView';
import { NewConversationDialog } from './NewConversationDialog';
import { MemberManager } from './MemberManager';

interface ChatPageProps {
  type: 'dm' | 'group';
}

/** صفحة المحادثات الموحدة (مباشرة/جماعية) — قائمة + خيط واحد مشترك. */
export function ChatPage({ type }: ChatPageProps) {
  const bootstrap = useCryptoBootstrap();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<number | string | null>(params.get('c'));
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data: conversations, isLoading } = useQuery({
    queryKey: ['conversations'],
    queryFn: chatApi.listConversations,
    refetchInterval: 15_000,
    enabled: bootstrap.status === 'ready',
  });

  const filtered = (conversations ?? []).filter((c) => c.type === type);

  // رابط من البحث المحلي (?c=) لمحادثة من النوع الآخر ← صفحتها الصحيحة.
  useEffect(() => {
    const wanted = params.get('c');
    const target = wanted ? (conversations ?? []).find((c) => String(c.id) === wanted) : undefined;
    if (target && target.type !== type) {
      navigate(`${target.type === 'group' ? '/group-chats' : '/direct-messages'}?c=${wanted}`, { replace: true });
    }
  }, [conversations, params, type, navigate]);
  const selected: Conversation | undefined =
    filtered.find((c) => String(c.id) === String(selectedId)) ?? filtered[0];

  if (bootstrap.status === 'loading') {
    return (
      <div className="flex h-[calc(100vh-7rem)] items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (bootstrap.status === 'error') {
    return (
      <Card className="mx-auto mt-10 flex max-w-md flex-col items-center gap-3 p-8 text-center">
        <p className="text-sm text-red-600">{bootstrap.message}</p>
        <Button
          variant="outline"
          onClick={() => {
            resetCryptoBootstrap();
            window.location.reload();
          }}
        >
          <RefreshCw className="h-4 w-4" />
          إعادة المحاولة
        </Button>
      </Card>
    );
  }

  if (bootstrap.status === 'pending_approval') {
    return (
      <Card className="mx-auto mt-10 max-w-md p-8 text-center">
        <h3 className="text-base font-semibold text-gray-900">هذا الجهاز بانتظار الاعتماد</h3>
        <p className="mt-2 text-sm text-gray-500">
          اعمد هذا الجهاز من أحد أجهزتك الموثّقة من صفحة الأجهزة ليُفعَّل التشفير الطرف-لطرف عليه.
        </p>
        <Button variant="outline" className="mt-4" onClick={() => (window.location.href = '/devices')}>
          الانتقال إلى الأجهزة
        </Button>
      </Card>
    );
  }

  return (
    <div className="flex h-[calc(100vh-7rem)] gap-4">
      <div className="flex w-72 shrink-0 flex-col gap-2">
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4" />
          {type === 'dm' ? 'محادثة مباشرة جديدة' : 'محادثة جماعية جديدة'}
        </Button>
        <div className="min-h-0 flex-1">
          {isLoading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          ) : (
            <ConversationList
              conversations={filtered}
              selectedId={selected?.id ?? null}
              onSelect={(conversation) => setSelectedId(conversation.id)}
            />
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {selected ? (
          <>
            <div className="min-h-0 flex-1">
              <ThreadView conversation={selected} currentDeviceId={bootstrap.deviceId} />
            </div>
            {selected.type === 'group' && selected.my_role === 'admin' && (
              <MemberManager conversation={selected} />
            )}
          </>
        ) : (
          <Card className="flex h-full items-center justify-center p-10 text-center text-sm text-gray-400">
            اختر محادثة من القائمة أو أنشئ محادثة جديدة
          </Card>
        )}
      </div>

      {dialogOpen && (
        <NewConversationDialog
          type={type}
          onClose={() => setDialogOpen(false)}
          onCreated={(conversation) => {
            setDialogOpen(false);
            setSelectedId(conversation.id);
            void queryClient.invalidateQueries({ queryKey: ['conversations'] });
          }}
        />
      )}
    </div>
  );
}
