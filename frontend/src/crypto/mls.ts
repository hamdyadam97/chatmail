/**
 * موجّه MLS — يربط غلاف الـWASM (عميل قصير العمر، §8.2) بمخزن IndexedDB
 * وبوابات الـbackend. الواجهات الحرجة:
 *
 * - الحالة: كل عملية تبني SpikeClient، تستورد أحدث لقطة (export_state يغطي
 *   كل المجموعات + KeyPackages المعلقة — درس §8.3/2)، تنفّذ، ثم تكتب اللقطة
 *   للمخزن. انقسام الجهاز إلى نسختين مرسلتين ممنوع بروتوكوليًا (split-brain،
 *   §8.3/5) لذا نتجنب أي مسار يعالج payload أرسلناه نحن من هذا الجهاز.
 * - ترتيب الإنشاء (محسوم من العقد): السيرفر يبدأ current_epoch=0؛ Commit
 *   يتطلب epoch==current+1 بينما Welcome يُنشر لجيله الحالي. لذلك: إنشاء
 *   المحادثة (0) ← نشر Welcome(s) بـ epoch=0 ← نشر Commit بـ epoch=1.
 * - العضو المضاف حديثًا ينضم عبر Welcome وحده ولا يعالج commit الإضافة
 *   (§8.3/3 — معالجته ترفض «incorrect epoch»).
 */
import { getSpikeClientClass } from './wasm';
import type { SpikeClient } from './wasm-pkg/mls_spike';
import { getAllRecords, getRecord, putRecord, putPublic, getPublic } from './keystore';
import { cryptoApi } from './api';
import { b64ToU8, u8ToB64, randomBytes, utf8ToU8, u8ToUtf8 } from './encoding';
import { loadCurrentDevice, loadIdentity } from './identity';
import { useAuthUser } from './authBridge';
import type { Conversation, Message } from '../features/chat/api';

// ---------------------------------------------------------------------------
// نقل الرسائل/المحادثات يحقن من طبقة chat (تفادي دورة استيراد بين الطبقتين).
// ---------------------------------------------------------------------------

export interface PostMessagePayload {
  kind: 'application' | 'commit' | 'welcome' | 'proposal';
  mls_payload: string;
  client_msg_id: string;
  epoch: number;
  sender_device_id?: number | string;
  recipient_device_id?: number | string;
  /** Welcome واحد مخزن مرة واحدة وموجّه لعدة أجهزة (المجموعات الكبيرة). */
  recipient_device_ids?: Array<number | string>;
  membership?: { added_user_ids: Array<number | string>; removed_user_ids: Array<number | string> };
  reply_to_seq?: number;
}

export interface MlsTransport {
  createConversation(payload: {
    type: 'dm' | 'group';
    member_user_ids: Array<number | string>;
    title_enc?: string;
    mls_group_id: string;
  }): Promise<Conversation>;
  postMessage(conversationId: number | string, payload: PostMessagePayload): Promise<unknown>;
  addServerMembers(conversationId: number | string, userIds: Array<number | string>): Promise<unknown>;
  removeServerMembers(conversationId: number | string, userIds: Array<number | string>): Promise<unknown>;
}

let transport: MlsTransport | null = null;

export function setMlsTransport(t: MlsTransport): void {
  transport = t;
}

function requireTransport(): MlsTransport {
  if (!transport) throw new Error('طبقة التشفير غير مهيأة (نقص تهيئة النقل)');
  return transport;
}

/** جهازنا الحالي — يُضبط عند بناء الجلسة؛ يُحقن كـsender_device_id تلقائيًا. */
let currentDeviceId: number | string | null = null;

/**
 * نشر رسالة MLS مع حقن sender_device_id تلقائيًا (الخادم يشترطه لكل
 * الأنواع عدا welcome). يجب أن تكون الجلسة قد بُنيت (getMlsSession).
 */
async function postAsDevice(
  conversationId: number | string,
  payload: PostMessagePayload,
): Promise<unknown> {
  if (payload.kind === 'welcome') {
    return requireTransport().postMessage(conversationId, payload);
  }
  if (currentDeviceId == null) throw new Error('لم تُبنَ جلسة الجهاز بعد');
  return requireTransport().postMessage(conversationId, {
    sender_device_id: currentDeviceId,
    ...payload,
  });
}

// ---------------------------------------------------------------------------
// حالة التسلسل لكل محادثة (غير سرية — تُخزن دون تشفير في meta).
// ---------------------------------------------------------------------------

export interface ChatSeqState {
  last_processed_seq: number;
  last_read_seq: number;
}

export async function getChatSeq(conversationId: number | string): Promise<ChatSeqState> {
  const stored = await getPublic<Partial<ChatSeqState>>('meta', `chat:${conversationId}`);
  return { last_processed_seq: stored?.last_processed_seq ?? 0, last_read_seq: stored?.last_read_seq ?? 0 };
}

export async function setLastReadSeq(conversationId: number | string, seq: number): Promise<void> {
  const current = await getChatSeq(conversationId);
  await putPublic('meta', `chat:${conversationId}`, { ...current, last_read_seq: seq });
}

async function setLastProcessedSeq(conversationId: number | string, seq: number): Promise<void> {
  const current = await getChatSeq(conversationId);
  await putPublic('meta', `chat:${conversationId}`, { ...current, last_processed_seq: seq });
}

// ---------------------------------------------------------------------------
// الجلسة: عميل واحد في الذاكرة لكل جهاز، اللقطة تُحمّل/تُحفظ حول كل عملية.
// ---------------------------------------------------------------------------

interface GroupRow {
  conversation_id: number | string;
  /** base64 — معرف مجموعة MLS (قد يختلف عن id المحادثة)؛ فارغ للقطات العامة. */
  mls_group_id?: string;
  epoch: number;
  blob: Uint8Array;
  updated_at: number;
}

let session: MlsSession | null = null;
/** صاحب الجلسة المخبأة — تُبنى من جديد عند تبدّل المستخدم. */
let sessionUser: string | null = null;

class MlsSession {
  private client: SpikeClient | null = null;
  constructor(
    private identityBytes: Uint8Array,
    private seed: Uint8Array,
  ) {}

  private async ensureClient(): Promise<SpikeClient> {
    const cls = await getSpikeClientClass();
    if (!this.client) {
      this.client = new cls(this.identityBytes, this.seed);
      const blob = await loadLatestBlob();
      if (blob) this.client.import_state(blob);
    }
    return this.client;
  }

  /** ينفّذ عملية على عميل محمّل بالحالة ويحفظ اللقطة بعدها. */
  async run<T>(
    conversationId: number | string,
    op: (client: SpikeClient) => Promise<{ value: T; groupId: Uint8Array }>,
  ): Promise<T> {
    const client = await this.ensureClient();
    const { value, groupId } = await op(client);
    await this.persist(client, conversationId, groupId);
    return value;
  }

  /** قراءة/عملية دون كتابة اللقطة (عند عدم تغيّر الحالة). */
  async peek<T>(op: (client: SpikeClient) => Promise<T>): Promise<T> {
    const client = await this.ensureClient();
    return op(client);
  }

  private async persist(client: SpikeClient, conversationId: number | string, groupId: Uint8Array): Promise<void> {
    let epoch = 0;
    try {
      epoch = Number(client.epoch(groupId));
    } catch {
      epoch = 0; // مجموعة لم تكتمل بعد (مثلًا فشل انضمام)
    }
    const blob = client.export_state(groupId);
    const row: GroupRow = {
      conversation_id: conversationId,
      mls_group_id: groupId.length > 0 ? u8ToB64(groupId) : undefined,
      epoch,
      blob: new Uint8Array(blob),
      updated_at: Date.now(),
    };
    await putRecord('groups', String(conversationId), row);
  }

  /** حفظ اللقطة الحالية تحت محادثة (بعد عمليات عبر peek). */
  async persistCurrent(conversationId: number | string, groupId: Uint8Array): Promise<number> {
    const client = await this.ensureClient();
    await this.persist(client, conversationId, groupId);
    try {
      return Number(client.epoch(groupId));
    } catch {
      return 0; // لم تنشأ المجموعة محليًا بعد (مثلًا Welcome لجهاز آخر)
    }
  }

  /** حفظ لقطة عامة (KeyPackages المعلّقة وغيرها) — مفتاح خاص لا يتصادم مع المحادثات. */
  async persistSnapshot(tag: string): Promise<void> {
    const client = await this.ensureClient();
    const blob = client.export_state(new Uint8Array(0));
    const row: GroupRow = { conversation_id: tag, epoch: 0, blob: new Uint8Array(blob), updated_at: Date.now() };
    await putRecord('groups', tag, row);
  }

  fullExport(): Uint8Array {
    if (!this.client) throw new Error('لا توجد حالة MLS محمّلة للتصدير');
    return new Uint8Array(this.client.export_state(new Uint8Array(0)));
  }
}

async function loadLatestBlob(): Promise<Uint8Array | undefined> {
  const rows = await getAllRecords<GroupRow>('groups');
  if (rows.length === 0) return undefined;
  // كل اللقطات شاملة (export_state يصدّر كل شيء)؛ الأحدث هو الكامل.
  const latest = rows.reduce((a, b) => (a.updated_at >= b.updated_at ? a : b));
  return latest.blob;
}

export async function getMlsSession(): Promise<MlsSession> {
  const userId = useAuthUser().id;
  if (session && sessionUser === String(userId)) return session;
  session = null;
  currentDeviceId = null;
  sessionUser = String(userId);
  const [identity, device] = await Promise.all([loadIdentity(userId), loadCurrentDevice(userId)]);
  if (!identity || !device) throw new Error('لم تُهيّأ الهوية التشفيرية بعد على هذا الجهاز');
  const identityBytes = utf8ToU8(`${identity.userId}|${device.deviceId}`);
  currentDeviceId = device.deviceId;
  session = new MlsSession(identityBytes, device.signSeed);
  return session;
}

/** لأغراض الاستعادة: يسقط الجلسة المخبأة لتُبنى من الحالة المستوردة. */
export async function resetMlsSession(): Promise<void> {
  session = null;
}

// ---------------------------------------------------------------------------
// KeyPackage الخاصة بجهازنا.
// ---------------------------------------------------------------------------

async function sha256B64(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return u8ToB64(new Uint8Array(digest));
}

/**
 * يضمن رفع مجموعة KeyPackages حديثة لجهازنا (active فقط) — تجمع صغير
 * (افتراضيًا 3) يكفي مزامنة عدة محادثات عند إضافة جهاز جديد (كل Claim
 * يستهلك واحدة). المولّدات تبقى في KeyPackageRepository داخل اللقطة (درس
 * §8.3/2 — شرط نجاح قبول Welcome لاحقًا)؛ لذلك نحفظ اللقطة بعد التوليد
 * وإلا فشل الانضمام «key package not found».
 */
export async function ensureKeyPackage(poolSize = 3): Promise<void> {
  const mls = await getMlsSession();
  const kps: Uint8Array[] = [];
  for (let i = 0; i < poolSize; i++) {
    kps.push(await mls.peek(async (client) => new Uint8Array(client.key_package())));
  }
  await mls.persistSnapshot('self'); // يحفظ أسرار الـKPs في اللقطة (درس 2)
  for (const kp of kps) {
    const hash = await sha256B64(kp);
    await cryptoApi.uploadKeyPackage({ keypackage: u8ToB64(kp), keypackage_hash: hash });
    await putRecord('kps', hash, { hash, created_at: new Date().toISOString(), uploaded_at: new Date().toISOString() });
  }
}

// ---------------------------------------------------------------------------
// إنشاء/انضمام/مزامنة المحادثات.
// ---------------------------------------------------------------------------

function activeDirectoryDevices(directoryUsers: { devices: { id: number | string; status: string }[] }[]) {
  const ids: Array<number | string> = [];
  for (const user of directoryUsers) {
    for (const device of user.devices) {
      if (device.status === 'active') ids.push(device.id);
    }
  }
  return ids;
}

export interface CreateConversationInput {
  type: 'dm' | 'group';
  memberUserIds: Array<number | string>;
  title?: string;
}

/**
 * إنشاء محادثة: دليل المفاتيح ← Claim لكل جهاز نشط ← مجموعة محلية ← محادثة
 * على السيرفر ← Welcome(s) بـ epoch=0 ← Commit بـ epoch=1. انظر ترويسة الملف.
 */
export async function createConversation(input: CreateConversationInput): Promise<Conversation> {
  const t = requireTransport();
  const mls = await getMlsSession();
  const me = useAuthUser().id;

  const directory = await cryptoApi.queryKeys([me, ...input.memberUserIds]);
  const others = directory.users.filter((u) => String(u.user_id) !== String(me));
  const memberDeviceIds = activeDirectoryDevices(others);
  if (memberDeviceIds.length === 0) {
    throw new Error('لا أجهزة نشطة لدى الأعضاء المحددين');
  }

  const claimed = await cryptoApi.claimKeyPackages(memberDeviceIds);
  if (claimed.length === 0) throw new Error('تعذر استلام حزم المفاتيح من السيرفر');

  const groupId = randomBytes(16); // 16-32 بايت حسب العقد
  const kpMessages = claimed.map((c) => b64ToU8(c.keypackage));

  const prepared = await mls.run('pending', async (client) => {
    const out = client.create_group(groupId, kpMessages) as Array<Uint8Array>;
    const commit = new Uint8Array(out[0]);
    // §8.3/4: welcome واحد مدمج لكل المضافين في commit واحد — ننشره لكل
    // مستلم عبر صف welcome منفصل (recipient_device_id).
    const welcome = new Uint8Array(out[1]);
    let titleEnc: string | undefined;
    if (input.title) {
      const titleCt = client.encrypt(groupId, utf8ToU8(input.title));
      titleEnc = u8ToB64(new Uint8Array(titleCt));
    }
    return { value: { commit, welcome, titleEnc }, groupId };
  });

  const conversation = await t.createConversation({
    type: input.type,
    member_user_ids: input.memberUserIds,
    title_enc: prepared.titleEnc,
    mls_group_id: u8ToB64(groupId),
  });

  // Welcome(s) قبل الـ Commit وبجيل النشر الحالي (0) — انظر ترويسة الملف.
  for (const claimedItem of claimed) {
    await postAsDevice(conversation.id, {
      kind: 'welcome',
      mls_payload: u8ToB64(prepared.welcome),
      client_msg_id: crypto.randomUUID(),
      epoch: 0,
      recipient_device_id: claimedItem.device_id,
    });
  }

  await postAsDevice(conversation.id, {
    kind: 'commit',
    mls_payload: u8ToB64(prepared.commit),
    client_msg_id: crypto.randomUUID(),
    epoch: 1,
    membership: { added_user_ids: input.memberUserIds, removed_user_ids: [] },
  });

  await mls.persistCurrent(conversation.id, groupId);
  return conversation;
}

/**
 * خيط مراسلة رسمية (docs/phase1/03 §3.4): الخادم أنشأ المحادثة بالمعرف الذي
 * ولّدناه؛ هنا نبني المجموعة محليًا ونضيف كل جهاز نشط للمستلمين ولأجهزتي
 * الأخرى (لأقرأ الصادر منها)، ثم Welcome(s) بجيل 0 وCommit بجيل 1.
 * يرفض البدء إن كان مستلم بلا أي جهاز جاهز — وإلا وصلته مراسلة لا يستطيع فكها.
 */
const BATCH = 200;

export async function initThreadGroup(
  thread: { id: number | string; mls_group_id: string },
  recipientUserIds: Array<number | string>,
): Promise<number> {
  const mls = await getMlsSession();
  const me = String(useAuthUser().id);
  // الدليل والـclaim محدودان بـ200 معرّف للنداء — نجزّئ (تعاميم حتى 1000 مستلم).
  const users = [me, ...recipientUserIds];
  const directory = { users: [] as Awaited<ReturnType<typeof cryptoApi.queryKeys>>['users'] };
  for (let i = 0; i < users.length; i += BATCH) {
    directory.users.push(...(await cryptoApi.queryKeys(users.slice(i, i + BATCH))).users);
  }
  const deviceIds = activeDirectoryDevices(directory.users).filter(
    (id) => String(id) !== String(currentDeviceId),
  );
  const claimed: Awaited<ReturnType<typeof cryptoApi.claimKeyPackages>> = [];
  for (let i = 0; i < deviceIds.length; i += BATCH) {
    claimed.push(...(await cryptoApi.claimKeyPackages(deviceIds.slice(i, i + BATCH))));
  }

  const ownerOf = new Map<string, string>();
  for (const user of directory.users) {
    for (const device of user.devices) ownerOf.set(String(device.id), String(user.user_id));
  }
  const covered = new Set(claimed.map((c) => ownerOf.get(String(c.device_id))));
  const unreachable = recipientUserIds.filter((id) => !covered.has(String(id)));
  if (unreachable.length > 0) {
    const error = new Error('بعض المستلمين لا يملكون جهازًا مفعّل التشفير بعد') as Error & {
      unreachableUserIds?: string[];
    };
    error.unreachableUserIds = unreachable.map(String);
    throw error;
  }

  const groupId = b64ToU8(thread.mls_group_id);
  const prepared = await mls.run(thread.id, async (client) => {
    const out = client.create_group(
      groupId,
      claimed.map((c) => b64ToU8(c.keypackage)),
    ) as Array<Uint8Array>;
    return { value: { commit: new Uint8Array(out[0]), welcome: new Uint8Array(out[1]) }, groupId };
  });
  // Welcome واحد لكل المضافين (§8.3/4) — يُخزن مرة واحدة على الخادم.
  if (claimed.length > 0) {
    await postAsDevice(thread.id, {
      kind: 'welcome',
      mls_payload: u8ToB64(prepared.welcome),
      client_msg_id: crypto.randomUUID(),
      epoch: 0,
      recipient_device_ids: claimed.map((c) => c.device_id),
    });
  }
  await postAsDevice(thread.id, {
    kind: 'commit',
    mls_payload: u8ToB64(prepared.commit),
    client_msg_id: crypto.randomUUID(),
    epoch: 1,
    membership: { added_user_ids: recipientUserIds, removed_user_ids: [] },
  });
  return mls.persistCurrent(thread.id, groupId);
}

/**
 * هل ورقة مرسل MLS الموثّقة (senderIndex من process) هي فعلًا (المستخدم،
 * الجهاز) الذي يدّعيه الخادم؟ يمنع خادمًا خبيثًا من نسب محتوى عضو لآخر.
 */
export async function verifyMlsSender(
  conversation: Pick<Conversation, 'mls_group_id'>,
  senderUserId: number | string,
  senderDeviceId: number | string,
  senderIndex: number | undefined,
): Promise<boolean> {
  if (senderIndex === undefined) return false;
  const mls = await getMlsSession();
  const groupId = b64ToU8(conversation.mls_group_id);
  return mls.peek(async (client) => {
    try {
      const expected = client.member_index(groupId, utf8ToU8(`${senderUserId}|${senderDeviceId}`));
      return Number(expected) === Number(senderIndex);
    } catch {
      return false;
    }
  });
}

/** معرف جهازنا الحالي (بعد بناء الجلسة). */
export async function getCurrentDeviceId(): Promise<number | string> {
  await getMlsSession();
  if (currentDeviceId == null) throw new Error('لم تُبنَ جلسة الجهاز بعد');
  return currentDeviceId;
}

export interface FeedResult {
  /** آخر seq عولج (نجاحًا أو فشلًا معزولًا). */
  lastProcessedSeq: number;
  /** انضممنا عبر Welcome في هذه الجولة. */
  joined: boolean;
  /** نتائج فك التشفير لكل seq (لعرض الواجهة). senderIndex = ورقة المرسل الموثّقة في MLS. */
  decrypted: Map<number, { plaintext?: string; failed: boolean; senderIndex?: number }>;
}

export interface FeedOptions {
  /**
   * فلتر الجيل للّحاق التاريخي: بعد انضمامنا عبر Welcome في هذه الدفعة،
   * تُتخطى (دون معالجة، مع تقديم last_processed_seq فوقها) الرسائل
   * المخزنة التي جيلها أقدم من جيل انضمامنا — MLS سيرفضها لا محالة
   * (مفتاح ذلك الجيل لم يُسلَّم لنا)، ومعالجتها تحرق مواقع seq وتملأ
   * الخيط بـ«تعذر فك التشفير». أحداث WS الحية لا تمرّر هذا الخيار —
   * كل حدث يُعالج لحظ وصوله.
   */
  epochFilter?: boolean;
}

/**
 * يغذّي رسائل MLS بالترتيب إلى الغلاف: Welcome خاص بنا ← انضمام؛ رسائلنا
 * نحن (sender_device == جهازنا) تُتخطى (طبّقناها محليًا — split-brain)؛
 * الباقي يُعالج، والفشل التشفيري لرسالة واحدة (مثلًا ما قبل انضمامنا)
 * يُحصر بها ولا يكسر الخيط.
 */
export async function feedMessages(
  conversation: Pick<Conversation, 'id' | 'mls_group_id'>,
  messages: Message[],
  myDeviceId: number | string,
  opts?: FeedOptions,
): Promise<FeedResult> {
  const mls = await getMlsSession();
  const groupId = b64ToU8(conversation.mls_group_id);
  const { last_processed_seq } = await getChatSeq(conversation.id);
  const result: FeedResult = { lastProcessedSeq: last_processed_seq, joined: false, decrypted: new Map() };
  const fresh = messages
    .filter((m) => m.seq > last_processed_seq)
    .sort((a, b) => a.seq - b.seq);
  if (fresh.length === 0) return result;

  let changed = false;
  let joinedNow = false;
  /** جيل انضمامنا عبر Welcome في هذه الدفعة (undefined = لم ننضم الآن). */
  let joinEpoch: number | undefined;

  await mls.peek(async (client) => {
    for (const message of fresh) {
      // فلتر الجيل: ما هو أقدم من جيل انضمامنا لم يُوجَّه لنا أصلًا — نتخطاه
      // دون لمس حالة المجموعة (لكن نتقدم فوقه في التسلسل).
      if (opts?.epochFilter && joinEpoch !== undefined && message.epoch < joinEpoch) {
        result.lastProcessedSeq = message.seq;
        continue;
      }
      try {
        if (message.kind === 'welcome') {
          try {
            client.join_from_welcome(b64ToU8(message.mls_payload));
            joinedNow = true;
            changed = true;
            if (opts?.epochFilter) {
              try {
                joinEpoch = Number(client.epoch(groupId));
              } catch {
                joinEpoch = undefined;
              }
            }
          } catch {
            // Welcome موجه لجهاز آخر لنا أو ليس لنا — نتجاوزه.
          }
        } else if (String(message.sender_device_id) === String(myDeviceId)) {
          // رسالتنا نحن: طبّقناها محليًا قبل النشر (§8.3/5).
        } else {
          const processed = client.process(groupId, b64ToU8(message.mls_payload)) as {
            type: string;
            plaintext?: Uint8Array;
            sender_index?: number;
          };
          if (processed.type === 'application') {
            result.decrypted.set(message.seq, {
              plaintext: u8ToUtf8(new Uint8Array(processed.plaintext ?? new Uint8Array(0))),
              failed: false,
              senderIndex: processed.sender_index,
            });
          }
          changed = true;
        }
      } catch {
        // فشل تشفيري معزول (مثلًا ciphertext بجيل قبل انضمامنا — SEC-07):
        // نُظهر «تعذر فك التشفير» للرسالة ونكمل.
        if (message.kind === 'application') {
          result.decrypted.set(message.seq, { failed: true });
        }
        changed = true; // قد تكون حالة المجموعة تقدمت جزئيًا — نحفظ ما انتهى إليه الأمر
      }
      result.lastProcessedSeq = message.seq;
    }
    return undefined;
  });

  if (changed) {
    await mls.persistCurrent(conversation.id, groupId);
  }
  result.joined = joinedNow;
  await setLastProcessedSeq(conversation.id, result.lastProcessedSeq);
  return result;
}

/** مزامنة/لحاق: يجلب ما بعد آخر seq معالج ويغذّيه بالترتيب. */
export async function syncConversation(
  conversation: Pick<Conversation, 'id' | 'mls_group_id'>,
  myDeviceId: number | string,
  fetchMessages: (
    conversationId: number | string,
    afterSeq: number,
  ) => Promise<{ current_epoch: number; messages: Message[] }>,
): Promise<FeedResult> {
  const { last_processed_seq } = await getChatSeq(conversation.id);
  const batch = await fetchMessages(conversation.id, last_processed_seq);
  return feedMessages(conversation, batch.messages, myDeviceId, { epochFilter: true });
}

// ---------------------------------------------------------------------------
// الرسائل.
// ---------------------------------------------------------------------------

export interface EncryptedOutgoing {
  mls_payload_b64: string;
  epoch: number;
}

export async function encryptMessage(
  conversation: Pick<Conversation, 'id' | 'mls_group_id'>,
  text: string,
): Promise<EncryptedOutgoing> {
  const mls = await getMlsSession();
  const groupId = b64ToU8(conversation.mls_group_id);
  return mls.run(conversation.id, async (client) => {
    const ct = client.encrypt(groupId, utf8ToU8(text));
    return { value: { mls_payload_b64: u8ToB64(new Uint8Array(ct)), epoch: Number(client.epoch(groupId)) }, groupId };
  });
}

/** يفك رسالة واحدة خارج خط المزامنة (ندرة — الأصل التغذية بالترتيب). */
export async function decryptMessage(
  conversation: Pick<Conversation, 'id' | 'mls_group_id'>,
  mlsPayloadB64: string,
): Promise<string> {
  const mls = await getMlsSession();
  const groupId = b64ToU8(conversation.mls_group_id);
  return mls.run(conversation.id, async (client) => {
    const processed = client.process(groupId, b64ToU8(mlsPayloadB64)) as { plaintext?: Uint8Array };
    return { value: u8ToUtf8(new Uint8Array(processed.plaintext ?? new Uint8Array(0))), groupId };
  });
}

const titleCache = new Map<string, string>();

/** عناوين المحادثات المشفرة: تُفك كرسالة تطبيق لجيلها عبر حالة المجموعة. */
export async function decryptTitle(
  conversation: Pick<Conversation, 'id' | 'mls_group_id' | 'title_enc'>,
): Promise<string | undefined> {
  if (!conversation.title_enc) return undefined;
  const cacheKey = `${conversation.id}:${conversation.title_enc.slice(0, 32)}`;
  const hit = titleCache.get(cacheKey);
  if (hit !== undefined) return hit;
  try {
    const mls = await getMlsSession();
    const groupId = b64ToU8(conversation.mls_group_id);
    const value = await mls.peek(async (client) => {
      const processed = client.process(groupId, b64ToU8(conversation.title_enc!)) as {
        type: string;
        plaintext?: Uint8Array;
      };
      if (processed.type !== 'application') return undefined;
      return u8ToUtf8(new Uint8Array(processed.plaintext ?? new Uint8Array(0)));
    });
    if (value !== undefined) titleCache.set(cacheKey, value);
    return value;
  } catch {
    // عنوان بجيل قبل انضمامنا أو غير قابل للفك — تعود الواجهة لعنوان احتياطي.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// إدارة الأعضاء (Commits + Welcome للمضافين).
// ---------------------------------------------------------------------------

/**
 * إضافة أعضاء: تسجيلهم على السيرفر ← Welcome لكل جهاز نشط (بجيل النشر)
 * ← Commit بجيل current+1. commit واحد لكل جهاز (الغلاف يCommit لكل KP).
 */
export async function addMembers(
  conversation: Pick<Conversation, 'id' | 'mls_group_id' | 'current_epoch'>,
  userIds: Array<number | string>,
): Promise<void> {
  const t = requireTransport();
  const mls = await getMlsSession();
  const groupId = b64ToU8(conversation.mls_group_id);

  const directory = await cryptoApi.queryKeys(userIds);
  const deviceIds = activeDirectoryDevices(directory.users);
  if (deviceIds.length === 0) throw new Error('لا أجهزة نشطة لدى الأعضاء الجدد');
  const claimed = await cryptoApi.claimKeyPackages(deviceIds);

  await t.addServerMembers(conversation.id, userIds);

  let epoch = conversation.current_epoch;
  for (const item of claimed) {
    const step = await mls.run(conversation.id, async (client) => {
      const out = client.add_member(groupId, b64ToU8(item.keypackage)) as Array<Uint8Array>;
      return {
        value: { commit: new Uint8Array(out[0]), welcome: new Uint8Array(out[1]) },
        groupId,
      };
    });
    await postAsDevice(conversation.id, {
      kind: 'welcome',
      mls_payload: u8ToB64(step.welcome),
      client_msg_id: crypto.randomUUID(),
      epoch,
      recipient_device_id: item.device_id,
    });
    await postAsDevice(conversation.id, {
      kind: 'commit',
      mls_payload: u8ToB64(step.commit),
      client_msg_id: crypto.randomUUID(),
      epoch: epoch + 1,
      membership: { added_user_ids: userIds, removed_user_ids: [] },
    });
    epoch += 1;
  }
}

/** إزالة أعضاء: يزيل كل هوية `userId|deviceId` من المجموعة (commit/عضو). */
export async function removeMembers(
  conversation: Pick<Conversation, 'id' | 'mls_group_id' | 'current_epoch'>,
  userIds: Array<number | string>,
): Promise<void> {
  const t = requireTransport();
  const mls = await getMlsSession();
  const groupId = b64ToU8(conversation.mls_group_id);

  const targets = await mls.peek(async (client) => {
    const identities = client.member_identities(groupId) as Array<Uint8Array>;
    const wanted = new Set(userIds.map(String));
    return identities
      .map((idBytes) => u8ToUtf8(new Uint8Array(idBytes)))
      .filter((identity) => wanted.has(identity.split('|')[0]))
      .map((identity) => utf8ToU8(identity));
  });
  if (targets.length === 0) throw new Error('الأعضاء المحددون ليسوا في المجموعة');

  await t.removeServerMembers(conversation.id, userIds);

  let epoch = conversation.current_epoch;
  for (const identityBytes of targets) {
    const commit = await mls.run(conversation.id, async (client) => {
      const bytes = client.remove_member(groupId, identityBytes);
      return { value: new Uint8Array(bytes), groupId };
    });
    await postAsDevice(conversation.id, {
      kind: 'commit',
      mls_payload: u8ToB64(commit),
      client_msg_id: crypto.randomUUID(),
      epoch: epoch + 1,
      membership: { added_user_ids: [], removed_user_ids: userIds },
    });
    epoch += 1;
  }
}

// ---------------------------------------------------------------------------
// مزامنة جهاز جديد مع المجموعات (§3.3 — بعد اعتماد الجهاز من جهاز موثّق):
// الجهاز الموثّق (نحن) يضيف الجهاز الجديد لكل مجموعة MLS ينتمي إليها
// المستخدم عبر Commit+Welcome — المستخدم عضو أصلًا فلا metadata للعضوية
// (الخادم لا يشترط دورًا إداريًا دونها)، ويبقى الجهاز الجديد يلحق عبر
// Welcome وحده كأي عضو جديد.
// ---------------------------------------------------------------------------

const NON_CONVERSATION_TAGS = new Set(['self', 'imported', 'pending']);

export interface DeviceSyncSummary {
  /** محادثات أُضيف إليها الجهاز الجديد بنجاح. */
  synced: Array<number | string>;
  /** محادثات مُنيت بتخطٍّ مع سبب (عضو مسبقًا / لا KP / تعارض جيل / غير معروفة). */
  skipped: Array<{ id: number | string; reason: string }>;
}

export async function syncNewDeviceToGroups(newDeviceId: number | string): Promise<DeviceSyncSummary> {
  const summary: DeviceSyncSummary = { synced: [], skipped: [] };
  const userId = useAuthUser().id;
  const targetIdentity = `${userId}|${newDeviceId}`;

  // صفوف المحادثات من المخزن المحلي (تتجاهل القطات العامة والصفوف القديمة
  // التي لا تحمل mls_group_id — لا يمكن ربطها بمجموعة دون معرفها).
  const rows = (await getAllRecords<GroupRow>('groups')).filter(
    (row) => !NON_CONVERSATION_TAGS.has(String(row.conversation_id)) && Boolean(row.mls_group_id),
  );
  if (rows.length === 0) return summary;

  const mls = await getMlsSession();
  // يجمع كل الـclaims دفعة واحدة: Claim يستهلك KP واحدة لكل جهاز.
  const needsSync: Array<{ row: GroupRow; groupId: Uint8Array }> = [];

  await mls.peek(async (client) => {
    for (const row of rows) {
      const groupId = b64ToU8(row.mls_group_id!);
      let identities: string[];
      try {
        identities = (client.member_identities(groupId) as Array<Uint8Array>).map((raw) =>
          u8ToUtf8(new Uint8Array(raw)),
        );
      } catch {
        summary.skipped.push({ id: row.conversation_id, reason: 'unknown-group' });
        continue; // ليست مجموعة محمّلة في حالتنا الحالية
      }
      if (identities.includes(targetIdentity)) {
        summary.skipped.push({ id: row.conversation_id, reason: 'already-member' });
        continue;
      }
      // أنفسنا في المجموعة شرط مسبق (نضيف نيابةً عن المستخدم).
      if (!identities.some((identity) => identity.startsWith(`${userId}|`))) {
        summary.skipped.push({ id: row.conversation_id, reason: 'not-our-group' });
        continue;
      }
      needsSync.push({ row, groupId });
    }
    return undefined;
  });

  if (needsSync.length === 0) return summary;

  // Claim لكل محادثة على حدة: كل Claim يستهلك KP واحدة للجهاز؛ إن نفدت
  // المجموعة سجّلنا التخطي وانتهينا (الجهاز الجديد يرفع تجمع KPs عند
  // تفعيله — انظر ensureKeyPackage).
  for (const { row, groupId } of needsSync) {
    let item: { keypackage: string } | undefined;
    try {
      const claimed = await cryptoApi.claimKeyPackages([newDeviceId]);
      item = claimed[0];
    } catch {
      item = undefined;
    }
    if (!item) {
      summary.skipped.push({ id: row.conversation_id, reason: 'no-keypackage' });
      continue;
    }
    const baseEpoch = row.epoch;
    try {
      const step = await mls.run(row.conversation_id, async (client) => {
        const out = client.add_member(groupId, b64ToU8(item!.keypackage)) as Array<Uint8Array>;
        return {
          value: { commit: new Uint8Array(out[0]), welcome: new Uint8Array(out[1]) },
          groupId,
        };
      });
      // Welcome بجيل النشر الحالي ثم Commit بجيل current+1 — بلا أي
      // membership metadata (المستخدم عضو أصلًا، والخادم يشترط الأدمن
      // فقط عند وجودها).
      await postAsDevice(row.conversation_id, {
        kind: 'welcome',
        mls_payload: u8ToB64(step.welcome),
        client_msg_id: crypto.randomUUID(),
        epoch: baseEpoch,
        recipient_device_id: newDeviceId,
      });
      await postAsDevice(row.conversation_id, {
        kind: 'commit',
        mls_payload: u8ToB64(step.commit),
        client_msg_id: crypto.randomUUID(),
        epoch: baseEpoch + 1,
      });
      summary.synced.push(row.conversation_id);
    } catch (err) {
      const status = (err as { status?: number }).status;
      summary.skipped.push({
        id: row.conversation_id,
        reason: status === 409 ? 'epoch-conflict' : 'sync-failed',
      });
      // جيل الصف محلي أقدم من جيل السيرفر — نوقف؛ اللحاق التالي عند فتح
      // المحادثة يعيد التوازن (409 يتضمن current_epoch للمفارقة لاحقًا).
      break;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// تصدير/استيراد الحالة (للاستعادة §3.6).
// ---------------------------------------------------------------------------

/** هويات المستخدمين في المجموعة من roster الغلاف (`userId|deviceId`). */
export async function rosterUserIds(
  conversation: Pick<Conversation, 'mls_group_id'>,
): Promise<Array<number | string>> {
  const mls = await getMlsSession();
  const groupId = b64ToU8(conversation.mls_group_id);
  return mls.peek(async (client) => {
    const identities = client.member_identities(groupId) as Array<Uint8Array>;
    const users = new Set<string>();
    for (const raw of identities) {
      users.add(u8ToUtf8(new Uint8Array(raw)).split('|')[0]);
    }
    return [...users];
  });
}

// ---------------------------------------------------------------------------
// كاش رسائلنا المرسلة: MLS لا يمكّن من فك رسائلنا (نفس الورقة) — نخزن
// نصوصنا مشفّرة بالـKEK محليًا (مخالفة «لا نصوص صريحة إلا مشفرة» §3.9).
// ---------------------------------------------------------------------------

export interface SentMessageRecord {
  client_msg_id: string;
  conversation_id: number | string;
  seq: number | null;
  plaintext: string;
  reply_to_seq: number | null;
  created_at: string;
}

export async function saveSentMessage(record: SentMessageRecord): Promise<void> {
  await putRecord('sent', record.client_msg_id, record);
}

export async function getSentMessage(clientMsgId: string): Promise<SentMessageRecord | undefined> {
  return getRecord<SentMessageRecord>('sent', clientMsgId);
}

export async function attachSeqToSent(clientMsgId: string, seq: number): Promise<void> {
  const record = await getSentMessage(clientMsgId);
  if (record) await putRecord('sent', clientMsgId, { ...record, seq });
}

export async function exportGroupState(): Promise<Uint8Array> {
  const mls = await getMlsSession();
  await mls.peek(async () => undefined); // ضمان تحميل الحالة
  return mls.fullExport();
}

export async function importGroupState(blob: Uint8Array): Promise<void> {
  const mls = await getMlsSession();
  await mls.peek(async (client) => {
    client.import_state(blob);
    return undefined;
  });
  // حفظ كمحادثة وهمية تُدمج لاحقًا عبر loadLatestBlob.
  await putRecord('groups', 'imported', {
    conversation_id: 'imported',
    epoch: 0,
    blob: new Uint8Array(blob),
    updated_at: Date.now(),
  });
}
