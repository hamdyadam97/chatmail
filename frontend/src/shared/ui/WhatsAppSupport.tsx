import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client';
import { cn } from '../lib/cn';

const MESSAGE = 'السلام عليكم، عندي استفسار/مشكلة في نظام المراسلات:';

/** رقم الدعم من إعدادات الخادم (لا يوجد في المستودع). */
function useSupportNumber(): string | null {
  const { data } = useQuery({
    queryKey: ['support-contact'],
    queryFn: () => apiFetch<{ whatsapp: string | null }>('/auth/support/', { auth: false }),
    staleTime: Infinity,
    retry: false,
  });
  return data?.whatsapp ?? null;
}

function WhatsAppGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z" />
    </svg>
  );
}

/**
 * «تواصل مع الدعم» على واتساب. `variant`: rail = عمود الأقسام (سطح المكتب)،
 * icon = زر صغير في الرأس (الموبايل)، floating = زر عائم (صفحة الدخول).
 */
export function WhatsAppSupport({ variant, className }: { variant: 'rail' | 'icon' | 'floating'; className?: string }) {
  const number = useSupportNumber();
  if (!number) return null;
  const href = `https://wa.me/${number}?text=${encodeURIComponent(MESSAGE)}`;
  const common = { href, target: '_blank', rel: 'noopener noreferrer', title: 'تواصل مع الدعم على واتساب', 'data-testid': 'whatsapp-support' };
  if (variant === 'rail') {
    return (
      <a {...common} className={cn('group flex w-full flex-col items-center gap-1 rounded-lg py-2 text-[11px] font-medium text-white/60 hover:text-white', className)}>
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#25D366] text-white group-hover:brightness-110">
          <WhatsAppGlyph className="h-5 w-5" />
        </span>
        الدعم
      </a>
    );
  }
  if (variant === 'icon') {
    return (
      <a {...common} aria-label="الدعم على واتساب" className={cn('rounded-lg p-1.5 text-[#1fa855] hover:bg-gray-100', className)}>
        <WhatsAppGlyph className="h-5 w-5" />
      </a>
    );
  }
  return (
    <a
      {...common}
      className={cn(
        'fixed bottom-5 left-5 z-40 flex items-center gap-2 rounded-full bg-[#25D366] py-2.5 pe-4 ps-3 text-sm font-medium text-white shadow-lg hover:brightness-110',
        className,
      )}
    >
      <WhatsAppGlyph className="h-5 w-5" />
      الدعم على واتساب
    </a>
  );
}
