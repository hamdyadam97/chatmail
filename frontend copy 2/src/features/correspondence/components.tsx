import { archiveKeyApi } from '../../crypto/archive';
import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Lock, RefreshCw, X } from 'lucide-react';
import { Button, Card, Spinner } from '../../shared/ui';
import { cn } from '../../shared/lib/cn';
import { resetCryptoBootstrap, useCryptoBootstrap } from '../../crypto/useCryptoBootstrap';
import { useAuth } from '../auth/AuthContext';
import { chatApi } from '../chat/api';
import {
  CLASSIFICATION_LABELS,
  PRIORITY_LABELS,
  type Classification,
  type Priority,
} from './api';

/** يعرض المحتوى فقط بعد جاهزية التشفير على هذا الجهاز (نفس حالات صفحة الشات). */
export function CryptoGate({ children }: { children: ReactNode }) {
  const bootstrap = useCryptoBootstrap();
  if (bootstrap.status === 'loading') {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }
  if (bootstrap.status === 'error') {
    return (
      <Card className="mx-auto mt-10 flex max-w-md flex-col items-center gap-3 p-8 text-center">
        <p className="text-sm text-red-600">{bootstrap.message}</p>
        <Button
          variant="outline"
          onClick={() => {
            resetCryptoBootstrap();
            window.location.reload();
          }}
        >
          <RefreshCw className="h-4 w-4" />
          إعادة المحاولة
        </Button>
      </Card>
    );
  }
  if (bootstrap.status === 'pending_approval') {
    return (
      <Card className="mx-auto mt-10 max-w-md p-8 text-center">
        <h3 className="text-base font-semibold text-gray-900">هذا الجهاز بانتظار الاعتماد</h3>
        <p className="mt-2 text-sm text-gray-500">
          اعتمد هذا الجهاز من أحد أجهزتك الموثّقة من صفحة الأجهزة ليُفعَّل التشفير الطرف-لطرف عليه.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Button variant="outline" onClick={() => (window.location.href = '/devices')}>
            الانتقال إلى الأجهزة
          </Button>
          <Button onClick={() => (window.location.href = '/recovery')}>فقدت جهازي — استعادة بالمفتاح</Button>
        </div>
      </Card>
    );
  }
  return <>{children}</>;
}

export function useDirectory() {
  return useQuery({ queryKey: ['directory-users'], queryFn: chatApi.listUsers, staleTime: 60_000 });
}

interface RecipientPickerProps {
  label: string;
  value: string[];
  onChange: (ids: string[]) => void;
  /** معرّفات لا تُعرض (أنا، والمختارون في الحقل الآخر). */
  exclude?: string[];
  id: string;
  /** سطر واحد بلا إطار والعنوان في بدايته (أسلوب محرر Outlook). */
  inline?: boolean;
}

export function RecipientPicker({ label, value, onChange, exclude = [], id, inline = false }: RecipientPickerProps) {
  const { user } = useAuth();
  const { data: users, isLoading } = useDirectory();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const byId = useMemo(() => new Map((users ?? []).map((u) => [String(u.id), u])), [users]);
  const hidden = useMemo(() => new Set([String(user?.id), ...exclude, ...value]), [user, exclude, value]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (users ?? [])
      .filter((u) => !hidden.has(String(u.id)))
      .filter(
        (u) =>
          !q ||
          (u.full_name ?? '').toLowerCase().includes(q) ||
          (u.username ?? '').toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [users, hidden, query]);

  return (
    <div className={cn('relative', inline && 'flex items-center gap-2')}>
      <label
        htmlFor={id}
        className={cn(
          'text-sm',
          inline ? 'w-16 shrink-0 rounded border border-gray-300 px-2 py-0.5 text-center text-gray-700' : 'mb-1 block font-medium text-gray-700',
        )}
      >
        {label}
      </label>
      <div
        className={cn(
          'flex min-h-10 flex-1 flex-wrap items-center gap-1 bg-white px-2 py-1',
          !inline && 'rounded-lg border border-gray-300 focus-within:ring-2 focus-within:ring-primary-500',
        )}
      >
        {value.map((uid) => {
          const u = byId.get(uid);
          return (
            <span key={uid} className="flex items-center gap-1 rounded-full bg-primary-50 px-2 py-0.5 text-xs text-primary-700">
              {u?.full_name ?? u?.username ?? uid}
              <button
                type="button"
                aria-label="إزالة"
                onClick={() => onChange(value.filter((v) => v !== uid))}
                className="text-primary-400 hover:text-primary-700"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          );
        })}
        <input
          id={id}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={value.length === 0 ? 'ابحث بالاسم أو اسم المستخدم' : ''}
          autoComplete="off"
          className="min-w-[8rem] flex-1 border-0 bg-transparent py-1 text-sm outline-none"
        />
      </div>
      {open && (
        <div role="listbox" aria-label={`اقتراحات ${label}`} className="absolute inset-x-0 top-full z-20 mt-1 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
          {isLoading && (
            <div className="flex justify-center py-3">
              <Spinner size="sm" />
            </div>
          )}
          {!isLoading && matches.length === 0 && (
            <p className="px-3 py-2 text-sm text-gray-400">لا نتائج</p>
          )}
          {matches.map((u) => (
            <button
              key={String(u.id)}
              type="button"
              role="option"
              aria-selected={false}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange([...value, String(u.id)]);
                setQuery('');
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm text-gray-700 hover:bg-gray-50"
            >
              <span>{u.full_name ?? u.username}</span>
              {u.full_name && u.username && <span className="text-xs text-gray-400">({u.username})</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const PRIORITY_STYLES: Record<Priority, string> = {
  low: 'bg-gray-100 text-gray-600',
  normal: 'bg-blue-50 text-blue-700',
  high: 'bg-amber-50 text-amber-700',
  urgent: 'bg-red-50 text-red-700',
};

export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', PRIORITY_STYLES[priority])}>
      {PRIORITY_LABELS[priority]}
    </span>
  );
}

export function ClassificationBadge({ classification }: { classification: Classification }) {
  if (classification === 'normal') return null;
  return (
    <span className="rounded-full bg-purple-50 px-2 py-0.5 text-xs font-medium text-purple-700">
      {CLASSIFICATION_LABELS[classification]}
    </span>
  );
}

export function E2EENote({ className }: { className?: string }) {
  return (
    <p className={cn('flex items-center gap-1.5 text-xs text-gray-500', className)}>
      <Lock className="h-3.5 w-3.5 text-emerald-600" />
      العنوان والنص والمرفقات تُشفَّر على جهازك قبل الإرسال؛ لا يستطيع الخادم ولا أي مسؤول قراءتها.
    </p>
  );
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

export function formatDay(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ar', { dateStyle: 'medium' }).format(new Date(iso));
}

/**
 * المستلم المؤسسي المعلن: يرى المرسل قبل الإرسال أن نسخة مشفّرة ستذهب للأرشيف
 * المركزي، ومن أنشأ مفتاحه (docs/phase1/README §3 — ليس بابًا خلفيًا).
 */
export function ArchiveNotice() {
  const { data, isLoading } = useQuery({ queryKey: ['archive-key'], queryFn: archiveKeyApi.state, staleTime: 60_000 });
  if (isLoading) return null;
  if (!data?.key) {
    return (
      <p className="rounded-lg bg-red-50 p-3 text-xs text-red-700" data-testid="archive-notice">
        هذا التصنيف يرسل نسخة مشفّرة إلى الأرشيف المركزي، لكن الأرشيف لم يُهيأ بعد — لن يمكن الإرسال حتى يهيئه ضابط
        الأرشيف.
      </p>
    );
  }
  return (
    <p className="rounded-lg bg-indigo-50 p-3 text-xs text-indigo-800" data-testid="archive-notice">
      ستُرسل <strong>نسخة مشفّرة إلى الأرشيف المركزي</strong> (مستلم مؤسسي معلن؛ مفتاحه الإصدار {data.key.version} أنشأه{' '}
      {data.key.created_by}). يفتحها ضباط الأرشيف المعتمدون فقط، وكل فتح يُسجَّل في سجل التدقيق. الخادم والإدارة لا يقرؤونها.
    </p>
  );
}
