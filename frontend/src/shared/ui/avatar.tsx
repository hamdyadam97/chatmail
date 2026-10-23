import { cn } from '../lib/cn';

// ألوان ثابتة لكل اسم (نفس الشخص = نفس اللون في البريد والمحادثات).
const PALETTE = [
  'bg-blue-600',
  'bg-emerald-600',
  'bg-violet-600',
  'bg-amber-600',
  'bg-rose-600',
  'bg-cyan-700',
  'bg-indigo-600',
  'bg-teal-600',
  'bg-fuchsia-700',
  'bg-orange-600',
];

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** أول حرف دال من الكلمة: «العتيبي» ← «ع» لا «ا» (أداة التعريف لا تميّز أحدًا). */
function firstLetter(word: string): string {
  const core = word.length > 3 && word.startsWith('ال') ? word.slice(2) : word;
  return core[0] ?? '';
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '؟';
  if (parts.length === 1) return parts[0].slice(0, 2);
  // مسافة رفيعة بين الحرفين: الحروف العربية المنفصلة تتلاصق بصريًا بدونها.
  return `${firstLetter(parts[0])} ${firstLetter(parts[parts.length - 1])}`;
}

const SIZES = { xs: 'h-6 w-6 text-[10px]', sm: 'h-8 w-8 text-xs', md: 'h-9 w-9 text-sm', lg: 'h-11 w-11 text-base' };

export function Avatar({
  name,
  size = 'md',
  square = false,
  className,
}: {
  name: string;
  size?: keyof typeof SIZES;
  /** مربع بزوايا مستديرة (أسلوب Slack) بدل الدائرة (أسلوب Outlook). */
  square?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center font-semibold text-white',
        square ? 'rounded-md' : 'rounded-full',
        PALETTE[hash(name) % PALETTE.length],
        SIZES[size],
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
