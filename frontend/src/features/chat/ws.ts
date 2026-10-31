/**
 * عميل WebSocket للمحادثات — تذكرة الدخول، إعادة اتصال بتباعد أسّي، وإعادة
 * الجلب عند كل إعادة اتصال. الإغلاق برمز 4002 = أُزلنا من المحادثة.
 */
import type { Message } from './api';

export interface ChatEventMessage extends Message {
  event: 'message';
}

export interface ChatEventMembers {
  event: 'member_added' | 'member_removed';
  user_ids: Array<number | string>;
}

export type ChatEvent = ChatEventMessage | ChatEventMembers;

interface SocketCallbacks {
  onEvent: (event: ChatEvent) => void;
  /** عند كل إعادة اتصال ناجحة — تُعيد الطبقة العليا الجلب (refetch). */
  onResync: () => void;
  onRemoved: () => void;
  onError?: (message: string) => void;
}

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

export class ChatSocket {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private conversationId: number | string,
    private getTicket: () => Promise<string>,
    private makeUrl: (conversationId: number | string, ticket: string) => string,
    private callbacks: SocketCallbacks,
  ) {}

  connect(): void {
    this.closedByUser = false;
    void this.open();
  }

  private async open(): Promise<void> {
    if (this.closedByUser) return;
    let ticket: string;
    try {
      ticket = await this.getTicket();
    } catch {
      this.scheduleReconnect();
      return;
    }
    const ws = new WebSocket(this.makeUrl(this.conversationId, ticket));
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.callbacks.onResync();
    };
    ws.onmessage = (raw) => {
      try {
        const event = JSON.parse(String(raw.data)) as ChatEvent;
        this.callbacks.onEvent(event);
      } catch {
        // إطار غير مفهوم — نتجاهله (لا نكسر الخيط).
      }
    };
    ws.onclose = (event) => {
      if (this.closedByUser) return;
      if (event.code === 4002) {
        this.callbacks.onRemoved();
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // يتبعه onclose دائمًا — إعادة الجدولة هناك.
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** this.attempts);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.open();
    }, delay);
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
