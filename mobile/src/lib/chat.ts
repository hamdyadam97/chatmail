/** المحادثات والتعاميم — نفس عقد الموقع (`/conversations/`، `/announcements/`). */
import { api } from './api';
import type { Page } from './types';

export interface Member {
  id: string;
  full_name: string;
  username: string;
}

export interface Conversation {
  id: string;
  type: 'dm' | 'group';
  title: string | null;
  created_at: string;
  last_read_seq: number;
  member_count: number;
  members?: Member[];
  last: { seq: number; sender_user_id: string | null; preview: string; created_at: string } | null;
}

export interface ChatMessage {
  seq: number;
  sender_user_id: string | null;
  content: { text: string } | null;
  client_msg_id?: string;
  created_at: string;
}

/** اسم المحادثة: للمباشرة اسم الطرف الآخر. */
export function conversationName(c: Conversation, meId?: string): string {
  if (c.type === 'dm') {
    const other = c.members?.find((m) => m.id !== meId);
    return other?.full_name || other?.username || 'محادثة';
  }
  return c.title || (c.members ?? []).filter((m) => m.id !== meId).map((m) => m.full_name.split(' ')[0]).join('، ') || 'مجموعة';
}

export function newId(): string {
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

export const chatApi = {
  list: () => api<Conversation[]>('/conversations/'),
  create: (type: 'dm' | 'group', memberIds: string[], title = '') =>
    api<Conversation>('/conversations/', { method: 'POST', body: { type, member_user_ids: memberIds, title } }),
  latest: (id: string, limit = 50) => api<{ messages: ChatMessage[] }>(`/conversations/${id}/messages/?latest=1&limit=${limit}`),
  after: (id: string, seq: number) => api<{ messages: ChatMessage[] }>(`/conversations/${id}/messages/?after_seq=${seq}&limit=100`),
  before: (id: string, seq: number) => api<{ messages: ChatMessage[] }>(`/conversations/${id}/messages/?before_seq=${seq}&limit=50`),
  send: (id: string, text: string, clientMsgId: string) =>
    api<ChatMessage>(`/conversations/${id}/messages/`, { method: 'POST', body: { text, client_msg_id: clientMsgId } }),
  read: (id: string, seq: number) => api(`/conversations/${id}/read/`, { method: 'POST', body: { seq } }),
};

// --- التعاميم ---------------------------------------------------------------------------

export interface Announcement {
  id: string;
  reference_number: string | null;
  publisher: Member;
  priority: 'normal' | 'high' | 'urgent';
  requires_ack: boolean;
  ack_due_at: string | null;
  status: 'draft' | 'published' | 'withdrawn';
  published_at: string | null;
  content: { title: string; body: string } | null;
  mine: { delivered_at: string | null; read_at: string | null; acknowledged_at: string | null } | null;
}

export const announcementsApi = {
  received: (pendingAck = false) => api<Page<Announcement>>(`/announcements/?box=received&page=1${pendingAck ? '&pending_ack=1' : ''}`),
  get: (id: string) => api<Announcement>(`/announcements/${id}/`),
  read: (id: string) => api(`/announcements/${id}/read/`, { method: 'POST' }),
  ack: (id: string) => api<{ acknowledged_at: string }>(`/announcements/${id}/ack/`, { method: 'POST' }),
};
