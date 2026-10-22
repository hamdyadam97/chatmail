/**
 * البحث المحلي (§17): يبني الفهرس في الذاكرة من السجلات المفكوكة المخزنة
 * مغلّفة بالـKEK في IndexedDB (مراسلات، تعاميم، شات مستلم ومرسل من هذا
 * الجهاز). لا يُرسل أي مصطلح بحث إلى الخادم، ولا يُكتب الفهرس إلى أي تخزين،
 * ولا يوضع الاستعلام في عنوان الصفحة (يبقى خارج سجل المتصفح والخوادم).
 */
import { getAllEntries } from '../../crypto/keystore';
import { useAuthUser } from '../../crypto/authBridge';
import type { SentMessageRecord } from '../../crypto/mls';
import type { ChatLogRecord } from '../chat/chatlog';
import { correspondenceApi, type Folder } from '../correspondence/api';
import { openCorrespondence, type StoredContent } from '../correspondence/service';
import { announcementsApi } from '../announcements/api';
import { openAnnouncement, type StoredAnnouncement } from '../announcements/service';
import { SearchIndex } from './searchIndex';

const MAX_AGE_MS = 30_000;
let cached: { index: SearchIndex; builtAt: number; user: string } | null = null;

/** يُستدعى عند فك محتوى جديد ليُعاد بناء الفهرس في البحث التالي. */
export function invalidateLocalIndex(): void {
  cached = null;
}

export async function getLocalIndex(force = false): Promise<SearchIndex> {
  const user = String(useAuthUser().id);
  if (!force && cached && cached.user === user && Date.now() - cached.builtAt < MAX_AGE_MS) return cached.index;
  const index = new SearchIndex();

  for (const [key, value] of await getAllEntries<StoredContent | StoredAnnouncement | unknown>('mail')) {
    if (key.startsWith('seq:')) continue; // نسخ وسيطة بالـseq — العنصر نفسه مفهرس بمعرّفه
    if (key.startsWith('ann:')) {
      const a = value as StoredAnnouncement;
      if (!a?.content) continue;
      index.add({
        id: key,
        kind: 'announcement',
        title: a.content.subject,
        body: a.content.body,
        meta: [a.meta?.reference_number, a.meta?.publisher_name].filter(Boolean).join(' '),
        date: a.meta?.published_at ?? null,
        link: `/announcements/${key.slice(4)}`,
      });
      continue;
    }
    const c = value as StoredContent;
    if (!c?.content) continue;
    index.add({
      id: `corr:${key}`,
      kind: 'correspondence',
      title: c.content.subject,
      body: [
        c.content.body,
        c.content.forwarded ? `${c.content.forwarded.subject} ${c.content.forwarded.body}` : '',
        c.content.attachments.map((a) => a.name).join(' '),
      ].join('\n'),
      meta: [c.meta?.reference_number, c.meta?.sender_name].filter(Boolean).join(' '),
      date: c.meta?.sent_at ?? c.decrypted_at,
      link: `/correspondence/${key}`,
    });
  }

  const chatLink = (type: string, id: string) => `${type === 'group' ? '/group-chats' : '/direct-messages'}?c=${id}`;
  for (const [key, r] of await getAllEntries<ChatLogRecord>('chatlog')) {
    index.add({ id: `chat:${key}`, kind: 'chat', title: '', body: r.plaintext, date: r.created_at, link: chatLink(r.conversation_type, r.conversation_id) });
  }
  for (const [key, r] of await getAllEntries<SentMessageRecord>('sent')) {
    index.add({
      id: `sent:${key}`,
      kind: 'chat',
      title: '',
      body: r.plaintext,
      meta: 'أنا',
      date: r.created_at,
      link: `/direct-messages?c=${r.conversation_id}`,
    });
  }

  cached = { index, builtAt: Date.now(), user };
  return index;
}

export interface IndexProgress {
  done: number;
  total: number;
  failed: number;
}

/**
 * يفك على هذا الجهاز كل ما لم يُفك بعد من مراسلاتي وتعاميمي (بالترتيب لكل خيط)
 * ليصبح قابلًا للبحث. ما أُرسل قبل إضافة هذا الجهاز يبقى غير متاح — معلن.
 */
export async function decryptEverything(onProgress: (p: IndexProgress) => void): Promise<IndexProgress> {
  const ids = new Set<string>();
  for (const folder of ['inbox', 'sent', 'archived'] as Folder[]) {
    for (let page = 1; ; page++) {
      const res = await correspondenceApi.list({ folder, page });
      res.results.forEach((r) => ids.add(r.id));
      if (!res.next) break;
    }
  }
  const announcementIds = new Set<string>();
  for (const box of ['received', 'published'] as const) {
    for (let page = 1; ; page++) {
      const res = await announcementsApi.list(box, page);
      res.results.filter((a) => a.status !== 'draft').forEach((a) => announcementIds.add(a.id));
      if (!res.next) break;
    }
  }
  const progress: IndexProgress = { done: 0, total: ids.size + announcementIds.size, failed: 0 };
  onProgress({ ...progress });
  for (const id of ids) {
    try {
      const result = await openCorrespondence(await correspondenceApi.get(id));
      if (result.state !== 'ok') progress.failed += 1;
    } catch {
      progress.failed += 1;
    }
    progress.done += 1;
    onProgress({ ...progress });
  }
  for (const id of announcementIds) {
    try {
      const result = await openAnnouncement(await announcementsApi.get(id));
      if (result.state !== 'ok') progress.failed += 1;
    } catch {
      progress.failed += 1;
    }
    progress.done += 1;
    onProgress({ ...progress });
  }
  invalidateLocalIndex();
  return progress;
}
