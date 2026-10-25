import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Hash, Lock, Reply, RotateCcw, Send, ShieldAlert, Users } from 'lucide-react';
import { cn } from '../../shared/lib/cn';
import { Avatar, Button, Spinner } from '../../shared/ui';
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
  membersOpen?: boolean;
  onToggleMembers?: () => void;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'اليوم';
  if (d.toDateString() === yesterday.toDateString()) return 'أمس';
  return d.toLocaleDateString('ar', { weekday: 'long', day: 'numeric', month: 'long' });
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

export function ThreadView({ conversation, currentDeviceId, membersOpen, onToggleMembers }: ThreadViewProps) {
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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const names = new Map((conversation.members ?? []).map((m) => [String(m.id), m.full_name || m.username]));
  const nameOf = (userId: number | string) =>
    String(userId) === String(user?.id) ? user?.full_name || 'أنا' : names.get(String(userId)) ?? 'عضو';
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;

  const loadInitial = useCallback(async () => {
    const current = conversationRef.current;
    setLoading(true);
    try {
      const page = await chatApi.getMessages(current.id, 0, 200);
      const feed = await feedMessages(current, page.messages, currentDeviceId);
      const view = await viewFromMessages(current, page.messages, feed.decrypted, user!.id, currentDeviceId);
      // إعادة المزامنة (مثلًا عند اتصال WS) لا تمحو رسائل ما زالت تُرسل أو فشلت
      // ولم يعرفها الخادم بعد — وإلا اختفت رسالة المستخدم لحظة إرسالها.
      setMessages((prev) => {
        const known = new Set(view.map((m) => m.key));
        const pending = prev.filter((m) => m.state !== 'sent' && !known.has(m.key));
        return [...view, ...pending];
      });
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

  // أحدث رسالة في الأسفل ظاهرة دائمًا (كما في Slack).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, loading]);

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
      // النص يُحفظ (مغلّفًا) قبل الإرسال: صدى WS لرسالتنا قد يصل قبل اكتمال
      // الطلب، ومن دون النص المحفوظ يُعرض «…» بدل رسالتنا.
      await saveSentMessage({
        client_msg_id: clientMsgId,
        conversation_id: conversation.id,
        seq: null,
        plaintext: text,
        reply_to_seq: replyToSeq,
        created_at: optimistic.createdAt,
      });
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
      <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
        <ShieldAlert className="h-10 w-10 text-red-500" />
        <h3 className="text-lg font-semibold text-gray-900">تم إبطال هذا الجهاز</h3>
        <p className="text-sm text-gray-500">أُغلقت قناة الاتصال من الخادم. راجع صفحة الأجهزة للتفاصيل.</p>
        <Button variant="outline" onClick={() => navigate('/devices')}>
          الانتقال إلى الأجهزة
        </Button>
      </div>
    );
  }

  const isDm = conversation.type === 'dm';
  const heading = isDm ? title : `# ${title}`;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-white">
      {/* رأس القناة — أسلوب Slack */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 px-3 md:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => navigate('/chat')}
            aria-label="رجوع للمحادثات"
            className="rounded-md p-1 text-gray-600 hover:bg-gray-100 md:hidden"
          >
            <ArrowRight className="h-5 w-5" />
          </button>
          {isDm && <Avatar name={title} size="sm" square />}
          <h3 className="truncate text-base font-bold text-gray-900">{heading}</h3>
          <Lock className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-label="مشفّرة طرفًا لطرف" />
        </div>
        {!isDm && onToggleMembers && (
          <button
            type="button"
            onClick={onToggleMembers}
            className={cn(
              'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs',
              membersOpen ? 'border-primary-300 bg-primary-50 text-primary-800' : 'border-gray-300 text-gray-600 hover:bg-gray-50',
            )}
          >
            <Users className="h-3.5 w-3.5" />
            {conversation.member_count}
          </button>
        )}
      </div>

      {banner && (
        <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-5 py-2 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {banner}
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-3">
        {loading && (
          <div className="flex h-full items-center justify-center">
            <Spinner size="lg" />
          </div>
        )}
        {!loading && messages.length === 0 && (
          <div className="px-5 pt-10">
            <div className="mb-3">{isDm ? <Avatar name={title} size="lg" square /> : <Hash className="h-10 w-10 text-gray-300" />}</div>
            <h4 className="text-xl font-bold text-gray-900">{isDm ? title : `مرحبًا بك في ${heading}`}</h4>
            <p className="mt-1 text-sm text-gray-500">
              {isDm ? `هذه بداية محادثتك المباشرة مع ${title}.` : 'هذه بداية القناة.'} كل الرسائل مشفّرة طرفًا لطرف — لا يقرؤها الخادم ولا
              أي مسؤول.
            </p>
          </div>
        )}
        {messages.map((message, index) => {
          const prev = messages[index - 1];
          const day = new Date(message.createdAt).toDateString();
          const newDay = !prev || new Date(prev.createdAt).toDateString() !== day;
          const grouped =
            !newDay &&
            prev &&
            String(prev.senderUserId) === String(message.senderUserId) &&
            new Date(message.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000 &&
            (message.replyToSeq === null || message.replyToSeq === undefined);
          const name = nameOf(message.senderUserId);
          const time = new Date(message.createdAt).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
          const quoted =
            message.replyToSeq !== null && message.replyToSeq !== undefined
              ? messages.find((m) => m.seq === message.replyToSeq)
              : undefined;
          return (
            <div key={message.key}>
              {newDay && (
                <div className="relative my-3 flex items-center justify-center">
                  <div className="absolute inset-x-0 top-1/2 border-t border-gray-200" />
                  <span className="relative rounded-full border border-gray-200 bg-white px-3 py-0.5 text-xs font-semibold text-gray-700">
                    {dayLabel(message.createdAt)}
                  </span>
                </div>
              )}
              <div
                className={cn(
                  'group relative flex gap-2 px-5 hover:bg-gray-50',
                  grouped ? 'py-0.5' : 'pt-2 pb-0.5',
                  message.state === 'sending' && 'opacity-60',
                )}
              >
                <div className="w-9 shrink-0">
                  {grouped ? (
                    <span className="invisible block pt-1 text-[10px] text-gray-400 group-hover:visible">{time}</span>
                  ) : (
                    <Avatar name={name} size="md" square />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  {!grouped && (
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-bold text-gray-900">{name}</span>
                      <span className="text-xs text-gray-500">{time}</span>
                    </div>
                  )}
                  {quoted !== undefined || (message.replyToSeq !== null && message.replyToSeq !== undefined) ? (
                    <div className="my-1 border-s-4 border-gray-300 ps-2 text-xs text-gray-500">
                      <span className="font-semibold">{quoted ? nameOf(quoted.senderUserId) : 'رسالة سابقة'}: </span>
                      {quoted?.plaintext?.slice(0, 120) ?? '…'}
                    </div>
                  ) : null}
                  {message.failed ? (
                    <p className="text-sm italic text-gray-400">تعذر فك التشفير على هذا الجهاز</p>
                  ) : (
                    <p className="whitespace-pre-wrap break-words text-[15px] leading-6 text-gray-900">
                      {message.plaintext ?? (message.mine ? 'رسالة من جهاز آخر' : '…')}
                    </p>
                  )}
                  {message.state === 'failed' && (
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-red-600">
                      <span>لم تُرسل</span>
                      <button type="button" onClick={() => onRetry(message)} className="inline-flex items-center gap-1 font-medium underline">
                        <RotateCcw className="h-3 w-3" /> إعادة المحاولة
                      </button>
                      <button type="button" onClick={() => onDiscard(message)} className="underline">
                        حذف
                      </button>
                    </div>
                  )}
                </div>
                {message.state === 'sent' && message.seq !== null && (
                  <div className="absolute -top-3 end-4 hidden rounded-md border border-gray-200 bg-white shadow-sm group-hover:flex">
                    <button
                      type="button"
                      aria-label="رد"
                      title="رد"
                      onClick={() => setReplyTo(message)}
                      className="p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                    >
                      <Reply className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* محرر الرسالة — أسلوب Slack */}
      <form onSubmit={onSubmit} className="shrink-0 px-5 pb-4">
        <div className="rounded-lg border border-gray-300 focus-within:border-gray-500 focus-within:shadow-sm">
          {replyTo && (
            <div className="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-600">
              <span className="truncate">
                ردًّا على {nameOf(replyTo.senderUserId)}: {replyTo.plaintext?.slice(0, 80) ?? '…'}
              </span>
              <button type="button" onClick={() => setReplyTo(null)} className="font-medium text-gray-400 hover:text-gray-700">
                إلغاء
              </button>
            </div>
          )}
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            rows={Math.min(6, Math.max(1, input.split('\n').length))}
            placeholder={`رسالة إلى ${heading}`}
            aria-label="نص الرسالة"
            className="block w-full resize-none border-0 bg-transparent px-3 pt-2.5 text-[15px] leading-6 outline-none placeholder:text-gray-400"
          />
          <div className="flex items-center justify-between px-2 pb-1.5">
            <span className="flex items-center gap-1 text-[11px] text-gray-400">
              <Lock className="h-3 w-3 text-emerald-600" />
              مشفّرة · Enter للإرسال · Shift+Enter لسطر جديد
            </span>
            <button
              type="submit"
              disabled={!input.trim()}
              aria-label="إرسال"
              className={cn('rounded-md p-1.5', input.trim() ? 'bg-emerald-700 text-white hover:bg-emerald-800' : 'text-gray-300')}
            >
              <Send className="h-4 w-4 -scale-x-100" />
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
