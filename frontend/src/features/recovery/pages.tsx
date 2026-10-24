import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Copy, Download, KeyRound, RefreshCw, ShieldCheck, UploadCloud } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Spinner } from '../../shared/ui';
import { toUserMessage } from '../../shared/api';
import { cryptoApi } from '../../crypto/api';
import {
  backupNow,
  checkKeyAgainstServer,
  enableRecovery,
  generateRecoveryKey,
  parseRecoveryKey,
  recoveryStatus,
  restoreFromRecoveryKey,
  type RecoveryKeyDisplay,
} from '../../crypto/recovery';
import { resetCryptoBootstrap, useCryptoBootstrap } from '../../crypto/useCryptoBootstrap';
import { useAuth } from '../auth/AuthContext';

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && !('status' in err) ? err.message : toUserMessage(err, fallback);
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} ك.ب` : `${(bytes / 1024 / 1024).toFixed(1)} م.ب`;
}

function useRecoveryStatus() {
  return useQuery({ queryKey: ['recovery-status'], queryFn: recoveryStatus, refetchInterval: 30_000 });
}

function useServerBackups(enabled = true) {
  return useQuery({ queryKey: ['key-backups'], queryFn: cryptoApi.listBackups, enabled });
}

// --- إنشاء مفتاح جديد ---------------------------------------------------------------

function CreateKeyWizard({ onDone, rotating = false }: { onDone: () => void; rotating?: boolean }) {
  const { user } = useAuth();
  const [key, setKey] = useState<RecoveryKeyDisplay | null>(null);
  const [step, setStep] = useState<'intro' | 'show' | 'confirm'>('intro');
  const [copied, setCopied] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  // رقم المجموعة المطلوبة للتأكيد (لا «الأخيرة»: في صفحة عربية تلتبس الأولى بالأخيرة).
  const [confirmGroup] = useState(() => 2 + Math.floor(Math.random() * 12));
  const enable = useMutation({ mutationFn: (raw: Uint8Array) => enableRecovery(raw), onSuccess: onDone });

  const display = key?.groups.join('-') ?? '';
  const download = () => {
    const text = [
      'مفتاح الاستعادة — نظام المراسلات الداخلية',
      `الحساب: ${user?.username ?? ''}`,
      `التاريخ: ${new Date().toLocaleString('ar')}`,
      '',
      display,
      '',
      'احفظه بعيدًا عن جهازك (ورقة مطبوعة أو مدير كلمات مرور). لا أحد غيرك يستطيع استرجاعه، ولا الإدارة.',
    ].join('\r\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `recovery-key-${user?.username ?? 'account'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (step === 'intro') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-gray-600">
          {rotating
            ? 'سيُنشأ مفتاح جديد وتُستبدل نسخ هذا الجهاز به. المفتاح القديم لن يفتح نسخ هذا الجهاز بعد الآن.'
            : 'مفتاح الاستعادة هو الطريقة الوحيدة لاسترجاع مراسلاتك إن فقدت هذا المتصفح أو الجهاز. يُعرض مرة واحدة فقط، ولا تستطيع الإدارة ولا الخادم استرجاعه.'}
        </p>
        <Button
          onClick={() => {
            setKey(generateRecoveryKey());
            setStep('show');
          }}
        >
          <KeyRound className="h-4 w-4" />
          {rotating ? 'إنشاء مفتاح جديد' : 'إنشاء مفتاح الاستعادة'}
        </Button>
      </div>
    );
  }

  if (step === 'show' && key) {
    return (
      <div className="space-y-3">
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          احفظ المفتاح الآن (نزّله أو اطبعه أو انسخه لمدير كلمات المرور). لن يُعرض مرة أخرى.
        </p>
        <div dir="ltr" className="rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 p-4">
          <ol className="flex flex-wrap justify-center gap-2">
            {key.groups.map((g, i) => (
              <li key={i} className="flex flex-col items-center">
                <span className="rounded-md bg-white px-2 py-1 font-mono text-base font-bold tracking-wider text-gray-900 shadow-sm">{g}</span>
                <span className="mt-0.5 text-[10px] text-gray-400">{i + 1}</span>
              </li>
            ))}
          </ol>
          <p className="mt-3 select-all text-center font-mono text-xs text-gray-500" data-testid="recovery-key">
            {display}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={download}>
            <Download className="h-4 w-4" />
            تنزيل كملف
          </Button>
          <Button
            variant="outline"
            onClick={() => void navigator.clipboard.writeText(display).then(() => setCopied(true)).catch(() => undefined)}
          >
            <Copy className="h-4 w-4" />
            {copied ? 'نُسخ!' : 'نسخ'}
          </Button>
          <Button onClick={() => setStep('confirm')}>حفظته — متابعة</Button>
        </div>
      </div>
    );
  }

  const expected = key?.groups[confirmGroup - 1] ?? '';
  // يتجاهل المسافات والشرطات والعلامات المخفية التي قد تأتي مع النسخ واللصق.
  const typed = confirmText.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const ok = typed === expected || (key !== null && typed === key.groups.join(''));
  const mismatch = typed.length >= 4 && !ok;
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        للتأكد من أنك حفظته: اكتب المجموعة رقم <strong>{confirmGroup}</strong> (الرقم مكتوب تحت كل مجموعة)، أو الصق
        المفتاح كاملًا من الملف الذي نزّلته.
      </p>
      <Input
        dir="ltr"
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
        placeholder="XXXX"
        className="max-w-md font-mono"
        aria-label="مجموعة التأكيد من المفتاح"
        data-group={confirmGroup}
        autoComplete="off"
      />
      {mismatch && (
        <p className="text-sm text-red-600">
          لا يطابق المفتاح المعروض الآن. اضغط «رجوع» وقارن بما على الشاشة — إن كان لديك ملف من محاولة سابقة فهو لمفتاح
          آخر: نزّل الملف من جديد.
        </p>
      )}
      {ok && <p className="text-sm text-emerald-700">مطابق ✓</p>}
      <div className="flex gap-2">
        <Button onClick={() => key && enable.mutate(key.raw)} disabled={!ok} loading={enable.isPending}>
          <UploadCloud className="h-4 w-4" />
          تفعيل النسخ الاحتياطي
        </Button>
        <Button variant="ghost" onClick={() => setStep('show')}>
          رجوع
        </Button>
      </div>
      {enable.error && <p className="text-sm text-red-600">{errorText(enable.error, 'تعذر إنشاء النسخة')}</p>}
    </div>
  );
}

// --- إدخال مفتاح موجود (جهاز ثانٍ) -------------------------------------------------

function UseExistingKey({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState('');
  const mutation = useMutation({
    mutationFn: async () => {
      const raw = parseRecoveryKey(value);
      const { matches } = await checkKeyAgainstServer(raw);
      if (matches === 0) throw new Error('هذا المفتاح لا يطابق نسخك الموجودة — تأكد منه');
      return enableRecovery(raw);
    },
    onSuccess: onDone,
  });
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate();
      }}
    >
      <p className="text-sm text-gray-600">
        لديك مفتاح استعادة أنشأته على جهاز آخر. أدخله هنا ليُنسخ هذا الجهاز احتياطيًا بالمفتاح نفسه.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input dir="ltr" value={value} onChange={(e) => setValue(e.target.value)} placeholder="XXXX-XXXX-XXXX-…" className="font-mono" autoComplete="off" aria-label="مفتاح الاستعادة الحالي" />
        <Button type="submit" variant="outline" loading={mutation.isPending}>
          اعتماد المفتاح
        </Button>
      </div>
      {mutation.error && <p className="text-sm text-red-600">{errorText(mutation.error, 'تعذر اعتماد المفتاح')}</p>}
    </form>
  );
}

// --- الحالة على جهاز نشط ---------------------------------------------------------------

function BackupSection() {
  const queryClient = useQueryClient();
  const status = useRecoveryStatus();
  const backups = useServerBackups();
  const [rotating, setRotating] = useState(false);
  const [createNew, setCreateNew] = useState(false);
  const refresh = () => {
    setRotating(false);
    setCreateNew(false);
    void queryClient.invalidateQueries({ queryKey: ['recovery-status'] });
    void queryClient.invalidateQueries({ queryKey: ['key-backups'] });
  };
  const now = useMutation({ mutationFn: () => backupNow({ force: true }), onSettled: refresh });

  if (status.isLoading) return <Spinner />;
  const s = status.data;

  if (!s?.configured || rotating) {
    const othersExist = (backups.data?.length ?? 0) > 0 && !rotating;
    return (
      <div className="space-y-4">
        {!rotating && (
          <div className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            النسخ الاحتياطي غير مفعّل على هذا الجهاز. إن مُسحت بيانات المتصفح أو تعطّل الجهاز ستفقد مراسلاتك نهائيًا.
          </div>
        )}
        {othersExist && !createNew ? (
          <>
            <UseExistingKey onDone={refresh} />
            <button type="button" className="text-xs text-primary-700 hover:underline" onClick={() => setCreateNew(true)}>
              أضعت المفتاح؟ أنشئ مفتاحًا جديدًا لهذا الجهاز
            </button>
          </>
        ) : (
          <CreateKeyWizard onDone={refresh} rotating={rotating} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          النسخ الاحتياطي التلقائي مفعّل. تُرفع نسخة مشفّرة بعد كل تغيير (المفاتيح والمراسلات والمحادثات المفكوكة على هذا
          الجهاز). آخر نسخة: <strong>{formatDate(s.lastBackupAt)}</strong>
        </span>
      </div>
      {s.lastError && <p className="text-sm text-red-600">آخر محاولة فشلت: {s.lastError}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => now.mutate()} loading={now.isPending}>
          <RefreshCw className="h-4 w-4" />
          نسخ الآن
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setRotating(true)}>
          <KeyRound className="h-4 w-4" />
          استبدال المفتاح
        </Button>
      </div>
      {now.error && <p className="text-sm text-red-600">{errorText(now.error, 'تعذر رفع النسخة')}</p>}
      {backups.data && backups.data.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-medium text-gray-700">النسخ على الخادم (مشفّرة — الخادم لا يستطيع فتحها)</h4>
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 text-sm">
            {backups.data.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="text-gray-800">{b.device_label}</span>
                <span className="text-xs text-gray-500">
                  {formatDate(b.created_at)} · {formatSize(b.size)}
                  {b.key_id !== s.keyId && ' · بمفتاح آخر'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// --- الاستعادة على هذا المتصفح ------------------------------------------------------------

function RestorePanel({ emphasized }: { emphasized: boolean }) {
  const [value, setValue] = useState('');
  const [understood, setUnderstood] = useState(false);
  const mutation = useMutation({
    mutationFn: () => restoreFromRecoveryKey(value),
    onSuccess: () => {
      resetCryptoBootstrap();
      setTimeout(() => window.location.assign('/mail/inbox'), 1500);
    },
  });

  return (
    <div className={emphasized ? 'space-y-3' : 'mt-6 space-y-3 border-t border-gray-200 pt-4'}>
      <h4 className="text-sm font-semibold text-gray-900">استعادة حسابي على هذا المتصفح</h4>
      <p className="text-sm text-gray-600">
        للمتصفح الجديد بعد فقدان جهازك القديم: أدخل مفتاح الاستعادة فتُسترجع مفاتيحك ومراسلاتك ومحادثاتك من آخر نسخة.
      </p>
      <p className="flex items-start gap-1.5 text-xs text-amber-700">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        إن كان جهازك القديم ما زال يعمل فلا تستعد هنا — اعتمد هذا المتصفح من صفحة الأجهزة على جهازك القديم.
      </p>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        <Input
          dir="ltr"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
          autoComplete="off"
          className="font-mono"
          aria-label="مفتاح الاستعادة"
        />
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="accent-primary-600" />
          جهازي القديم مفقود أو لم يعد يعمل
        </label>
        <Button type="submit" loading={mutation.isPending} disabled={!understood || mutation.isSuccess}>
          استعادة
        </Button>
      </form>
      {mutation.error && <p className="text-sm text-red-600">{errorText(mutation.error, 'تعذرت الاستعادة')}</p>}
      {mutation.data && (
        <p className="flex items-center gap-2 text-sm text-emerald-700">
          <CheckCircle2 className="h-4 w-4" />
          تمت الاستعادة من نسخة {formatDate(mutation.data.backupAt)} — جارٍ فتح البريد…
        </p>
      )}
    </div>
  );
}

export const Recovery = () => {
  const bootstrap = useCryptoBootstrap();
  const pending = bootstrap.status === 'pending_approval';
  return (
    <Card className="mx-auto max-w-2xl">
      <CardHeader>
        <CardTitle>الاستعادة والنسخ الاحتياطي</CardTitle>
        <p className="text-sm text-gray-500">
          النسخة تُشفّر على جهازك بمفتاح الاستعادة قبل رفعها؛ الخادم والإدارة لا يستطيعون فتحها.
        </p>
      </CardHeader>
      <CardContent>
        {bootstrap.status === 'loading' ? (
          <Spinner />
        ) : pending ? (
          <RestorePanel emphasized />
        ) : (
          <>
            {bootstrap.status === 'ready' && <BackupSection />}
            <RestorePanel emphasized={false} />
          </>
        )}
      </CardContent>
    </Card>
  );
};

export const RecoveryPages = { Recovery };
