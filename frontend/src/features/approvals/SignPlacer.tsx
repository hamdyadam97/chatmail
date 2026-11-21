import { useEffect, useRef, useState } from 'react';
import { Spinner } from '../../shared/ui';
import { correspondenceApi } from '../correspondence/api';

export interface Placement {
  x: number;
  y: number;
}

interface Box {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * الصفحة نفسها (PDF.js، داخل المتصفح فقط) ليضع المعتمد مربع توقيعه حيث يريد:
 * نقرة تضعه، والسحب يحرّكه. الإحداثيات بنقاط PDF من أعلى يسار الصفحة.
 * المكتبة تُحمَّل عند فتح لوحة التوقيع فقط.
 */
export function SignPlacer({
  fileId,
  page,
  box,
  taken,
  value,
  onChange,
}: {
  fileId: string;
  page: number;
  box: { w: number; h: number };
  taken: Box[];
  value: Placement | null;
  onChange: (p: Placement | null) => void;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const doc = useRef<unknown>(null);
  const [scale, setScale] = useState(0);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  // تحميل الملف مرة واحدة.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [pdfjs, worker] = await Promise.all([
          import('pdfjs-dist'),
          import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
        ]);
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const data = new Uint8Array(await (await correspondenceApi.download(fileId)).arrayBuffer());
        // بلا eval وبلا خطوط مضمّنة: يتوافق مع سياسة المحتوى الصارمة.
        const loaded = await pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true }).promise;
        if (alive) doc.current = loaded;
      } catch {
        if (alive) setError('تعذر عرض الملف — يُختم التوقيع أسفل الصفحة المختارة.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [fileId]);

  // رسم الصفحة المختارة بعرض اللوحة.
  useEffect(() => {
    if (loading || !doc.current || !canvas.current || !wrap.current) return;
    let cancelled = false;
    (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = await (doc.current as any).getPage(page);
      const base = p.getViewport({ scale: 1 });
      const s = Math.min(1.6, (wrap.current?.clientWidth ?? 560) / base.width);
      const vp = p.getViewport({ scale: s * (window.devicePixelRatio || 1) });
      const c = canvas.current!;
      c.width = vp.width;
      c.height = vp.height;
      c.style.width = `${base.width * s}px`;
      c.style.height = `${base.height * s}px`;
      await p.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise;
      if (!cancelled) {
        setScale(s);
        setSize({ w: base.width, h: base.height });
      }
    })().catch(() => setError('تعذر عرض هذه الصفحة.'));
    return () => {
      cancelled = true;
    };
  }, [loading, page]);

  const clamp = (x: number, y: number): Placement => ({
    x: Math.max(0, Math.min((size?.w ?? 0) - box.w, x)),
    y: Math.max(0, Math.min((size?.h ?? 0) - box.h, y)),
  });
  const toPoints = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };
  const overlaps = (p: Placement) =>
    taken.some((b) => b.page === page && !(p.x + box.w <= b.x || b.x + b.w <= p.x || p.y + box.h <= b.y || b.y + b.h <= p.y));

  if (error) return <p className="text-xs text-amber-700">{error}</p>;
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-gray-600">
        اضغط على مكان توقيعك في الصفحة (واسحب المربع لتعديله). إن لم تختر مكانًا يُختم أسفل الصفحة.
      </p>
      <div ref={wrap} className="relative max-h-[70vh] overflow-auto rounded-lg border border-gray-300 bg-gray-100">
        {loading && (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        )}
        <div className="relative inline-block">
          <canvas
            ref={canvas}
            data-testid="sign-page-canvas"
            data-ready={scale > 0 ? '1' : '0'}
            className="block cursor-crosshair touch-none bg-white"
            onPointerDown={(e) => {
              if (!scale) return;
              const pt = toPoints(e);
              onChange(clamp(pt.x - box.w / 2, pt.y - box.h / 2));
            }}
          />
          {value && scale > 0 && (
            <div
              data-testid="sign-box"
              className={`absolute cursor-move touch-none rounded border-2 border-dashed ${overlaps(value) ? 'border-red-500 bg-red-100/50' : 'border-indigo-600 bg-indigo-100/40'}`}
              ref={(el) => {
                if (!el) return;
                el.style.left = `${value.x * scale}px`;
                el.style.top = `${value.y * scale}px`;
                el.style.width = `${box.w * scale}px`;
                el.style.height = `${box.h * scale}px`;
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
                e.currentTarget.setPointerCapture(e.pointerId);
                const pt = toPoints(e);
                drag.current = { dx: pt.x - value.x, dy: pt.y - value.y };
              }}
              onPointerMove={(e) => {
                if (!drag.current) return;
                const pt = toPoints(e);
                onChange(clamp(pt.x - drag.current.dx, pt.y - drag.current.dy));
              }}
              onPointerUp={() => (drag.current = null)}
            >
              <span className="block p-1 text-center text-[10px] font-medium text-indigo-800">توقيعك هنا</span>
            </div>
          )}
        </div>
      </div>
      {value && overlaps(value) && <p className="text-xs text-red-600">المكان يغطي توقيعًا سابقًا — حرّك المربع.</p>}
      {value && (
        <button type="button" onClick={() => onChange(null)} className="text-xs text-gray-500 hover:underline">
          إلغاء المكان (أسفل الصفحة)
        </button>
      )}
    </div>
  );
}
