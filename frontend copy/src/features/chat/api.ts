/**
 * عقد المراسلة — `/api/v1/conversations/*` (كلها مصادَقة).
 * الأشكال verbatim من العقد المشترك؛ هذا الملف هو الطرف الآمن الوحيد الذي
 * يخاطب السيرفر، وتشفير MLS نفسه يحدث في crypto/mls.ts (النقل يحقن هناك).
 */
import { apiFetch } from '../../shared/api';
import { setMlsTransport } from '../../crypto/mls';
import type { PostMessagePayload } from '../../crypto/mls';

export interface Conversation {
  id: number | string;
  type: 'dm' | 'group';
  /** base64 — عنوان مشفّر عبر حالة MLS (انظر crypto/decryptTitle). */
  title_enc?: string;
  title_plain?: string;
  mls_group_id: string;
  current_epoch: number;
  created_at: string;
  joined_at: string | null;
  member_count: number;
  my_role: string;
  /** أسماء الأعضاء الحاليين (بيانات دليل، لا محتوى). */
  members?: Array<{ id: string; full_name: string; username: string }>;
}

export interface Message {
  seq: number;
  kind: 'application' | 'commit' | 'welcome' | 'proposal';
  sender_user_id: number | string;
  sender_device_id: number | string;
  epoch: number;
  mls_payload: string;
  reply_to_seq?: number | null;
  client_msg_id?: string;
  created_at: string;
}

export interface MessagePage {
  current_epoch: number;
  messages: Message[];
}

export interface DirectoryUser {
  id: number | string;
  full_name?: string;
  username?: string;
}

export const chatApi = {
  listConversations: () => apiFetch<Conversation[]>('/conversations/'),

  createConversation: (body: {
    type: 'dm' | 'group';
    member_user_ids: Array<number | string>;
    title_enc?: string;
    mls_group_id: string;
  }) => apiFetch<Conversation>('/conversations/', { method: 'POST', body }),

  getMessages: (conversationId: number | string, afterSeq = 0, limit = 200) =>
    apiFetch<MessagePage>(
      `/conversations/${conversationId}/messages/?after_seq=${afterSeq}&limit=${limit}`,
    ),

  postMessage: (conversationId: number | string, body: PostMessagePayload) =>
    apiFetch<Record<string, unknown>>(`/conversations/${conversationId}/messages/`, {
      method: 'POST',
      body,
    }),

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

/** يحقن نقل المحادثات في موجه MLS (مرة واحدة عند تحميل الوحدة). */
setMlsTransport({
  createConversation: (payload) => chatApi.createConversation(payload),
  postMessage: (conversationId, payload) => chatApi.postMessage(conversationId, payload),
  addServerMembers: (conversationId, userIds) => chatApi.addMembers(conversationId, userIds),
  removeServerMembers: (conversationId, userIds) => chatApi.removeMembers(conversationId, userIds),
});

/** عنوان الـWS لمحادثة: من http(s) base إلى ws(s) مع تذكرة. */
export function conversationWsUrl(conversationId: number | string, ticket: string): string {
  const base = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:8000/api/v1';
  const wsBase = base.replace(/^http/, 'ws').replace(/\/api\/v1\/?$/, '');
  return `${wsBase}/ws/conversations/${conversationId}/?ticket=${encodeURIComponent(ticket)}`;
}

export type { PostMessagePayload };
