import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ShieldAlert, X } from 'lucide-react';
import { recoveryStatus } from '../../crypto/recovery';
import { useCryptoBootstrap } from '../../crypto/useCryptoBootstrap';

const SNOOZE_KEY = 'recovery-prompt-snoozed-until';
const SNOOZE_MS = 3 * 24 * 3600 * 1000;

function snoozed(): boolean {
  try {
    return Number(localStorage.getItem(SNOOZE_KEY) ?? 0) > Date.now();
  } catch {
    return false;
  }
}

/** تنبيه دائم الظهور (يُؤجَّل 3 أيام فقط) حتى يُفعَّل النسخ الاحتياطي على هذا الجهاز. */
export function RecoveryPrompt() {
  const { pathname } = useLocation();
  const bootstrap = useCryptoBootstrap();
  const [hidden, setHidden] = useState(snoozed);
  const { data } = useQuery({
    queryKey: ['recovery-status'],
    queryFn: recoveryStatus,
    enabled: bootstrap.status === 'ready',
  });
  if (hidden || bootstrap.status !== 'ready' || !data || data.configured || pathname.startsWith('/recovery')) return null;

  const snooze = () => {
    try {
      localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
    } catch {
      // تفضيل عرض محلي فقط.
    }
    setHidden(true);
  };

  return (
    <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
      <ShieldAlert className="h-4 w-4 shrink-0" />
      <span className="flex-1">
        لم تُفعّل النسخ الاحتياطي لمفاتيحك — إن مُسحت بيانات هذا المتصفح أو فقدت الجهاز ستفقد مراسلاتك نهائيًا.
      </span>
      <Link to="/recovery" className="rounded-md bg-amber-600 px-3 py-1 text-sm font-medium text-white hover:bg-amber-700">
        إعداد الآن
      </Link>
      <button type="button" onClick={snooze} className="rounded p-1 hover:bg-amber-100" aria-label="تذكيري لاحقًا" title="تذكيري بعد 3 أيام">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
