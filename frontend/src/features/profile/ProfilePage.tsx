import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, KeyRound, Mail, PenLine, Phone, ShieldCheck, UserRound } from 'lucide-react';
import { SignatureManager } from '../approvals/SignaturePad';
import { apiFetch, toUserMessage } from '../../shared/api';
import { Avatar, Button, Card, Input, Label, Spinner } from '../../shared/ui';
import { useAuth } from '../auth/AuthContext';

export interface MyProfile {
  id: string;
  username: string;
  full_name: string;
  first_name: string;
  last_name: string;
  phone: string;
  optional_email: string | null;
  external_address: string | null;
  membership: { institute: string; branch: string | null; department: string | null; job_title: string } | null;
  roles: Array<{ code: string; name: string; scope: string }>;
  mfa_enabled: boolean;
  last_login_at: string | null;
  password_changed_at: string | null;
}

const profileApi = {
  get: () => apiFetch<MyProfile>('/users/me/profile/'),
  update: (body: { phone?: string; optional_email?: string; current_password: string }) =>
    apiFetch<MyProfile>('/users/me/profile/', { method: 'PATCH', body }),
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
      <dt className="w-40 shrink-0 text-sm text-gray-500">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-gray-900">{children}</dd>
    </div>
  );
}

function ContactForm({ profile }: { profile: MyProfile }) {
  const queryClient = useQueryClient();
  const [phone, setPhone] = useState(profile.phone);
  const [email, setEmail] = useState(profile.optional_email ?? '');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const changed = phone.trim() !== profile.phone || email.trim().toLowerCase() !== (profile.optional_email ?? '');
  const save = useMutation({
    mutationFn: () => profileApi.update({ phone: phone.trim(), optional_email: email.trim(), current_password: password }),
    onSuccess: (p) => {
      queryClient.setQueryData(['my-profile'], p);
      setEmail(p.optional_email ?? '');
      setPhone(p.phone);
      setPassword('');
      setMessage({ ok: true, text: 'حُفظت بيانات التواصل.' });
    },
    onError: (err) => setMessage({ ok: false, text: toUserMessage(err, 'تعذر الحفظ') }),
  });
  return (
    <form
      className="space-y-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        setMessage(null);
        save.mutate();
      }}
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <Label htmlFor="me-email">بريدك الإلكتروني الشخصي (اختياري)</Label>
          <Input id="me-email" dir="ltr" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="me-phone">الجوال</Label>
          <Input id="me-phone" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
      </div>
      {changed && (
        <div className="md:w-1/2">
          <Label htmlFor="me-current">كلمة المرور الحالية للتأكيد</Label>
          <Input id="me-current" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
      )}
      <p className="text-xs text-gray-500">
        البريد الشخصي تصله أكواد الدخول إن كنت مسؤولًا. لتعديل الاسم أو الفرع أو الأدوار راجع مدير النظام.
      </p>
      {message && <p className={message.ok ? 'text-sm text-emerald-700' : 'text-sm text-red-600'}>{message.text}</p>}
      <Button type="submit" size="sm" disabled={!changed || !password} loading={save.isPending}>
        حفظ
      </Button>
    </form>
  );
}

function PasswordForm() {
  const { changeOwnPassword } = useAuth();
  const queryClient = useQueryClient();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);
    if (newPassword !== confirm) return setMessage({ ok: false, text: 'كلمتا المرور الجديدتان غير متطابقتين' });
    setLoading(true);
    try {
      await changeOwnPassword(oldPassword, newPassword);
      setOldPassword('');
      setNewPassword('');
      setConfirm('');
      void queryClient.invalidateQueries({ queryKey: ['my-profile'] });
      setMessage({ ok: true, text: 'تم تغيير كلمة المرور، وخرجت أجهزتك الأخرى — ادخل عليها بالكلمة الجديدة.' });
    } catch (err) {
      setMessage({ ok: false, text: toUserMessage(err, 'تعذر تغيير كلمة المرور') });
    } finally {
      setLoading(false);
    }
  };
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div>
          <Label htmlFor="pw-old">كلمة المرور الحالية</Label>
          <Input id="pw-old" type="password" autoComplete="current-password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="pw-new">كلمة المرور الجديدة</Label>
          <Input id="pw-new" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="pw-confirm">تأكيد الجديدة</Label>
          <Input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </div>
      </div>
      <p className="text-xs text-gray-500">10 أحرف على الأقل، ولا تحتوي على اسم المستخدم.</p>
      {message && <p className={message.ok ? 'text-sm text-emerald-700' : 'text-sm text-red-600'}>{message.text}</p>}
      <Button type="submit" size="sm" loading={loading}>
        تغيير كلمة المرور
      </Button>
    </form>
  );
}

function Section({ icon: Icon, title, children }: { icon: typeof UserRound; title: string; children: ReactNode }) {
  return (
    <Card className="space-y-3 p-5">
      <h3 className="flex items-center gap-2 font-semibold text-gray-900">
        <Icon className="h-4 w-4 text-primary-700" />
        {title}
      </h3>
      {children}
    </Card>
  );
}

export function ProfilePage() {
  const { data: p, isLoading, error } = useQuery({ queryKey: ['my-profile'], queryFn: profileApi.get });
  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }
  if (error || !p) return <p className="p-6 text-sm text-red-600">{toUserMessage(error, 'تعذر تحميل بياناتك')}</p>;
  const unit = p.membership ? [p.membership.department, p.membership.branch, p.membership.institute].filter(Boolean).join(' — ') : '—';
  return (
    <div className="mx-auto max-w-3xl space-y-4" data-testid="profile-page">
      <div className="flex items-center gap-4">
        <Avatar name={p.full_name || p.username} size="lg" />
        <div className="min-w-0">
          <h2 className="break-words text-xl font-semibold text-gray-900">{p.full_name || p.username}</h2>
          <p className="text-sm text-gray-500">
            {p.membership?.job_title ? `${p.membership.job_title} · ` : ''}
            {p.membership?.branch ?? p.membership?.institute ?? ''}
          </p>
        </div>
      </div>

      <Section icon={UserRound} title="بياناتي">
        <dl className="divide-y divide-gray-100">
          <Row label="اسم المستخدم (للدخول)"><span dir="ltr" className="font-mono">{p.username}</span></Row>
          <Row label="الاسم الأول / العائلة">{p.first_name || '—'} / {p.last_name || '—'}</Row>
          <Row label="جهة العمل">{unit}</Row>
          <Row label="الأدوار">
            {p.roles.length === 0 ? '—' : (
              <span className="flex flex-wrap gap-1.5">
                {p.roles.map((r) => (
                  <span key={`${r.code}-${r.scope}`} className="rounded-full bg-primary-50 px-2 py-0.5 text-xs text-primary-700">
                    {r.name} · {r.scope}
                  </span>
                ))}
              </span>
            )}
          </Row>
          <Row label="بريدي الخارجي">
            {p.external_address ? (
              <span className="inline-flex items-center gap-1.5">
                <Globe className="h-3.5 w-3.5 text-gray-400" />
                <span dir="ltr" className="font-mono">{p.external_address}</span>
              </span>
            ) : '—'}
          </Row>
          <Row label="آخر دخول">{formatDate(p.last_login_at)}</Row>
          <Row label="آخر تغيير لكلمة المرور">{formatDate(p.password_changed_at)}</Row>
        </dl>
      </Section>

      <Section icon={Mail} title="بيانات التواصل">
        <ContactForm profile={p} />
      </Section>

      <Section icon={PenLine} title="توقيعي">
        <SignatureManager />
      </Section>

      <Section icon={KeyRound} title="كلمة المرور">
        <PasswordForm />
      </Section>

      <Section icon={ShieldCheck} title="الأمان">
        <p className="text-sm text-gray-600">
          التحقق الثنائي: <strong>{p.mfa_enabled ? 'مفعّل' : 'غير مفعّل'}</strong>. الأجهزة التي دخلت منها ونشاط حسابك في{' '}
          <Link to="/security" className="text-primary-700 underline">صفحة الأمان</Link>.
        </p>
        <p className="flex items-center gap-1.5 text-xs text-gray-500">
          <Phone className="h-3.5 w-3.5" />
          نسيت كلمة المرور؟ يعيد مدير النظام تعيينها لك.
        </p>
      </Section>
    </div>
  );
}
