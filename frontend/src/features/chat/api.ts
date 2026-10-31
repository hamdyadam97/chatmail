/**
 * عقد المحادثات — `/api/v1/conversations/*` (كلها مصادَقة). النص يُخزَّن على
 * الخادم مشفّرًا بمفتاحه ويُعاد مفتوحًا للأعضاء فقط.
 */
import { apiFetch } from '../../shared/api';

export interface Conversation {
  id: number | string;
  type: 'dm' | 'group';
  title: string | null;
  created_at: string;
  joined_at: string | null;
  member_count: number;
  my_role: string;
  last_read_seq: number;
  /** أسماء الأعضاء الحاليين (بيانات دليل، لا محتوى). */
  members?: Array<{ id: string; full_name: string; username: string }>;
}

export interface Message {
  seq: number;
  sender_user_id: string | null;
  /** null = تعذر فتح المحتوى. */
  content: { text: string } | null;
  reply_to_seq?: number | null;
  client_msg_id?: string;
  created_at: string;
}

export interface MessagePage {
  messages: Message[];
}

export interface DirectoryUser {
  id: number | string;
  full_name?: string;
  username?: string;
}

export const chatApi = {
  listConversations: () => apiFetch<Conversation[]>('/conversations/'),

  createConversation: (body: { type: 'dm' | 'group'; member_user_ids: Array<number | string>; title?: string }) =>
    apiFetch<Conversation>('/conversations/', { method: 'POST', body }),

  /** بعد seq معيّن (اللحاق)، أو آخر صفحة (latest)، أو ما قبل seq (الأقدم). */
  getMessages: (
    conversationId: number | string,
    { afterSeq, beforeSeq, latest = false, limit = 100 }: { afterSeq?: number; beforeSeq?: number; latest?: boolean; limit?: number } = {},
  ) => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (afterSeq !== undefined) q.set('after_seq', String(afterSeq));
    if (beforeSeq !== undefined) q.set('before_seq', String(beforeSeq));
    if (latest) q.set('latest', '1');
    return apiFetch<MessagePage>(`/conversations/${conversationId}/messages/?${q}`);
  },

  postMessage: (conversationId: number | string, body: { text: string; client_msg_id: string; reply_to_seq?: number }) =>
    apiFetch<Message>(`/conversations/${conversationId}/messages/`, { method: 'POST', body }),

  markRead: (conversationId: number | string, seq: number) =>
    apiFetch<{ last_read_seq: number }>(`/conversations/${conversationId}/read/`, { method: 'POST', body: { seq } }),

  addMembers: (conversationId: number | string, userIds: Array<number | string>) =>
    apiFetch<null>(`/conversations/${conversationId}/members/`, {
      method: 'POST',
      body: { user_ids: userIds },
    }),

  removeMembers: (conversationId: number | string, userIds: Array<number | string>) =>
    apiFetch<null>(`/conversations/${conversationId}/members/remove/`, {
      method: 'POST',
      body: { user_ids: userIds },
    }),

  wsTicket: (conversationId: number | string) =>
    apiFetch<{ ticket: string }>(`/conversations/${conversationId}/ws-ticket/`),

  /** دليل المستخدمين لاختيار الأعضاء (قد يكون مصفوفة أو {results}). */
  listUsers: async (): Promise<DirectoryUser[]> => {
    const data = await apiFetch<DirectoryUser[] | { results: DirectoryUser[] }>('/users/');
    return Array.isArray(data) ? data : (data.results ?? []);
  },
};

/** عنوان الـWS لمحادثة: من http(s) base إلى ws(s) مع تذكرة. */
export function conversationWsUrl(conversationId: number | string, ticket: string): string {
  const base = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:8000/api/v1';
  const wsBase = base.replace(/^http/, 'ws').replace(/\/api\/v1\/?$/, '');
  return `${wsBase}/ws/conversations/${conversationId}/?ticket=${encodeURIComponent(ticket)}`;
}
