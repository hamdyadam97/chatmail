import { useEffect, useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import { Button } from '../../shared/ui';

const DISMISS_KEY = 'install-prompt-dismissed';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
}

function dismissed(): boolean {
  try {
    return Boolean(localStorage.getItem(DISMISS_KEY));
  } catch {
    return false;
  }
}

/**
 * «ثبّت التطبيق» على الموبايل: Android يعرض نافذة التثبيت مباشرة؛ iPhone لا يتيحها
 * للمواقع فنشرح الخطوتين (مشاركة ← إضافة إلى الشاشة الرئيسية).
 */
export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [hidden, setHidden] = useState(() => dismissed() || isStandalone());

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setHidden(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const ios = isIos();
  if (hidden || (!deferred && !ios)) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // تفضيل عرض محلي فقط.
    }
    setHidden(true);
  };

  return (
    <div className="flex items-center gap-3 border-b border-primary-100 bg-primary-50 px-3 py-2 text-sm text-primary-900 md:hidden">
      <Download className="h-4 w-4 shrink-0" />
      <span className="flex-1">
        {deferred ? (
          'ثبّت التطبيق على موبايلك ليفتح كتطبيق مستقل وتصلك الإشعارات.'
        ) : (
          <>
            ثبّت التطبيق على الآيفون: اضغط <Share className="inline h-4 w-4" aria-label="مشاركة" /> ثم «إضافة إلى الشاشة
            الرئيسية».
          </>
        )}
      </span>
      {deferred && (
        <Button
          size="sm"
          onClick={async () => {
            await deferred.prompt();
            const { outcome } = await deferred.userChoice;
            if (outcome === 'accepted') setHidden(true);
            setDeferred(null);
          }}
        >
          تثبيت
        </Button>
      )}
      <button type="button" onClick={dismiss} className="rounded p-1 hover:bg-primary-100" aria-label="إغلاق">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
