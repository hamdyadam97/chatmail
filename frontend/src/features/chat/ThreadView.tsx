import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Hash, Lock, Reply, RotateCcw, Send, ShieldAlert, Users } from 'lucide-react';
import { cn } from '../../shared/lib/cn';
import { Avatar, Button, Spinner } from '../../shared/ui';
import { useAuth } from '../auth/AuthContext';
import { chatApi, conversationWsUrl, type Conversation, type Message } from './api';
import { ChatSocket, type ChatEvent } from './ws';
import { useConversationTitle } from './hooks';

interface ViewMessage {
  key: string;
  seq: number | null;
  /** مرسلة من حسابي (أي جهاز). */
  mine: boolean;
  plaintext?: string;
  /** تعذر فتح المحتوى على الخادم. */
  failed: boolean;
  state: 'sending' | 'sent' | 'failed';
  replyToSeq?: number | null;
  createdAt: string;
  clientMsgId?: string;
  senderUserId: number | string;
}

interface ThreadViewProps {
  conversation: Conversation;
  membersOpen?: boolean;
  onToggleMembers?: () => void;
}

const PAGE = 200;

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'اليوم';
  if (d.toDateString() === yesterday.toDateString()) return 'أمس';
  return d.toLocaleDateString('ar', { weekday: 'long', day: 'numeric', month: 'long' });
}

function toView(message: Message, meId: number | string): ViewMessage {
  return {
    key: message.client_msg_id ? `msg:${message.client_msg_id}` : `seq:${message.seq}`,
    seq: message.seq,
    mine: String(message.sender_user_id) === String(meId),
    plaintext: message.content?.text,
    failed: message.content === null,
    state: 'sent',
    replyToSeq: message.reply_to_seq ?? null,
    createdAt: message.created_at,
    clientMsgId: message.client_msg_id,
    senderUserId: message.sender_user_id ?? '',
  };
}

/** يدمج رسائل الخادم مع المعروض: لا تكرار، والمرسلة/الفاشلة محليًا تبقى حتى يعرفها الخادم. */
function merge(prev: ViewMessage[], incoming: ViewMessage[]): ViewMessage[] {
  const byKey = new Map(prev.map((m) => [m.key, m]));
  for (const m of incoming) byKey.set(m.key, m);
  return [...byKey.values()].sort((x, y) => {
    if (x.seq === null) return 1;
    if (y.seq === null) return -1;
    return x.seq - y.seq;
  });
}

export function ThreadView({ conversation, membersOpen, onToggleMembers }: ThreadViewProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const title = useConversationTitle(conversation);

  const [messages, setMessages] = useState<ViewMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [replyTo, setReplyTo] = useState<ViewMessage | null>(null);
  const [removed, setRemoved] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const socketRef = useRef<ChatSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const names = new Map((conversation.members ?? []).map((m) => [String(m.id), m.full_name || m.username]));
  const nameOf = (userId: number | string) =>
    String(userId) === String(user?.id) ? user?.full_name || 'أنا' : names.get(String(userId)) ?? 'عضو';
  const conversationId = conversation.id;

  const markRead = useCallback(
    (seq: number) => {
      if (seq <= 0) return;
      void chatApi.markRead(conversationId, seq).catch(() => undefined);
      window.dispatchEvent(new CustomEvent('chat-read', { detail: { id: String(conversationId), seq } }));
    },
    [conversationId],
  );

  const loadInitial = useCallback(async () => {
    setLoading(true);
    try {
      const page = await chatApi.getMessages(conversationId, { latest: true, limit: PAGE });
      setMessages((prev) => merge(prev, page.messages.map((m) => toView(m, user!.id))));
      markRead(page.messages.reduce((m, msg) => Math.max(m, msg.seq), 0));
    } catch (err) {
      setBanner(err instanceof Error ? err.message : 'تعذر تحميل الرسائل');
    } finally {
      setLoading(false);
    }
  }, [conversationId, user, markRead]);

  const handleIncoming = useCallback(
    (event: Extract<ChatEvent, { event: 'message' }>) => {
      setMessages((prev) => merge(prev, [toView(event, user!.id)]));
      markRead(event.seq);
    },
    [user, markRead],
  );

  // التحميل الأولي + مقبس WS. يعاد الاتصال فقط عند تغيّر المحادثة المفتوحة.
  useEffect(() => {
    void loadInitial();
    const socket = new ChatSocket(
      conversationId,
      () => chatApi.wsTicket(conversationId).then((r) => r.ticket),
      conversationWsUrl,
      {
        onEvent: (event: ChatEvent) => {
          if (event.event === 'message') {
            handleIncoming(event);
          } else {
            setBanner(event.event === 'member_added' ? 'انضم عضو جديد إلى المحادثة' : 'غادر عضو المحادثة');
            void queryClient.invalidateQueries({ queryKey: ['conversations'] });
          }
        },
        onResync: () => void loadInitial(),
        onRemoved: () => setRemoved(true),
      },
    );
    socketRef.current = socket;
    socket.connect();
    return () => socket.close();
  }, [conversationId, loadInitial, handleIncoming, queryClient]);

  // أحدث رسالة في الأسفل ظاهرة دائمًا (كما في Slack).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, loading]);

  const doSend = useCallback(
    async (text: string, clientMsgId: string, replyToSeq: number | null) => {
      const key = `msg:${clientMsgId}`;
      setMessages((prev) =>
        merge(prev, [
          {
            key,
            seq: null,
            mine: true,
            plaintext: text,
            failed: false,
            state: 'sending',
            replyToSeq,
            createdAt: new Date().toISOString(),
            clientMsgId,
            senderUserId: user!.id,
          },
        ]),
      );
      try {
        const sent = await chatApi.postMessage(conversationId, {
          text,
          client_msg_id: clientMsgId,
          reply_to_seq: replyToSeq ?? undefined,
        });
        setMessages((prev) => merge(prev, [toView(sent, user!.id)]));
      } catch {
        setMessages((prev) => prev.map((m) => (m.key === key ? { ...m, state: 'failed' as const } : m)));
      }
    },
    [conversationId, user],
  );

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');
    const target = replyTo;
    setReplyTo(null);
    void doSend(text, crypto.randomUUID(), target?.seq ?? null);
  };

  const onRetry = (message: ViewMessage) => {
    if (!message.plaintext || !message.clientMsgId) return;
    void doSend(message.plaintext, message.clientMsgId, message.replyToSeq ?? null);
  };

  const onDiscard = (message: ViewMessage) => {
    setMessages((prev) => prev.filter((m) => m.key !== message.key));
  };

  if (removed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
        <ShieldAlert className="h-10 w-10 text-red-500" />
        <h3 className="text-lg font-semibold text-gray-900">لم تعد عضوًا في هذه المحادثة</h3>
        <Button variant="outline" onClick={() => navigate('/chat')}>
          العودة للمحادثات
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
          <Lock className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-label="محفوظة مشفّرة" />
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
              {isDm ? `هذه بداية محادثتك المباشرة مع ${title}.` : 'هذه بداية القناة.'} الرسائل محفوظة مشفّرة ولا تُعرض إلا لأعضاء
              المحادثة.
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
                    <p className="text-sm italic text-gray-400">تعذر عرض هذه الرسالة</p>
                  ) : (
                    <p className="whitespace-pre-wrap break-words text-[15px] leading-6 text-gray-900">
                      {message.plaintext ?? '…'}
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
              Enter للإرسال · Shift+Enter لسطر جديد
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
