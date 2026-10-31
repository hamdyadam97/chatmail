import { cn } from './lib/cn';

/** الجهة المالكة (مؤسسة صرخة للتجارة والمقاولات) — الشعار الرئيسي. */
export const OWNER = { name: 'مؤسسة صرخة للتجارة والمقاولات', logo: '/brand/owner.png' };

/** شعارات المعاهد حسب رمز المعهد (نفس الرمز في الأرقام المرجعية). */
export const INSTITUTE_LOGOS: Record<string, string> = {
  AHL: '/brand/institutes/AHL.png',
  FAW: '/brand/institutes/FAW.png',
  FAS: '/brand/institutes/FAS.png',
  THQ: '/brand/institutes/THQ.png',
  MWR: '/brand/institutes/MWR.png',
  AFQ: '/brand/institutes/AFQ.png',
  VSN: '/brand/institutes/VSN.png',
};

export const GROUP_INSTITUTES: Array<{ code: string; name: string }> = [
  { code: 'AHL', name: 'المعهد الأهلي العالي للتدريب' },
  { code: 'THQ', name: 'معهد الثقة الدائمة العالي للتدريب' },
  { code: 'FAW', name: 'معهد الفاو المتقدم العالي للتدريب' },
  { code: 'FAS', name: 'معهد الفاو التخصصي العالي للتدريب' },
  { code: 'MWR', name: 'معهد المورد الوافي العالي للتدريب' },
  { code: 'AFQ', name: 'معهد آفاق التطور العالي للتدريب' },
  { code: 'VSN', name: 'Vision 3020 للتدريب' },
];

/** شعار معهد، أو حروف اسمه إن لم يكن له شعار (معهد يُضاف لاحقًا من الإدارة). */
export function InstituteLogo({ code, name, className }: { code?: string | null; name: string; className?: string }) {
  const src = code ? INSTITUTE_LOGOS[code] : undefined;
  if (src) return <img src={src} alt={name} title={name} className={cn('object-contain', className)} loading="lazy" />;
  return (
    <span
      title={name}
      className={cn('inline-flex items-center justify-center rounded-lg bg-primary-50 text-xs font-bold text-primary-700', className)}
    >
      {code ?? name.slice(0, 2)}
    </span>
  );
}
