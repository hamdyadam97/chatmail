import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Fingerprint, RefreshCw, ShieldCheck, ShieldX } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, Spinner } from '../../shared/ui';
import { cryptoApi, type TransparencyEntry } from '../../crypto/api';
import { b64ToU8, u8ToHex } from '../../crypto/encoding';
import { loadIdentity } from '../../crypto/identity';
import { APP_VERSION } from '../../shared/lib/appInfo';
import { useAuth } from '../auth/AuthContext';
import { cn } from '../../shared/lib/cn';
import { MySecurityEvents } from '../audit/pages';

/**
 * فحص سلسلة الشفافية (§3.8) — مطابق لتنفيذ الـbackend
 * (apps/crypto_keys/transparency.py):
 * - ‏entry_hash = SHA-256(prev_hash_bytes ‖ canonical_json(payload)) حيث
 *   canonical_json = JSON مرتبة المفاتيح، فواصل مدمجة، UTF-8.
 * - التوقيع Ed25519 بمفتاح السجل العام فوق entry_hash الخام.
 * - الربط: prev_hash للعنصر الأول = GENESIS_PREV_HASH الثابت، ولكل عنصر
 *   لاحق = entry_hash السابق.
 */
const GENESIS_SOURCE = 'correspondence-key-transparency-genesis-v1'; // ثابت الخادم

function canonicalJsonBytes(payload: Record<string, unknown>): Uint8Array {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(payload).sort()) sorted[key] = payload[key];
  return new TextEncoder().encode(JSON.stringify(sorted));
}

async function sha256B64(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

interface CheckRow {
  entry: TransparencyEntry;
  signatureOk: boolean | null; // null = تعذر التحقق (مثلًا مفتاح السجل غير متاح)
  integrityOk: boolean | null;
  linkOk: boolean | null;
}

async function verifyChain(entries: TransparencyEntry[], logPubB64: string | undefined): Promise<CheckRow[]> {
  let verifyKey: CryptoKey | null = null;
  if (logPubB64) {
    try {
      verifyKey = await crypto.subtle.importKey('raw', b64ToU8(logPubB64), { name: 'Ed25519' }, false, ['verify']);
    } catch {
      verifyKey = null;
    }
  }
  // genesis المحلي — مطابق لثابت الخادم (نفس النص، نفس خوارزمية SHA-256).
  const genesisB64 = await sha256B64(new TextEncoder().encode(GENESIS_SOURCE));

  const rows: CheckRow[] = [];
  let prevEntryHashB64: string | null = null;
  for (const entry of entries) {
    const prevHashBytes = b64ToU8(entry.prev_hash);
    const recomputedHashB64 = await sha256B64(concatBytesForChain(prevHashBytes, canonicalJsonBytes(entry.payload)));
    const integrityOk = recomputedHashB64 === entry.entry_hash;

    let signatureOk: boolean | null = null;
    if (verifyKey) {
      try {
        signatureOk = await crypto.subtle.verify(
          { name: 'Ed25519' },
          verifyKey,
          b64ToU8(entry.log_signature),
          b64ToU8(entry.entry_hash),
        );
      } catch {
        signatureOk = false;
      }
    }

    const linkOk =
      prevEntryHashB64 === null
        ? entry.prev_hash === genesisB64
        : entry.prev_hash === prevEntryHashB64;

    rows.push({ entry, signatureOk, integrityOk, linkOk });
    prevEntryHashB64 = entry.entry_hash;
  }
  return rows;
}

function concatBytesForChain(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export const Security = () => {
  const { user } = useAuth();
  const [fingerprint, setFingerprint] = useState<string | null>(null);

  useQuery({
    queryKey: ['identity-fingerprint'],
    queryFn: async () => {
      const identity = await loadIdentity(user!.id);
      setFingerprint(identity ? u8ToHex(identity.pub) : null);
      return identity?.pub;
    },
  });

  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ['transparency-self'],
    queryFn: async () => {
      const [entries, logKey] = await Promise.all([
        cryptoApi.transparencySelf(),
        cryptoApi.transparencyLogKey().catch(() => ({ log_pub: '' })),
      ]);
      const rows = await verifyChain(entries, logKey.log_pub || undefined);
      const ok = rows.every((r) => r.signatureOk !== false && r.integrityOk !== false && r.linkOk !== false);
      return { rows, ok, count: entries.length };
    },
    retry: false,
  });

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>الأمان</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h4 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-900">
              <Fingerprint className="h-4 w-4 text-gray-400" />
              بصمة هويتك
            </h4>
            {fingerprint ? (
              <p dir="ltr" className="break-all rounded-lg bg-gray-50 px-3 py-2 font-mono text-sm text-gray-800">
                {fingerprint}
              </p>
            ) : (
              <p className="text-sm text-gray-400">لم تُهيّأ الهوية التشفيرية بعد على هذا الجهاز.</p>
            )}
            <p className="mt-1 text-xs text-gray-400">
              قارن هذه البصمة مع من تواصل معهم عبر قناة مستقلة للتأكد من عدم استبدال المفتاح (§3.5).
            </p>
          </div>

          <div className="flex items-center justify-between border-t border-gray-100 pt-3 text-sm">
            <span className="text-gray-600">إصدار التطبيق</span>
            <span dir="ltr" className="font-mono text-gray-800">
              v{APP_VERSION}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>فحص سلسلة الشفافية</CardTitle>
            <Button variant="outline" size="sm" onClick={() => void refetch()} loading={isRefetching}>
              <RefreshCw className="h-4 w-4" />
              إعادة الفحص
            </Button>
          </div>
          <p className="text-sm text-gray-500">
            نتحقق محليًا من توقيع كل حدث مفاتيح بمفتاح السجل العام ومن صحة الربط بين العناصر.
          </p>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          )}
          {error && <p className="text-sm text-red-600">تعذر جلب سلسلة الشفافية — جرّب لاحقًا.</p>}
          {data && (
            <>
              <div
                className={cn(
                  'mb-4 flex items-center gap-2 rounded-lg px-4 py-3 text-sm font-medium',
                  data.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800',
                )}
              >
                {data.ok ? <ShieldCheck className="h-5 w-5" /> : <ShieldX className="h-5 w-5" />}
                {data.ok
                  ? `السلسلة سليمة — ${data.count} حدثًا موقّعًا ومتسلسلًا.`
                  : 'كسر في السلسلة أو توقيع غير صالح — راجع الأحداث أدناه.'}
              </div>
              <ul className="max-h-72 space-y-1 overflow-y-auto">
                {data.rows.map((row) => {
                  const broken = row.signatureOk === false || row.integrityOk === false || row.linkOk === false;
                  return (
                    <li
                      key={row.entry.seq}
                      className={cn(
                        'flex items-center justify-between rounded-lg px-3 py-2 text-xs',
                        broken ? 'bg-red-50 text-red-800' : 'bg-gray-50 text-gray-600',
                      )}
                    >
                      <span>
                        #{row.entry.seq} · {row.entry.event_type}
                      </span>
                      <span className="flex items-center gap-3">
                        <span>{row.signatureOk === null ? 'التوقيع: غير مفحوص' : row.signatureOk ? 'التوقيع: ✓' : 'التوقيع: ✗'}</span>
                        <span>{row.integrityOk ? 'التجزئة: ✓' : 'التجزئة: ✗'}</span>
                        <span>{row.linkOk ? 'الربط: ✓' : 'الربط: ✗'}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </CardContent>
      </Card>
      <MySecurityEvents />
    </div>
  );
};

export const SecurityPages = { Security };
