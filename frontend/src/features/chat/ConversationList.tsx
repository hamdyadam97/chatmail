import { useNavigate } from 'react-router-dom';
import { MessageCircle } from 'lucide-react';
import { cn } from '../../shared/lib/cn';
import { Card } from '../../shared/ui';
import { EmptyState } from '../../shared/ui';
import type { Conversation } from './api';
import { useConversationTitle, useUnread } from './hooks';

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: number | string | null;
  onSelect: (conversation: Conversation) => void;
}

function ConversationListItem({
  conversation,
  selected,
  onSelect,
}: {
  conversation: Conversation;
  selected: boolean;
  onSelect: () => void;
}) {
  const title = useConversationTitle(conversation);
  const unread = useUnread(conversation.id);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center justify-between gap-2 rounded-lg px-3 py-3 text-start transition-colors',
        selected ? 'bg-primary-50 text-primary-800' : 'text-gray-700 hover:bg-gray-100',
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <MessageCircle className="h-4 w-4 shrink-0 opacity-60" />
        <span className="truncate text-sm font-medium">{title}</span>
      </span>
      {unread && <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-primary-500" aria-label="رسائل غير مقروءة" />}
    </button>
  );
}

export function ConversationList({ conversations, selectedId, onSelect }: ConversationListProps) {
  const navigate = useNavigate();
  if (conversations.length === 0) {
    return (
      <EmptyState
        icon={MessageCircle}
        title="لا محادثات بعد"
        description="أنشئ محادثة جديدة لبدء المراسلة المشفرة"
        action={
          <button type="button" className="text-sm font-medium text-primary-600 hover:underline" onClick={() => navigate('/compose')}>
            الانتقال إلى إنشاء مراسلة
          </button>
        }
        className="h-full"
      />
    );
  }
  return (
    <Card className="flex h-full flex-col gap-1 overflow-y-auto p-2">
      {conversations.map((conversation) => (
        <ConversationListItem
          key={String(conversation.id)}
          conversation={conversation}
          selected={String(conversation.id) === String(selectedId)}
          onSelect={() => onSelect(conversation)}
        />
      ))}
    </Card>
  );
}
