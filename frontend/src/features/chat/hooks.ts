/**
 * خطافات صغيرة لواجهة المحادثة — كلها تفك عبر crypto/mls (لا نصوص صريحة
 * خارج الذاكرة ولا خارج طبقة crypto).
 */
import { useEffect, useState } from 'react';
import { decryptTitle, getChatSeq } from '../../crypto/mls';
import { useAuth } from '../auth/AuthContext';
import { chatApi, type Conversation } from './api';

const DM_FALLBACK = 'محادثة مباشرة';
const GROUP_FALLBACK = 'محادثة جماعية';

/** يفك عنوان المحادثة؛ عند العجز يعود لعنوان احتياطي (مثلًا انضممنا متأخرين). */
export function useConversationTitle(conversation: Conversation | null | undefined): string {
  const { user } = useAuth();
  const [title, setTitle] = useState<string>(conversation?.title_plain ?? '');
  useEffect(() => {
    let cancelled = false;
    if (!conversation) {
      setTitle('');
      return;
    }
    if (conversation.title_plain) {
      setTitle(conversation.title_plain);
      return;
    }
    // المحادثة المباشرة تُسمّى باسم الطرف الآخر (كما في Slack).
    if (conversation.type === 'dm') {
      const other = conversation.members?.find((m) => String(m.id) !== String(user?.id));
      setTitle(other ? other.full_name || other.username : DM_FALLBACK);
      return;
    }
    setTitle(GROUP_FALLBACK);
    if (!conversation.title_enc) return;
    decryptTitle(conversation)
      .then((decrypted) => {
        if (!cancelled && decrypted) setTitle(decrypted);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [conversation, user?.id]);
  return title;
}

/** غير المقروء: وجود رسائل بـ seq أكبر من آخر seq قُرئ. */
export function useUnread(conversationId: number | string | null): boolean {
  const [unread, setUnread] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const onRead = (e: Event) => {
      if (String((e as CustomEvent<{ id: string }>).detail?.id) === String(conversationId)) {
        setUnread(false);
        setNonce((n) => n + 1);
      }
    };
    window.addEventListener('chat-read', onRead);
    return () => window.removeEventListener('chat-read', onRead);
  }, [conversationId]);
  useEffect(() => {
    let cancelled = false;
    if (conversationId === null) return;
    getChatSeq(conversationId)
      .then(({ last_read_seq }) => chatApi.getMessages(conversationId, last_read_seq, 1))
      .then((page) => {
        if (!cancelled) setUnread(page.messages.length > 0);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [conversationId, nonce]);
  return unread;
}
