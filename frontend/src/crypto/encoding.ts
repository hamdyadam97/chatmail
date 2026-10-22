/**
 * تحويلات ترميز مركزية لطبقة التشفير (base64 / hex / base32 / UTF-8).
 * كل القيم العابرة للشبكة base64 (b64 = base64 قياسي، آمن في JSON).
 */

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function u8ToB64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const c = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += B64_CHARS[a >> 2];
    out += B64_CHARS[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64_CHARS[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64_CHARS[c & 0x3f];
  }
  return out;
}

export function b64ToU8(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, '');
  const bytes: number[] = [];
  let carry = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64_CHARS.indexOf(ch);
    if (v < 0) throw new Error('base64 غير صالح');
    carry = (carry << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((carry >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

export function u8ToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToU8(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error('hex غير صالح');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const B32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** base32 (RFC 4648، بدون حشو) — يُستخدم لمفتاح الاستعادة القابل للقراءة. */
export function u8ToBase32(bytes: Uint8Array): string {
  let out = '';
  let carry = 0;
  let bits = 0;
  for (const b of bytes) {
    carry = (carry << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32_CHARS[(carry >> bits) & 0x1f];
    }
  }
  if (bits > 0) out += B32_CHARS[(carry << (5 - bits)) & 0x1f];
  return out;
}

export function base32ToU8(b32: string): Uint8Array {
  const clean = b32.replace(/[\s-]+/g, '').toUpperCase();
  const bytes: number[] = [];
  let carry = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B32_CHARS.indexOf(ch);
    if (v < 0) throw new Error('رمز base32 غير صالح');
    carry = (carry << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((carry >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

export function utf8ToU8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function u8ToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** عشوائية آمنة عبر WebCrypto فقط (لا Math.random لأي مادة سرية). */
export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

/** معرّف UUID v4 لـ client_msg_id. */
export function uuid4(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = u8ToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
