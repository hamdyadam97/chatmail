import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { toUserMessage } from '../../shared/api';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '../../shared/ui';
import { useAuth } from './AuthContext';

type Step = 'password' | 'otp';

export default function LoginPage() {
  const { status, login, verifyMfa } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [step, setStep] = useState<Step>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
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
    <div className="flex min-h-screen items-center justify-center bg-gray-100 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-xl">نظام المراسلات الداخلية</CardTitle>
          <CardDescription>
            {step === 'password' ? 'سجّل الدخول للمتابعة' : 'أدخل رمز التحقق الثنائي (MFA)'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {step === 'password' ? (
            <form onSubmit={handlePasswordSubmit} className="flex flex-col gap-4">
              <div>
                <Label htmlFor="username">اسم المستخدم</Label>
                <Input
                  id="username"
                  autoComplete="username"
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="password">كلمة المرور</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button type="submit" loading={loading}>
                تسجيل الدخول
              </Button>
            </form>
          ) : (
            <form onSubmit={handleOtpSubmit} className="flex flex-col gap-4">
              <div>
                <Label htmlFor="otp">رمز التحقق</Label>
                <Input
                  id="otp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  autoFocus
                  className="text-center text-lg tracking-[0.5em]"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                  required
                />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button type="submit" loading={loading}>
                تحقق
              </Button>
              <Button type="button" variant="ghost" onClick={() => setStep('password')}>
                رجوع
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
