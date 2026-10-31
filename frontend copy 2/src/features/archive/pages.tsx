import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Download, KeyRound, Lock, Paperclip, Search, Share2, ShieldCheck } from 'lucide-react';
import { Button, Card, EmptyState, Input, Spinner } from '../../shared/ui';
import { apiFetch, toUserMessage } from '../../shared/api';
import { cn } from '../../shared/lib/cn';
import {
  archiveKeyApi,
  copyAad,
  createArchiveKey,
  loadArchiveKey,
  shareArchiveKey,
  unseal,
  type ArchiveDeviceStatus,
  type ArchiveKeyInfo,
} from '../../crypto/archive';
import { CryptoGate, formatDate } from '../correspondence/components';
import { correspondenceApi } from '../correspondence/api';
import { decryptAttachment, formatBytes, saveDecryptedFile, type AttachmentKey } from '../correspondence/content';

interface CopySummary {
  correspondence_id: string;
  reference_number: string | null;
  sent_at: string | null;
  sender: string;
  institute: string | null;
  priority: string;
  reply_to_id: string | null;
  key_id: string;
  size: number;
  archived_at: string;
}

interface CopyDetail extends CopySummary {
  client_msg_id: string;
  ephemeral_pub: string;
  iv: string;
  ciphertext: string;
}

interface ArchivedContent {
  subject: string;
  body: string;
  attachments: AttachmentKey[];
  forwarded?: { reference_number: string | null; sender_name: string; subject: string; body: string };
}

const copiesApi = {
  list: (page: number, q: string) =>
    apiFetch<{ count: number; next: string | null; previous: string | null; results: CopySummary[] }>(
      `/archive/copies/?page=${page}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
    ),
  get: (id: string) => apiFetch<CopyDetail>(`/archive/copies/${id}/`),
};

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && !('status' in err) ? err.message : toUserMessage(err, fallback);
}

// --- المفتاح ---------------------------------------------------------------------------

function SetupKey({ nextVersion }: { nextVersion: number }) {
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: () => createArchiveKey(nextVersion),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['archive-key'] }),
  });
  return (
    <Card className="mx-auto max-w-2xl space-y-3 p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
        <KeyRound className="h-5 w-5" />
        تهيئة الأرشيف المركزي
      </h2>
      <p className="text-sm text-gray-600">
        سيُنشأ مفتاح الأرشيف على هذا الجهاز. المراسلات المصنّفة «قابلة للأرشفة المؤسسية» تُرسل منذ الآن ومعها نسخة مشفّرة
        لهذا المفتاح، لا يفتحها إلا ضباط الأرشيف. شارك المفتاح بعدها مع أجهزة زملائك من هذه الصفحة، وفعّل مفتاح الاستعادة
        على جهازك حتى لا يضيع المفتاح.
      </p>
      <Button onClick={() => create.mutate()} loading={create.isPending}>
        <KeyRound className="h-4 w-4" />
        إنشاء مفتاح الأرشيف
      </Button>
      {create.error && <p className="text-sm text-red-600">{errorText(create.error, 'تعذر إنشاء المفتاح')}</p>}
    </Card>
  );
}

function KeyDevices({ keyInfo, devices, haveKey }: { keyInfo: ArchiveKeyInfo; devices: ArchiveDeviceStatus[]; haveKey: boolean }) {
  const queryClient = useQueryClient();
  const share = useMutation({
    mutationFn: (d: ArchiveDeviceStatus) => shareArchiveKey(keyInfo.id, d),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['archive-key'] }),
  });
  const waiting = devices.filter((d) => !d.has_key);
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2 text-sm text-gray-700">
        <ShieldCheck className="h-4 w-4 text-emerald-600" />
        مفتاح الأرشيف (الإصدار {keyInfo.version}) أنشأه {keyInfo.created_by} في {formatDate(keyInfo.created_at)}
      </div>
      {waiting.length > 0 && (
        <div>
          <p className="mb-2 text-sm text-gray-600">أجهزة ضباط أرشيف لم تستلم المفتاح بعد:</p>
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
            {waiting.map((d) => (
              <li key={d.device_id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span>
                  {d.user} <span className="text-xs text-gray-400">— {d.label}</span>
                </span>
                {haveKey && (
                  <Button size="sm" variant="outline" onClick={() => share.mutate(d)} loading={share.isPending && share.variables?.device_id === d.device_id}>
                    <Share2 className="h-4 w-4" />
                    مشاركة المفتاح
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {share.error && <p className="text-sm text-red-600">{errorText(share.error, 'تعذرت المشاركة')}</p>}
    </Card>
  );
}

// --- النسخ ------------------------------------------------------------------------------

function AttachmentLine({ meta }: { meta: AttachmentKey }) {
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2 text-sm">
      <span className="flex min-w-0 items-center gap-2">
        <Paperclip className="h-4 w-4 shrink-0 text-gray-400" />
        <span className="truncate">{meta.name}</span>
        <span className="text-xs text-gray-400">{formatBytes(meta.size)}</span>
      </span>
      <Button
        size="sm"
        variant="outline"
        loading={state === 'busy'}
        onClick={async () => {
          setState('busy');
          try {
            saveDecryptedFile(await decryptAttachment(await correspondenceApi.downloadBlob(meta.id), meta), meta.name);
            setState('idle');
          } catch {
            setState('error');
          }
        }}
      >
        <Download className="h-4 w-4" />
        {state === 'error' ? 'تعذر' : 'فك وتنزيل'}
      </Button>
    </li>
  );
}

function CopyViewer({ id }: { id: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['archive-copy', id],
    queryFn: async () => {
      const copy = await copiesApi.get(id);
      const key = await loadArchiveKey(copy.key_id);
      if (!key) throw new Error('مفتاح الأرشيف ليس على هذا الجهاز — اطلب من زميل مشاركته');
      const plain = await unseal(key, copy, copyAad(copy.key_id, copy.client_msg_id));
      return { copy, content: JSON.parse(new TextDecoder().decode(plain)) as ArchivedContent };
    },
    staleTime: Infinity,
  });
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-gray-500">
        <Spinner size="sm" />
        جارٍ فك النسخة على جهازك…
      </div>
    );
  }
  if (error || !data) {
    return <p className="p-6 text-sm text-red-600">{errorText(error, 'تعذر فتح النسخة')}</p>;
  }
  const { copy, content } = data;
  return (
    <div className="space-y-4 p-6" data-testid="archive-viewer">
      <div>
        <h3 className="break-words text-lg font-semibold text-gray-900">{content.subject || '(بلا عنوان)'}</h3>
        <p className="mt-1 text-xs text-gray-500">
          <span dir="ltr" className="font-mono">{copy.reference_number}</span> · {copy.sender}
          {copy.institute && ` · ${copy.institute}`} · {copy.sent_at ? formatDate(copy.sent_at) : ''}
        </p>
      </div>
      {/* نص صريح فقط — لا HTML */}
      <div className="whitespace-pre-wrap break-words text-sm leading-7 text-gray-800">{content.body || '—'}</div>
      {content.forwarded && (
        <div className="rounded-lg border-s-4 border-gray-300 bg-gray-50 p-4 text-sm">
          <p className="mb-1 text-xs text-gray-500">مراسلة محالة من {content.forwarded.sender_name}</p>
          <p className="font-medium">{content.forwarded.subject}</p>
          <p className="mt-1 whitespace-pre-wrap text-gray-700">{content.forwarded.body}</p>
        </div>
      )}
      {content.attachments?.length > 0 && (
        <ul className="space-y-2">
          {content.attachments.map((a) => (
            <AttachmentLine key={a.id} meta={a} />
          ))}
        </ul>
      )}
      <p className="text-xs text-gray-400">فُتحت هذه النسخة على جهازك وسُجّل الاطلاع في سجل التدقيق.</p>
    </div>
  );
}

function Copies() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['archive-copies', page, query],
    queryFn: () => copiesApi.list(page, query),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
      <Card className="overflow-hidden lg:col-span-2">
        <form
          className="relative border-b border-gray-200 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setQuery(q.trim());
          }}
        >
          <Search className="pointer-events-none absolute start-5 top-5 h-4 w-4 text-gray-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="الرقم المرجعي أو اسم المرسل…" className="ps-8" aria-label="بحث في الأرشيف" />
        </form>
        {isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : !data || data.results.length === 0 ? (
          <EmptyState icon={Archive} title="لا نسخ مؤرشفة" description="تظهر هنا المراسلات المصنّفة «قابلة للأرشفة المؤسسية»." />
        ) : (
          <ul>
            {data.results.map((c) => (
              <li key={c.correspondence_id}>
                <button
                  type="button"
                  onClick={() => setOpenId(c.correspondence_id)}
                  className={cn(
                    'w-full border-b border-gray-100 px-4 py-3 text-start text-sm hover:bg-gray-50',
                    openId === c.correspondence_id && 'bg-primary-50',
                  )}
                >
                  <div className="flex justify-between gap-2">
                    <span className="font-medium text-gray-900">{c.sender}</span>
                    <span className="text-xs text-gray-500">{c.sent_at ? formatDate(c.sent_at) : ''}</span>
                  </div>
                  <div className="flex justify-between gap-2 text-xs text-gray-500">
                    <span dir="ltr" className="font-mono">{c.reference_number}</span>
                    <span>{c.reply_to_id ? 'رد' : c.institute}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
        {data && (data.next || data.previous) && (
          <div className="flex justify-between border-t border-gray-200 p-2 text-xs">
            <Button variant="ghost" size="sm" disabled={!data.previous} onClick={() => setPage((p) => p - 1)}>السابق</Button>
            <Button variant="ghost" size="sm" disabled={!data.next} onClick={() => setPage((p) => p + 1)}>التالي</Button>
          </div>
        )}
      </Card>
      <Card className="min-h-[16rem] lg:col-span-3">
        {openId ? (
          <CopyViewer key={openId} id={openId} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-sm text-gray-400">
            <Lock className="h-8 w-8" />
            اختر نسخة لفكها على جهازك
          </div>
        )}
      </Card>
    </div>
  );
}

function ArchiveWorkspace() {
  const { data, isLoading, error } = useQuery({ queryKey: ['archive-key'], queryFn: archiveKeyApi.state });
  const keyId = data?.key?.id;
  const { data: haveKey, isLoading: keyLoading } = useQuery({
    queryKey: ['archive-key-local', keyId],
    queryFn: async () => Boolean(keyId && (await loadArchiveKey(keyId))),
    enabled: Boolean(keyId),
  });
  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }
  if (error) return <Card className="p-6 text-sm text-red-600">{toUserMessage(error, 'تعذر تحميل الأرشيف')}</Card>;
  if (!data?.is_officer) {
    return (
      <EmptyState
        icon={Archive}
        title="الأرشيف المركزي لضباط الأرشيف"
        description="يفتح هذه الصفحة من أُسند إليه دور «ضابط الأرشيف المؤسسي» مركزيًا."
        className="mx-auto mt-8 max-w-lg"
      />
    );
  }
  if (!data.key) return <SetupKey nextVersion={data.next_version} />;
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">الأرشيف المركزي</h2>
        <p className="text-xs text-gray-500">
          نسخ مشفّرة صنعها المرسلون للمراسلات المصنّفة «قابلة للأرشفة المؤسسية» فقط. تُفك على جهازك، وكل فتح يُسجَّل.
        </p>
      </div>
      <KeyDevices keyInfo={data.key} devices={data.devices} haveKey={Boolean(haveKey)} />
      {keyLoading ? (
        <Spinner />
      ) : haveKey ? (
        <Copies />
      ) : (
        <Card className="p-6 text-sm text-amber-800">
          مفتاح الأرشيف لم يُشارَك مع هذا الجهاز بعد. اطلب من زميل أرشيف يملكه أن يفتح هذه الصفحة ويضغط «مشاركة المفتاح» أمام
          جهازك، ثم أعد تحميل الصفحة.
        </Card>
      )}
    </div>
  );
}

export function ArchivePage() {
  return (
    <CryptoGate>
      <ArchiveWorkspace />
    </CryptoGate>
  );
}
