import { useCallback, useEffect, useState } from 'react';
import { BellRing, X } from 'lucide-react';
import { Button, Card } from '../../shared/ui';
import { toUserMessage } from '../../shared/api';
import { disablePush, enablePush, pushStatus, sendTestPush, type PushState } from './push';

const DISMISS_KEY = 'push-prompt-dismissed';

function usePush() {
  const [state, setState] = useState<PushState | 'loading'>('loading');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    pushStatus()
      .then((s) => alive && setState(s))
      .catch(() => alive && setState('unsupported'));
    return () => {
      alive = false;
    };
  }, []);

  const run = useCallback(async (fn: () => Promise<PushState | void>, done?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const next = await fn();
      if (next) setState(next);
      if (done) setMessage(done);
    } catch (err) {
      setMessage(toUserMessage(err, 'تعذر تنفيذ العملية'));
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    state,
    busy,
    message,
    enable: () => run(enablePush),
    disable: () => run(async () => {
      await disablePush();
      return 'off';
    }),
    test: () => run(async () => void (await sendTestPush()), 'أُرسل إشعار تجريبي — يجب أن يظهر خلال ثوانٍ'),
  };
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/** شريط أعلى التطبيق يدعو لتفعيل إشعارات سطح المكتب (مرة واحدة حتى يُغلق). */
export function PushPrompt() {
  const push = usePush();
  const [dismissed, setDismissed] = useState(readDismissed);
  if (dismissed || push.state !== 'off') return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // التفضيل محلي فقط؛ لا بأس إن تعذر حفظه.
    }
    setDismissed(true);
  };

  return (
    <div className="flex items-center gap-3 border-b border-primary-100 bg-primary-50 px-4 py-2 text-sm text-primary-900">
      <BellRing className="h-4 w-4 shrink-0" />
      <span className="flex-1">
        فعّل إشعارات سطح المكتب لتعرف بوصول المراسلات والرسائل حتى والموقع مغلق.
        {push.message && <span className="ms-2 text-red-700">{push.message}</span>}
      </span>
      <Button size="sm" onClick={() => void push.enable()} loading={push.busy}>
        تفعيل الإشعارات
      </Button>
      <button type="button" onClick={dismiss} className="rounded p-1 hover:bg-primary-100" aria-label="إغلاق">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

const STATE_TEXT: Record<PushState | 'loading', string> = {
  loading: 'جارٍ التحقق…',
  unsupported: 'هذا المتصفح لا يدعم إشعارات سطح المكتب، أو الموقع لا يعمل عبر HTTPS.',
  'disabled-server': 'إشعارات سطح المكتب غير مُعدّة على الخادم (مفتاح VAPID).',
  denied: 'الإشعارات محظورة لهذا الموقع في المتصفح — اسمح بها من رمز القفل بجوار العنوان ثم أعد تحميل الصفحة.',
  off: 'غير مفعّلة على هذا المتصفح.',
  on: 'مفعّلة على هذا المتصفح — ستصلك تنبيهات المراسلات والرسائل والاعتمادات حتى والموقع مغلق.',
};

/** بطاقة الإعداد في صفحة الإشعارات. */
export function PushSettingsCard() {
  const push = usePush();
  return (
    <Card className="flex flex-wrap items-center gap-3 p-4">
      <BellRing className="h-5 w-5 text-primary-700" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-gray-900">إشعارات سطح المكتب</p>
        <p className="text-xs text-gray-600">{STATE_TEXT[push.state]}</p>
        {push.message && <p className="mt-1 text-xs text-gray-700">{push.message}</p>}
      </div>
      {push.state === 'off' && (
        <Button size="sm" onClick={() => void push.enable()} loading={push.busy}>
          تفعيل
        </Button>
      )}
      {push.state === 'on' && (
        <>
          <Button size="sm" variant="outline" onClick={() => void push.test()} loading={push.busy}>
            إرسال إشعار تجريبي
          </Button>
          <Button size="sm" variant="outline" onClick={() => void push.disable()} disabled={push.busy}>
            إيقاف
          </Button>
        </>
      )}
    </Card>
  );
}
