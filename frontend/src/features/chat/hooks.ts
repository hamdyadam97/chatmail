/** خطافات صغيرة لواجهة المحادثة. */
import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { chatApi, type Conversation } from './api';

const DM_FALLBACK = 'محادثة مباشرة';
const GROUP_FALLBACK = 'محادثة جماعية';

/** المحادثة المباشرة تُسمّى باسم الطرف الآخر (كما في Slack)، والجماعية بعنوانها. */
export function useConversationTitle(conversation: Conversation | null | undefined): string {
  const { user } = useAuth();
  if (!conversation) return '';
  if (conversation.type === 'dm') {
    const other = conversation.members?.find((m) => String(m.id) !== String(user?.id));
    return other ? other.full_name || other.username : DM_FALLBACK;
  }
  return conversation.title || GROUP_FALLBACK;
}

/** غير المقروء: وجود رسائل بـ seq أكبر من آخر seq قُرئ (موضع القراءة على الخادم). */
export function useUnread(conversation: Conversation | null): boolean {
  const [unread, setUnread] = useState(false);
  const [readSeq, setReadSeq] = useState(conversation?.last_read_seq ?? 0);
  const id = conversation?.id ?? null;
  useEffect(() => setReadSeq(conversation?.last_read_seq ?? 0), [conversation?.last_read_seq]);
  useEffect(() => {
    const onRead = (e: Event) => {
      const detail = (e as CustomEvent<{ id: string; seq: number }>).detail;
      if (String(detail?.id) === String(id)) {
        setUnread(false);
        setReadSeq((s) => Math.max(s, detail.seq ?? s));
      }
    };
    window.addEventListener('chat-read', onRead);
    return () => window.removeEventListener('chat-read', onRead);
  }, [id]);
  useEffect(() => {
    let cancelled = false;
    if (id === null) return;
    chatApi
      .getMessages(id, { afterSeq: readSeq, limit: 1 })
      .then((page) => {
        if (!cancelled) setUnread(page.messages.length > 0);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id, readSeq]);
  return unread;
}
