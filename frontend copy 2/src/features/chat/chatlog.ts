/** سجل رسالة شات مستلمة بعد فكها — يُخزن مغلّفًا بالـKEK في مخزن `chatlog`. */
export interface ChatLogRecord {
  conversation_id: string;
  conversation_type: 'dm' | 'group';
  seq: number;
  sender_user_id: string;
  created_at: string;
  plaintext: string;
}
