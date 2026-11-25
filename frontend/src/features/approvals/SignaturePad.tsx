import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eraser, PenLine, Upload } from 'lucide-react';
import { Button } from '../../shared/ui';
import { toUserMessage } from '../../shared/api';
import { approvalsApi } from './api';

const readDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('read')));
    reader.onerror = () => reject(new Error('read'));
    reader.readAsDataURL(blob);
  });

/** صورة توقيع مرفوعة: PNG صغير يُرسل كما هو (قد يكون شفافًا)، وصورة الموبايل الكبيرة
 * تُصغَّر إلى 1600 بكسل JPEG قبل الإرسال — الخادم يزيل خلفية الورقة ويقص على الحبر. */
async function shrinkImage(file: File): Promise<string> {
  if (file.type === 'image/png' && file.size <= 1_500_000) return readDataUrl(file);
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bitmap.width * scale);
  c.height = Math.round(bitmap.height * scale);
  const ctx = c.getContext('2d');
  if (!ctx) return readDataUrl(file);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bitmap, 0, 0, c.width, c.height);
  bitmap.close();
  return c.toDataURL('image/jpeg', 0.9);
}

function UploadSignature({ onSave, label }: { onSave: (dataUrl: string) => void; label: string }) {
  return (
    <label
      data-testid="signature-upload"
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-gray-300 px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
    >
      <Upload className="h-4 w-4" />
      {label}
      <input
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          void shrinkImage(file).then(onSave, () => onSave(''));
        }}
      />
    </label>
  );
}

/** لوحة رسم التوقيع بالماوس أو بالإصبع؛ تعيد PNG (data URL) أو null إن كانت فارغة. */
function DrawPad({ onSave, onCancel, saving }: { onSave: (dataUrl: string) => void; onCancel?: () => void; saving: boolean }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.clientWidth * ratio;
    c.height = c.clientHeight * ratio;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = '#0b1f66';
  }, []);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const clear = () => {
    const c = canvas.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    setEmpty(true);
  };

  return (
    <div className="space-y-2">
      <canvas
        ref={canvas}
        aria-label="لوحة التوقيع"
        data-testid="signature-pad"
        className="h-40 w-full touch-none rounded-lg border-2 border-dashed border-gray-300 bg-white"
        onPointerDown={(e) => {
          const ctx = e.currentTarget.getContext('2d');
          if (!ctx) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = true;
          const [x, y] = point(e);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + 0.1, y + 0.1);
          ctx.stroke();
          setEmpty(false);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = e.currentTarget.getContext('2d');
          const [x, y] = point(e);
          ctx?.lineTo(x, y);
          ctx?.stroke();
        }}
        onPointerUp={() => (drawing.current = false)}
        onPointerLeave={() => (drawing.current = false)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={empty} loading={saving} onClick={() => canvas.current && onSave(canvas.current.toDataURL('image/png'))}>
          <PenLine className="h-4 w-4" />
          حفظ التوقيع
        </Button>
        <Button size="sm" variant="outline" onClick={clear}>
          <Eraser className="h-4 w-4" />
          مسح
        </Button>
        <UploadSignature onSave={onSave} label="أو ارفع صورة توقيعك (ولو مصوّرة على ورقة)" />
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            إلغاء
          </Button>
        )}
      </div>
    </div>
  );
}

/** توقيعي المحفوظ: يُرسم مرة ويُستعمل في كل اعتماد بتوقيع. */
export function SignatureManager({ compact = false }: { compact?: boolean }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['my-signature'], queryFn: approvalsApi.signature });
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: approvalsApi.saveSignature,
    onSuccess: (r) => {
      queryClient.setQueryData(['my-signature'], r);
      setEditing(false);
      setError(null);
    },
    onError: (err) => setError(toUserMessage(err, 'تعذر حفظ التوقيع')),
  });
  if (isLoading) return null;
  const has = Boolean(data?.has_signature && data.image);
  return (
    <div className="space-y-2" data-testid="signature-manager">
      {has && !editing ? (
        <div className="flex flex-wrap items-center gap-3">
          <img
            src={`data:image/png;base64,${data!.image}`}
            alt="توقيعي"
            data-testid="my-signature"
            className={compact ? 'h-14 rounded border border-gray-200 bg-white p-1' : 'h-20 rounded border border-gray-200 bg-white p-2'}
          />
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            تغيير التوقيع
          </Button>
          <UploadSignature onSave={(d) => save.mutate(d)} label="رفع صورة توقيع" />
        </div>
      ) : (
        <>
          <p className="text-xs text-gray-600">
            {has ? 'ارسم توقيعك الجديد:' : 'ارسم توقيعك مرة واحدة — يُحفظ مشفّرًا ويُستعمل عند كل اعتماد لطلب بتوقيع.'}
          </p>
          <DrawPad saving={save.isPending} onSave={(d) => save.mutate(d)} onCancel={has ? () => setEditing(false) : undefined} />
        </>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
