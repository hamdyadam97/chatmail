import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Reply, RotateCcw, Send, ShieldAlert } from 'lucide-react';
import { cn } from '../../shared/lib/cn';
import { Button, Card, Input, Spinner } from '../../shared/ui';
import { ApiError } from '../../shared/api';
import { useAuth } from '../auth/AuthContext';
import {
  attachSeqToSent,
  encryptMessage,
  feedMessages,
  getSentMessage,
  saveSentMessage,
  setLastReadSeq,
  syncConversation,
} from '../../crypto/mls';
import { uuid4 } from '../../crypto/encoding';
import { getRecord, putRecord } from '../../crypto/keystore';
import type { ChatLogRecord } from './chatlog';
import { chatApi, conversationWsUrl, type Conversation, type Message } from './api';
import { ChatSocket, type ChatEvent } from './ws';
import { useConversationTitle } from './hooks';

interface ViewMessage {
  key: string;
  seq: number | null;
  kind: string;
  /** مرسلة من حسابي (أي جهاز من أجهزتي). */
  mine: boolean;
  /** من جهازي الحالي تحديدًا (لدينا نصها محليًا). */
  fromThisDevice: boolean;
  plaintext?: string;
  failed: boolean;
  state: 'sending' | 'sent' | 'failed';
  replyToSeq?: number | null;
  createdAt: string;
  clientMsgId?: string;
  senderUserId: number | string;
}

interface ThreadViewProps {
  conversation: Conversation;
  currentDeviceId: number | string;
}

function isEpochConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}

/**
 * يبني صفوف العرض. فك MLS لمرة واحدة: ما فُك الآن يُحفظ مغلّفًا في `chatlog`
 * ويُقرأ منه لاحقًا (إعادة التحميل، البحث المحلي). رسائل أجهزتي الأخرى تُفك
 * كأي رسالة واردة؛ رسائل هذا الجهاز من مخزن `sent`.
 */
async function viewFromMessages(
  conversation: Pick<Conversation, 'id' | 'type'>,
  messages: Message[],
  feedDecrypted: Map<number, { plaintext?: string; failed: boolean }>,
  meId: number | string,
  deviceId: number | string,
): Promise<ViewMessage[]> {
  const out: ViewMessage[] = [];
  for (const message of messages) {
    if (message.kind !== 'application') continue; // welcome/commit/proposal صفوف داخلية
    const mine = String(message.sender_user_id) === String(meId);
    const fromThisDevice = String(message.sender_device_id) === String(deviceId);
    const logKey = `${conversation.id}:${message.seq}`;
    const fresh = feedDecrypted.get(message.seq);
    let plaintext: string | undefined;
    if (fromThisDevice && message.client_msg_id) {
      plaintext = (await getSentMessage(message.client_msg_id))?.plaintext;
    } else if (fresh?.plaintext !== undefined) {
      plaintext = fresh.plaintext;
      await putRecord('chatlog', logKey, {
        conversation_id: String(conversation.id),
        conversation_type: conversation.type,
        seq: message.seq,
        sender_user_id: String(message.sender_user_id),
        created_at: message.created_at,
        plaintext,
      } satisfies ChatLogRecord);
    } else {
      plaintext = (await getRecord<ChatLogRecord>('chatlog', logKey))?.plaintext;
    }
    if (!mine) {
      const decrypted = plaintext === undefined ? fresh : undefined;
      out.push({
        key: `seq:${message.seq}`,
        seq: message.seq,
        kind: message.kind,
        mine: false,
        fromThisDevice: false,
        plaintext,
        failed: plaintext === undefined && (decrypted?.failed ?? false),
        state: 'sent',
        replyToSeq: message.reply_to_seq ?? null,
        createdAt: message.created_at,
        senderUserId: message.sender_user_id,
      });
    } else {
      out.push({
        key: message.client_msg_id ? `own:${message.client_msg_id}` : `seq:${message.seq}`,
        seq: message.seq,
        kind: message.kind,
        mine: true,
        fromThisDevice,
        plaintext,
        failed: false,
        state: 'sent',
        replyToSeq: message.reply_to_seq ?? null,
        createdAt: message.created_at,
        senderUserId: message.sender_user_id,
      });
    }
  }
  return out;
}

export function ThreadView({ conversation, currentDeviceId }: ThreadViewProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const title = useConversationTitle(conversation);

  const [messages, setMessages] = useState<ViewMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [replyTo, setReplyTo] = useState<ViewMessage | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const socketRef = useRef<ChatSocket | null>(null);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;

  const loadInitial = useCallback(async () => {
    const current = conversationRef.current;
    setLoading(true);
    try {
      const page = await chatApi.getMessages(current.id, 0, 200);
      const feed = await feedMessages(current, page.messages, currentDeviceId);
      const view = await viewFromMessages(current, page.messages, feed.decrypted, user!.id, currentDeviceId);
      setMessages(view);
      const maxSeq = page.messages.reduce((m, msg) => Math.max(m, msg.seq), 0);
      if (maxSeq > 0) {
        await setLastReadSeq(current.id, maxSeq);
        window.dispatchEvent(new CustomEvent('chat-read', { detail: { id: String(current.id) } }));
      }
    } catch (err) {
      setBanner(err instanceof Error ? err.message : 'تعذر تحميل الرسائل');
    } finally {
      setLoading(false);
    }
  }, [currentDeviceId, user]);

  const handleIncoming = useCallback(
    async (event: Extract<ChatEvent, { event: 'message' }>) => {
      const current = conversationRef.current;
      const asMessage: Message = {
        seq: event.seq,
        kind: event.kind as Message['kind'],
        sender_user_id: event.sender_user_id,
        sender_device_id: event.sender_device_id,
        epoch: event.epoch,
        mls_payload: event.mls_payload,
        reply_to_seq: event.reply_to_seq ?? null,
        client_msg_id: event.client_msg_id,
        created_at: event.created_at,
      };
      try {
        const feed = await feedMessages(current, [asMessage], currentDeviceId);
        const view = await viewFromMessages(current, [asMessage], feed.decrypted, user!.id, currentDeviceId);
        setMessages((prev) => {
          const known = new Set(prev.map((m) => m.key));
          // رسالتنا نحن (تأكيد متفائل): نحدّث الحالة بدل إضافة نسخة مكررة
          const merged = prev.map((m) => {
            if (m.state === 'sending' && m.clientMsgId && m.clientMsgId === asMessage.client_msg_id) {
              void attachSeqToSent(m.clientMsgId, asMessage.seq);
              return { ...m, seq: asMessage.seq, state: 'sent' as const };
            }
            return m;
          });
          const echoKeys = new Set(
            prev.filter((m) => m.clientMsgId).map((m) => `own:${m.clientMsgId}`),
          );
          const fresh = view.filter((m) => !known.has(m.key) && !echoKeys.has(m.key));
          return [...merged, ...fresh];
        });
        await setLastReadSeq(current.id, event.seq);
        window.dispatchEvent(new CustomEvent('chat-read', { detail: { id: String(current.id) } }));
      } catch {
        // لا نكسر الخيط على خطأ معالجة — ستُعالج عند إعادة المزامنة.
      }
    },
    [currentDeviceId, user],
  );

  // التحميل الأولي + مقبس WS. يعاد الاتصال فقط عند تغيّر المحادثة المفتوحة
  // (كائن المحادثة نفسه يتجدد مع كل تحديث للقائمة فلا نريد إعادة اتصال دورية).
  useEffect(() => {
    void loadInitial();
    const id = conversationRef.current.id;
    const socket = new ChatSocket(
      id,
      () => chatApi.wsTicket(id).then((r) => r.ticket),
      conversationWsUrl,
      {
        onEvent: (event: ChatEvent) => {
          if (event.event === 'message') {
            void handleIncoming(event);
          } else {
            setBanner(
              event.event === 'member_added'
                ? 'انضم عضو جديد إلى المحادثة — جارٍ تحديث المجموعة'
                : 'غادر عضو المحادثة — جارٍ تحديث المجموعة',
            );
            void queryClient.invalidateQueries({ queryKey: ['conversations'] });
          }
        },
        onResync: () => void loadInitial(),
        onDeviceRevoked: () => setRevoked(true),
      },
    );
    socketRef.current = socket;
    socket.connect();
    return () => socket.close();
  }, [conversation.id, loadInitial, handleIncoming, queryClient]);

  const doSend = useCallback(
    async (text: string, clientMsgId: string, replyToSeq: number | null) => {
      const optimistic: ViewMessage = {
        key: `own:${clientMsgId}`,
        seq: null,
        kind: 'application',
        mine: true,
        fromThisDevice: true,
        plaintext: text,
        failed: false,
        state: 'sending',
        replyToSeq,
        createdAt: new Date().toISOString(),
        clientMsgId,
        senderUserId: user!.id,
      };
      setMessages((prev) => [...prev, optimistic]);
      try {
        const encrypted = await encryptMessage(conversation, text);
        await chatApi.postMessage(conversation.id, {
          kind: 'application',
          mls_payload: encrypted.mls_payload_b64,
          client_msg_id: clientMsgId,
          epoch: encrypted.epoch,
          sender_device_id: currentDeviceId,
          reply_to_seq: replyToSeq ?? undefined,
        });
        await saveSentMessage({
          client_msg_id: clientMsgId,
          conversation_id: conversation.id,
          seq: null,
          plaintext: text,
          reply_to_seq: replyToSeq,
          created_at: optimistic.createdAt,
        });
        // إن سبقتنا أحداث WS فالحالة أُقرت sent هناك؛ وإلا نحدّث الآن.
        setMessages((prev) =>
          prev.map((m) => (m.clientMsgId === clientMsgId ? { ...m, state: 'sent' as const } : m)),
        );
      } catch (err) {
        if (isEpochConflict(err)) {
          // تضارب الجيل: مزامنة ثم إعادة إرسال مرة واحدة.
          try {
            await syncConversation(conversation, currentDeviceId, (id, after) =>
              chatApi.getMessages(id, after, 200),
            );
            const encrypted = await encryptMessage(conversation, text);
            await chatApi.postMessage(conversation.id, {
              kind: 'application',
              mls_payload: encrypted.mls_payload_b64,
              client_msg_id: clientMsgId,
              epoch: encrypted.epoch,
              sender_device_id: currentDeviceId,
              reply_to_seq: replyToSeq ?? undefined,
            });
            await saveSentMessage({
              client_msg_id: clientMsgId,
              conversation_id: conversation.id,
              seq: null,
              plaintext: text,
              reply_to_seq: replyToSeq,
              created_at: optimistic.createdAt,
            });
            setMessages((prev) =>
              prev.map((m) => (m.clientMsgId === clientMsgId ? { ...m, state: 'sent' as const } : m)),
            );
            return;
          } catch {
            // سقطت المحاولة الثانية — نعلّم الفشل أدناه.
          }
        }
        setMessages((prev) =>
          prev.map((m) => (m.clientMsgId === clientMsgId ? { ...m, state: 'failed' as const } : m)),
        );
      }
    },
    [conversation, currentDeviceId, user],
  );

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');
    const target = replyTo;
    setReplyTo(null);
    void doSend(text, uuid4(), target?.seq ?? null);
  };

  const onRetry = (message: ViewMessage) => {
    if (!message.plaintext || !message.clientMsgId) return;
    setMessages((prev) => prev.map((m) => (m.key === message.key ? { ...m, state: 'sending' as const } : m)));
    void doSend(message.plaintext, message.clientMsgId, message.replyToSeq ?? null);
  };

  const onDiscard = (message: ViewMessage) => {
    setMessages((prev) => prev.filter((m) => m.key !== message.key));
  };

  if (revoked) {
    return (
      <Card className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
        <ShieldAlert className="h-10 w-10 text-red-500" />
        <h3 className="text-lg font-semibold text-gray-900">تم إبطال هذا الجهاز</h3>
        <p className="text-sm text-gray-500">أُغلقت قناة الاتصال من الخادم. راجع صفحة الأجهزة للتفاصيل.</p>
        <Button variant="outline" onClick={() => navigate('/devices')}>
          الانتقال إلى الأجهزة
        </Button>
      </Card>
    );
  }

  return (
    <Card className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <h3 className="truncate text-base font-semibold text-gray-900">{title}</h3>
        <span className="text-xs text-gray-400">جيل {conversation.current_epoch}</span>
      </div>

      {banner && (
        <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {banner}
        </div>
      )}

      <div className="flex-1 space-y-2 overflow-y-auto p-4">
        {loading && (
          <div className="flex h-full items-center justify-center">
            <Spinner size="lg" />
          </div>
        )}
        {!loading && messages.length === 0 && (
          <p className="py-10 text-center text-sm text-gray-400">لا رسائل بعد — ابدأ المحادثة بأمان طرف-لطرف</p>
        )}
        {messages.map((message) => (
          <div key={message.key} className={cn('flex', message.mine ? 'justify-start' : 'justify-end')}>
            <div
              className={cn(
                'max-w-[75%] rounded-2xl px-4 py-2 text-sm shadow-sm',
                message.mine ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-900',
                message.state === 'sending' && 'opacity-70',
                message.state === 'failed' && 'border border-red-300 bg-red-50 text-red-900',
              )}
            >
              {message.replyToSeq !== null && message.replyToSeq !== undefined && (
                <div className={cn('mb-1 border-s-2 ps-2 text-xs', message.mine ? 'border-primary-200 text-primary-100' : 'border-gray-300 text-gray-500')}>
                  ردًّا على الرسالة رقم {message.replyToSeq}
                </div>
              )}
              {message.failed ? (
                <span className="italic">تعذر فك التشفير</span>
              ) : (
                <p className="whitespace-pre-wrap break-words">{message.plaintext ?? (message.mine ? 'رسالة من جهاز آخر' : '…')}</p>
              )}
              <div className={cn('mt-1 flex items-center gap-2 text-[11px]', message.mine ? 'text-primary-100' : 'text-gray-400')}>
                <span>{new Date(message.createdAt).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' })}</span>
                {message.state === 'sending' && <span>جارٍ الإرسال…</span>}
                {message.state === 'failed' && (
                  <>
                    <span>فشل الإرسال</span>
                    <button type="button" onClick={() => onRetry(message)} className="inline-flex items-center gap-1 underline">
                      <RotateCcw className="h-3 w-3" /> إعادة
                    </button>
                    <button type="button" onClick={() => onDiscard(message)} className="underline">
                      حذف
                    </button>
                  </>
                )}
                {message.state === 'sent' && !message.mine && (
                  <button
                    type="button"
                    aria-label="رد"
                    onClick={() => setReplyTo(message)}
                    className={cn('inline-flex hover:underline', message.mine ? 'text-primary-100' : 'text-gray-500')}
                  >
                    <Reply className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={onSubmit} className="border-t border-gray-200 p-3">
        {replyTo && (
          <div className="mb-2 flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
            <span className="truncate">ردًّا على: {replyTo.plaintext ?? `الرسالة رقم ${replyTo.seq}`}</span>
            <button type="button" onClick={() => setReplyTo(null)} className="font-medium text-gray-400 hover:text-gray-600">
              إلغاء
            </button>
          </div>
        )}
        <div className="flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="اكتب رسالة مشفرة…"
            autoComplete="off"
          />
          <Button type="submit" disabled={!input.trim()}>
            <Send className="h-4 w-4" />
            إرسال
          </Button>
        </div>
      </form>
    </Card>
  );
}
