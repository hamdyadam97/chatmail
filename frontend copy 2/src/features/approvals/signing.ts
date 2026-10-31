/**
 * توقيع قرارات الاعتماد والتحقق منها على العميل.
 *
 * الحمولة: JSON قانوني (مفاتيح مرتبة، بلا مسافات، ASCII فقط) — مطابق حرفيًا
 * لـ apps/approvals/services.canonical_bytes. التوقيع Ed25519 بمفتاح الجهاز فوق
 * SIGNING_CONTEXT ‖ الحمولة. الحمولة تربط القرار ببصمة SHA-256 للـciphertext
 * الذي فكّه المعتمد فعلًا — لذا نرفض التوقيع إن لم تطابق بصمة ما فككناه بصمة الطلب.
 *
 * هذا توقيع سلامة تشفيري يثبت من قرر وعلى أي نسخة، وليس توقيعًا إلكترونيًا
 * نظاميًا معتمدًا قانونيًا.
 */
import { b64ToU8, u8ToB64, utf8ToU8 } from '../../crypto/encoding';
import { cryptoApi } from '../../crypto/api';
import { loadCurrentDevice, signWithCurrentDevice } from '../../crypto/identity';
import type { ApprovalRequest, Decision, DecisionRecord } from './api';

const PAYLOAD_FIELDS = [
  'approver_id',
  'content_hash',
  'correspondence_id',
  'decided_at',
  'decision',
  'device_id',
  'on_behalf_of',
  'request_id',
  'step_order',
] as const;

type Payload = Record<(typeof PAYLOAD_FIELDS)[number], string | number | null>;

/** JSON قانوني بمطابقة json.dumps(sort_keys, separators=(",", ":"), ensure_ascii=True). */
export function canonicalJson(payload: Payload): string {
  const parts = [...PAYLOAD_FIELDS].sort().map((key) => `${JSON.stringify(key)}:${JSON.stringify(payload[key])}`);
  return `{${parts.join(',')}}`.replace(
    /[^\u0000-\u007f]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

async function sha256B64(data: Uint8Array): Promise<string> {
  return u8ToB64(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

export class ContentMismatchError extends Error {}

export async function signDecision(opts: {
  request: ApprovalRequest;
  userId: string;
  decision: Decision;
  /** base64 للـciphertext الذي فككناه (detail.content.mls_payload). */
  reviewedCiphertextB64: string;
}): Promise<{ payload: string; signature: string; device_id: string }> {
  const { request, userId, decision } = opts;
  if (!request.my_slot) throw new Error('لست معتمدًا في الخطوة الحالية');
  const reviewedHash = await sha256B64(b64ToU8(opts.reviewedCiphertextB64));
  if (reviewedHash !== request.content_hash) {
    throw new ContentMismatchError('بصمة المحتوى الذي فككته لا تطابق بصمة الطلب — لن يُوقَّع القرار');
  }
  const context = utf8ToU8(request.signing_context);
  const device = await loadCurrentDevice(userId);
  if (!device) throw new Error('لا توجد مفاتيح جهاز على هذا المتصفح');
  const payload: Payload = {
    approver_id: userId,
    content_hash: request.content_hash,
    correspondence_id: request.correspondence.id,
    decided_at: new Date().toISOString(),
    decision,
    device_id: String(device.deviceId),
    on_behalf_of: request.my_slot.delegated ? request.my_slot.slot_user_id : null,
    request_id: request.id,
    step_order: request.current_step_order,
  };
  const payloadBytes = utf8ToU8(canonicalJson(payload));
  const message = new Uint8Array(context.length + payloadBytes.length);
  message.set(context);
  message.set(payloadBytes, context.length);
  const { signature, deviceId } = await signWithCurrentDevice(userId, message);
  return { payload: u8ToB64(payloadBytes), signature: u8ToB64(signature), device_id: String(deviceId) };
}

export type VerifyResult = 'valid' | 'invalid' | 'unknown-device';

/**
 * يتحقق أي مشارك من قرار مخزن: التوقيع بمفتاح الجهاز من الدليل، وأن الحمولة
 * تطابق ما يعرضه الخادم (القرار، المعتمد، البصمة، الطلب).
 */
export async function verifyDecision(request: ApprovalRequest, record: DecisionRecord): Promise<VerifyResult> {
  const directory = await cryptoApi.queryKeys([record.approver.id]);
  const device = directory.users
    .flatMap((u) => u.devices)
    .find((d) => String(d.id) === String(record.device_id));
  if (!device) return 'unknown-device';
  try {
    const key = await crypto.subtle.importKey('raw', b64ToU8(device.sign_pub), { name: 'Ed25519' }, false, ['verify']);
    const payloadBytes = b64ToU8(record.payload);
    const context = utf8ToU8(request.signing_context);
    const message = new Uint8Array(context.length + payloadBytes.length);
    message.set(context);
    message.set(payloadBytes, context.length);
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, b64ToU8(record.signature), message);
    if (!ok) return 'invalid';
    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as Payload;
    const consistent =
      parsed.decision === record.decision &&
      parsed.approver_id === record.approver.id &&
      parsed.content_hash === request.content_hash &&
      parsed.request_id === request.id &&
      parsed.correspondence_id === request.correspondence.id &&
      parsed.device_id === record.device_id;
    return consistent ? 'valid' : 'invalid';
  } catch {
    return 'invalid';
  }
}
