import { useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, Eye, EyeOff, KeyRound, Lock, MonitorSmartphone, ShieldCheck, User } from 'lucide-react';
import { toUserMessage } from '../../shared/api';
import { Button } from '../../shared/ui';
import { cn } from '../../shared/lib/cn';
import { GROUP_INSTITUTES, InstituteLogo, OWNER } from '../../shared/brand';
import { useAuth } from './AuthContext';

type Step = 'password' | 'otp';

const POINTS = [
  { icon: Lock, title: 'محفوظة مشفّرة', text: 'المراسلات والمرفقات تُحفظ مشفّرة، ولا يطلع عليها إلا أطرافها.' },
  { icon: ShieldCheck, title: 'تحقق ثنائي وسجل تدقيق', text: 'احمِ حسابك بالتحقق بخطوتين؛ وكل اطلاع إداري يُسجَّل.' },
  { icon: MonitorSmartphone, title: 'من أي جهاز', text: 'ادخل من الكمبيوتر أو الموبايل وتجد بريدك كاملًا.' },
];

/** شعارات معاهد المجموعة على بطاقة بيضاء (ألوان الشعارات لا تظهر على الأزرق). */
function InstitutesStrip({ className }: { className?: string }) {
  return (
    <div className={cn('rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5', className)}>
      <p className="mb-3 text-center text-xs font-medium text-gray-500">معاهد المجموعة</p>
      <ul className="grid grid-cols-4 items-center gap-x-3 gap-y-4">
        {GROUP_INSTITUTES.map((i) => (
          <li key={i.code} className="flex h-12 items-center justify-center">
            <InstituteLogo code={i.code} name={i.name} className="max-h-12 w-full" />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** حقل بأيقونة — الأيقونة في بداية السطر (يمين في RTL). */
function Field({
  id,
  label,
  icon: Icon,
  children,
}: {
  id: string;
  label: string;
  icon: typeof User;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-gray-700">
        {label}
      </label>
      <div className="relative">
        <Icon className="pointer-events-none absolute start-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400" />
        {children}
      </div>
    </div>
  );
}

// الحقول LTR (أسماء مستخدمين وكلمات مرور لاتينية) داخل صفحة RTL: الأيقونة يمينًا فعليًا
// فالحشو فيزيائي (pr/pl) لا منطقي (ps/pe) — وإلا تراكب النص على الأيقونة.
const inputClass =
  'h-12 w-full rounded-xl border border-gray-300 bg-white pr-11 pl-3 text-right text-base text-gray-900 placeholder:text-gray-400 ' +
  'transition focus:border-primary-500 focus:outline-none focus:ring-4 focus:ring-primary-100';

export default function LoginPage() {
  const { status, login, verifyMfa } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [step, setStep] = useState<Step>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [mfaToken, setMfaToken] = useState('');
  const [otp, setOtp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (status === 'authenticated') {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? '/'} replace />;
  }

  const handlePasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await login(username, password);
      if (result.ok) {
        navigate('/', { replace: true });
      } else {
        setMfaToken(result.mfaToken);
        setOtp('');
        setStep('otp');
      }
    } catch (err) {
      setError(toUserMessage(err, 'تعذر تسجيل الدخول، تحقق من البيانات وحاول مجددًا'));
    } finally {
      setLoading(false);
    }
  };

  const handleOtpSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await verifyMfa(mfaToken, otp);
      navigate('/', { replace: true });
    } catch (err) {
      setError(toUserMessage(err, 'تعذر التحقق من رمز MFA، حاول مجددًا'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh] flex-col bg-white lg:flex-row">
      {/* لوحة الهوية — يمين الشاشة في RTL؛ على الموبايل شريط علوي مختصر */}
      <aside className="relative overflow-hidden bg-gradient-to-br from-primary-900 via-primary-800 to-primary-600 text-white lg:flex lg:w-[46%] lg:flex-col lg:justify-between lg:p-12">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, #fff 1px, transparent 0)', backgroundSize: '22px 22px' }}
          aria-hidden="true"
        />
        <div className="relative flex items-center gap-4 px-6 py-5 lg:p-0" style={{ paddingTop: 'max(1.25rem, env(safe-area-inset-top))' }}>
          <span className="flex h-14 shrink-0 items-center rounded-2xl bg-white px-3 shadow-sm lg:h-16">
            <img src={OWNER.logo} alt={OWNER.name} className="h-10 w-auto lg:h-12" />
          </span>
          <div>
            <p className="text-lg font-bold leading-tight lg:text-xl">نظام المراسلات الداخلية</p>
            <p className="text-sm text-white/70">مجموعة المعاهد</p>
          </div>
        </div>

        <div className="relative hidden lg:block">
          <h1 className="max-w-md text-3xl font-bold leading-snug">مراسلاتكم الرسمية ومحادثاتكم، في مكان واحد آمن.</h1>
          <ul className="mt-10 space-y-6">
            {POINTS.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/20">
                  <Icon className="h-5 w-5" />
                </span>
                <span>
                  <span className="block font-semibold">{title}</span>
                  <span className="block text-sm leading-6 text-white/70">{text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative hidden space-y-3 lg:block">
          <InstitutesStrip />
          <p className="text-xs text-white/50">استخدام هذا النظام مقصور على منسوبي المعاهد المصرّح لهم.</p>
        </div>
      </aside>

      {/* النموذج */}
      <main className="flex flex-1 items-start justify-center px-6 pb-10 pt-8 lg:items-center lg:p-12">
        <div className="w-full max-w-sm">
          {step === 'password' ? (
            <>
              <h2 className="text-2xl font-bold text-gray-900">تسجيل الدخول</h2>
              <p className="mt-1 text-sm text-gray-500">أدخل بيانات حسابك للمتابعة</p>

              <form onSubmit={handlePasswordSubmit} className="mt-8 space-y-5" noValidate>
                <Field id="username" label="اسم المستخدم" icon={User}>
                  <input
                    id="username"
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    autoFocus
                    dir="ltr"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    className={inputClass}
                  />
                </Field>
                <Field id="password" label="كلمة المرور" icon={Lock}>
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    dir="ltr"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className={cn(inputClass, 'pl-11')}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute end-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                    aria-label={showPassword ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
                  >
                    {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
                </Field>

                {error && (
                  <div role="alert" className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-700 ring-1 ring-red-100">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    {error}
                  </div>
                )}

                <Button type="submit" loading={loading} disabled={!username || !password} className="h-12 w-full rounded-xl text-base">
                  تسجيل الدخول
                </Button>
              </form>

              <p className="mt-6 text-center text-sm text-gray-500">
                نسيت كلمة المرور؟ تواصل مع مسؤول النظام لإعادة تعيينها — لا يؤثر ذلك على مفاتيح تشفيرك.
              </p>
              <InstitutesStrip className="mt-10 lg:hidden" />
            </>
          ) : (
            <>
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-50 text-primary-700">
                <KeyRound className="h-6 w-6" />
              </span>
              <h2 className="mt-4 text-2xl font-bold text-gray-900">التحقق الثنائي</h2>
              <p className="mt-1 text-sm text-gray-500">أدخل الرمز المكوّن من 6 أرقام من تطبيق المصادقة على هاتفك.</p>

              <form onSubmit={handleOtpSubmit} className="mt-8 space-y-5">
                <input
                  id="otp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  autoFocus
                  dir="ltr"
                  aria-label="رمز التحقق"
                  placeholder="••••••"
                  className="h-14 w-full rounded-xl border border-gray-300 text-center font-mono text-2xl tracking-[0.6em] focus:border-primary-500 focus:outline-none focus:ring-4 focus:ring-primary-100"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                  required
                />
                {error && (
                  <div role="alert" className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-700 ring-1 ring-red-100">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    {error}
                  </div>
                )}
                <Button type="submit" loading={loading} disabled={otp.length !== 6} className="h-12 w-full rounded-xl text-base">
                  تحقق
                </Button>
                <Button type="button" variant="ghost" className="w-full" onClick={() => setStep('password')}>
                  رجوع
                </Button>
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
