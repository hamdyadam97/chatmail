/** تواريخ قصيرة بالعربية كما في تطبيقات البريد: الوقت اليوم، «أمس»، اسم اليوم، ثم التاريخ. */
const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

function time(d: Date): string {
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const suffix = h < 12 ? 'ص' : 'م';
  h = h % 12 || 12;
  return `${h}:${m} ${suffix}`;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  if (days <= 0) return time(d);
  if (days === 1) return 'أمس';
  if (days < 7) return DAYS[d.getDay()];
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function fullDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} — ${time(d)}`;
}

export function initials(name: string | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '؟';
  return parts.length === 1 ? parts[0].slice(0, 2) : `${parts[0][0]} ${parts[parts.length - 1][0]}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} بايت`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} ك.ب`;
  return `${(n / 1024 / 1024).toFixed(1)} م.ب`;
}
