import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, Copy, Eye, EyeOff, KeyRound, UploadCloud } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from '../../shared/ui';
import { toUserMessage } from '../../shared/api';
import {
  encryptRecoveryBundle,
  generateRecoveryKey,
  restoreFromRecoveryKey,
  uploadBackup,
  type RecoveryKeyDisplay,
} from '../../crypto/recovery';
import { useAuth } from '../auth/AuthContext';

const STEP_GENERATE = 0;
const STEP_DISPLAY = 1;
const STEP_CONFIRM = 2;
const STEP_DONE = 3;

function Wizard() {
  const [step, setStep] = useState(STEP_GENERATE);
  const [key, setKey] = useState<RecoveryKeyDisplay | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  const backupMutation = useMutation({
    mutationFn: async (raw: Uint8Array) => uploadBackup(await encryptRecoveryBundle(raw)),
    onSuccess: () => setStep(STEP_DONE),
  });

  const generate = () => {
    const fresh = generateRecoveryKey();
    setKey(fresh);
    setStep(STEP_DISPLAY);
  };

  const copyKey = async () => {
    if (!key) return;
    await navigator.clipboard.writeText(key.groups.join('-'));
    setCopied(true);
  };

  return (
    <div className="space-y-4">
      {step === STEP_GENERATE && (
        <>
          <p className="text-sm text-gray-600">
            مفتاح الاستعادة هو الطريقة الوحيدة لاسترجاع مراسلاتك عند فقدان كل أجهزتك. سيُعرض مرة واحدة فقط —
            احفظه في مكان آمن (طباعة أو مدير كلمات مرور).
          </p>
          <Button onClick={generate}>
            <KeyRound className="h-4 w-4" />
            توليد مفتاح استعادة
          </Button>
        </>
      )}

      {step === STEP_DISPLAY && key && (
        <>
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            لن يُعرض هذا المفتاح مجددًا. احفظه الآن قبل المتابعة.
          </p>
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            className="block w-full rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 p-4 text-center transition-colors hover:border-primary-400"
            aria-label={revealed ? 'إخفاء المفتاح' : 'إظهار المفتاح'}
          >
            {revealed ? (
              <span dir="ltr" className="font-mono text-lg font-bold tracking-wider text-gray-900">
                {key.groups.join('-')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-2 text-sm text-gray-500">
                {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                اضغط لإظهار المفتاح
              </span>
            )}
          </button>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void copyKey()}>
              <Copy className="h-4 w-4" />
              {copied ? 'نُسخ!' : 'نسخ المفتاح'}
            </Button>
            <Button onClick={() => setStep(STEP_CONFIRM)}>حفظت المفتاح — متابعة</Button>
          </div>
        </>
      )}

      {step === STEP_CONFIRM && key && (
        <>
          <p className="text-sm text-gray-600">
            أكّد أنك حفظت المفتاح. سننشئ الآن نسخة احتياطية مشفرة من هويتك ومفاتيحك وحالة محادثاتك
            (AES-256-GCM بمفتاح مشتق من مفتاح الاستعادة).
          </p>
          <div className="flex gap-2">
            <Button
              onClick={() => backupMutation.mutate(key.raw)}
              loading={backupMutation.isPending}
              disabled={backupMutation.isPending}
            >
              <UploadCloud className="h-4 w-4" />
              إنشاء النسخة الاحتياطية
            </Button>
            <Button variant="ghost" onClick={() => setStep(STEP_DISPLAY)}>
              رجوع
            </Button>
          </div>
          {backupMutation.error && (
            <p className="text-sm text-red-600">{toUserMessage(backupMutation.error, 'تعذر إنشاء النسخة')}</p>
          )}
        </>
      )}

      {step === STEP_DONE && (
        <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <CheckCircle2 className="h-5 w-5 shrink-0" />
          اكتمل إعداد الاستعادة وخُزّنت النسخة المشفرة (تُرفع للخادم فور اعتماد نقطة الرفع).
        </div>
      )}
    </div>
  );
}

function RestorePanel() {
  const { user } = useAuth();
  const [value, setValue] = useState('');
  const [done, setDone] = useState(false);
  const mutation = useMutation({
    mutationFn: () => restoreFromRecoveryKey(value.split('-')),
    onSuccess: () => {
      setDone(true);
      void user; // إعادة بناء الجلسة تحدث تلقائيًا عبر resetMlsSession
      window.location.reload();
    },
  });

  return (
    <div className="mt-6 border-t border-gray-200 pt-4">
      <h4 className="mb-1 text-sm font-semibold text-gray-900">استعادة على هذا الجهاز</h4>
      <p className="mb-3 text-sm text-gray-500">
        أدخل مفتاح الاستعادة (8 مجموعات) لفك النسخة المشفرة وإعادة بناء الهوية والمحادثات.
      </p>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        <Input
          dir="ltr"
          value={value}
          onChange={(e) => setValue(e.target.value.toUpperCase())}
          placeholder="XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX"
          autoComplete="off"
          className="font-mono"
        />
        <Button type="submit" variant="outline" loading={mutation.isPending} disabled={done}>
          استعادة
        </Button>
      </form>
      {mutation.error && <p className="mt-2 text-sm text-red-600">{toUserMessage(mutation.error, 'تعذرت الاستعادة')}</p>}
      {done && <p className="mt-2 text-sm text-emerald-700">تمت الاستعادة — جارٍ إعادة التحميل…</p>}
    </div>
  );
}

export const Recovery = () => (
  <Card className="mx-auto max-w-2xl">
    <CardHeader>
      <CardTitle>مفتاح الاستعادة</CardTitle>
      <p className="text-sm text-gray-500">
        النسخة الاحتياطية مشفرة دائمًا قبل الرفع؛ الخادم يرى ciphertext فقط (§3.6).
      </p>
    </CardHeader>
    <CardContent>
      <Wizard />
      <RestorePanel />
    </CardContent>
  </Card>
);

export const RecoveryPages = { Recovery };
