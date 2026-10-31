/**
 * المحادثات بأسلوب Slack: شريط جانبي (القنوات + الرسائل المباشرة) | تيار
 * الرسائل | لوحة الأعضاء (اختيارية). المسارات: /chat و /chat/:conversationId.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Hash, Lock, MessageSquarePlus, Plus, X } from 'lucide-react';
import { Avatar, Spinner } from '../../shared/ui';
import { useIsDesktop } from '../../shared/lib/useMedia';
import { cn } from '../../shared/lib/cn';
import { CryptoGate } from '../correspondence/components';
import { useCryptoBootstrap } from '../../crypto/useCryptoBootstrap';
import { chatApi, type Conversation } from './api';
import { useConversationTitle, useUnread } from './hooks';
import { MemberManager } from './MemberManager';
import { NewConversationDialog } from './NewConversationDialog';
import { ThreadView } from './ThreadView';

const SIDEBAR_BG = 'bg-[#3f0e40]';

function SidebarItem({ conversation, selected, onSelect }: { conversation: Conversation; selected: boolean; onSelect: () => void }) {
  const title = useConversationTitle(conversation);
  const unread = useUnread(conversation.id) && !selected;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-3 py-1 text-start text-[15px]',
        selected ? 'bg-[#1164a3] text-white' : unread ? 'font-bold text-white hover:bg-white/10' : 'text-white/70 hover:bg-white/10',
      )}
    >
      {conversation.type === 'dm' ? (
        <Avatar name={title} size="xs" square />
      ) : (
        <Hash className="h-4 w-4 shrink-0 opacity-70" />
      )}
      <span className="truncate">{title}</span>
      {unread && <span className="ms-auto h-2 w-2 shrink-0 rounded-full bg-white" aria-label="غير مقروءة" />}
    </button>
  );
}

function Section({
  label,
  onAdd,
  addLabel,
  children,
}: {
  label: string;
  onAdd: () => void;
  addLabel: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mt-4">
      <div className="group flex items-center justify-between px-3 text-[15px] text-white/70">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 hover:text-white">
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', !open && 'rotate-90')} />
          {label}
        </button>
        <button type="button" onClick={onAdd} aria-label={addLabel} title={addLabel} className="rounded p-0.5 hover:bg-white/10 hover:text-white">
          <Plus className="h-4 w-4" />
        </button>
      </div>
      {open && <div className="mt-1 space-y-0.5 px-2">{children}</div>}
    </div>
  );
}

function MembersPanel({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  return (
    <aside className="fixed inset-0 z-30 flex flex-col bg-white md:static md:z-auto md:w-72 md:shrink-0 md:border-s md:border-gray-200">
      <div className="flex h-14 items-center justify-between border-b border-gray-200 px-4">
        <h4 className="font-bold text-gray-900">الأعضاء ({conversation.member_count})</h4>
        <button type="button" onClick={onClose} aria-label="إغلاق" className="rounded p-1 text-gray-500 hover:bg-gray-100">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <ul className="space-y-2">
          {(conversation.members ?? []).map((m) => (
            <li key={m.id} className="flex items-center gap-2 text-sm text-gray-800">
              <Avatar name={m.full_name || m.username} size="sm" square />
              {m.full_name || m.username}
            </li>
          ))}
        </ul>
        {conversation.my_role === 'admin' && <MemberManager conversation={conversation} />}
        <p className="text-xs text-gray-500">
          إزالة عضو تمنعه تشفيريًا من قراءة الرسائل التالية؛ ما قرأه سابقًا لا يمكن سحبه. العضو الجديد لا يرى ما قبل انضمامه.
        </p>
      </div>
    </aside>
  );
}

function Workspace() {
  const bootstrap = useCryptoBootstrap();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { conversationId } = useParams<{ conversationId?: string }>();
  const [params] = useSearchParams();
  const [dialog, setDialog] = useState<'dm' | 'group' | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const desktop = useIsDesktop();

  const { data: conversations, isLoading } = useQuery({
    queryKey: ['conversations'],
    queryFn: chatApi.listConversations,
    refetchInterval: 15_000,
  });
  const all = conversations ?? [];
  const channels = all.filter((c) => c.type === 'group');
  const dms = all.filter((c) => c.type === 'dm');
  const selected = all.find((c) => String(c.id) === String(conversationId));

  // روابط قديمة (?c=) وأول دخول على شاشة كبيرة: افتح محادثة.
  // على الموبايل تبقى القائمة ظاهرة حتى يختار المستخدم.
  useEffect(() => {
    const legacy = params.get('c');
    if (legacy) navigate(`/chat/${legacy}`, { replace: true });
    else if (desktop && !conversationId && all.length > 0) navigate(`/chat/${all[0].id}`, { replace: true });
  }, [params, conversationId, all, navigate, desktop]);

  if (bootstrap.status !== 'ready') return null; // CryptoGate يعرض الحالة

  return (
    <div className="flex h-full">
      <aside className={cn('w-full shrink-0 flex-col md:flex md:w-64', selected ? 'hidden' : 'flex', SIDEBAR_BG)}>
        <div className="flex h-14 items-center justify-between border-b border-white/10 px-4">
          <span className="truncate text-lg font-bold text-white">مجموعة المعاهد</span>
          <button
            type="button"
            onClick={() => setDialog('dm')}
            aria-label="رسالة جديدة"
            title="رسالة جديدة"
            className="rounded-md bg-white p-1.5 text-[#3f0e40] hover:bg-white/90"
          >
            <MessageSquarePlus className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-4">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : (
            <>
              <Section label="القنوات" onAdd={() => setDialog('group')} addLabel="قناة جديدة">
                {channels.length === 0 && <p className="px-3 py-1 text-sm text-white/40">لا قنوات بعد</p>}
                {channels.map((c) => (
                  <SidebarItem key={String(c.id)} conversation={c} selected={c === selected} onSelect={() => navigate(`/chat/${c.id}`)} />
                ))}
              </Section>
              <Section label="الرسائل المباشرة" onAdd={() => setDialog('dm')} addLabel="رسالة مباشرة جديدة">
                {dms.length === 0 && <p className="px-3 py-1 text-sm text-white/40">لا رسائل مباشرة بعد</p>}
                {dms.map((c) => (
                  <SidebarItem key={String(c.id)} conversation={c} selected={c === selected} onSelect={() => navigate(`/chat/${c.id}`)} />
                ))}
              </Section>
            </>
          )}
        </div>
        <p className="flex items-center gap-1.5 border-t border-white/10 px-4 py-2 text-[11px] text-white/50">
          <Lock className="h-3 w-3" />
          مشفّرة طرفًا لطرف (MLS)
        </p>
      </aside>

      {selected ? (
        <>
          <ThreadView
            key={String(selected.id)}
            conversation={selected}
            currentDeviceId={bootstrap.deviceId}
            membersOpen={membersOpen}
            onToggleMembers={() => setMembersOpen((v) => !v)}
          />
          {membersOpen && selected.type === 'group' && <MembersPanel conversation={selected} onClose={() => setMembersOpen(false)} />}
        </>
      ) : (
        <div className="hidden flex-1 flex-col items-center justify-center gap-3 bg-white text-center md:flex">
          <MessageSquarePlus className="h-14 w-14 text-gray-200" />
          <p className="text-sm text-gray-500">ابدأ رسالة مباشرة أو أنشئ قناة من الشريط الجانبي</p>
        </div>
      )}

      {dialog && (
        <NewConversationDialog
          type={dialog}
          onClose={() => setDialog(null)}
          onCreated={(conversation) => {
            setDialog(null);
            void queryClient.invalidateQueries({ queryKey: ['conversations'] });
            navigate(`/chat/${conversation.id}`);
          }}
        />
      )}
    </div>
  );
}

export function ChatWorkspace() {
  return (
    <CryptoGate>
      <Workspace />
    </CryptoGate>
  );
}
