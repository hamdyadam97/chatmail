import { saveBlob } from '../../shared/lib/download';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, BarChart3, CheckCircle2, Download, Table2, XCircle } from 'lucide-react';
import { Button, Card, EmptyState, Input, Label, Spinner } from '../../shared/ui';
import { ApiError, apiFetch, rawFetch, toUserMessage } from '../../shared/api';
import { cn } from '../../shared/lib/cn';

// ---------------------------------------------------------------------------
// العقد — تقارير مجمّعة فقط (لا أسماء ولا عناوين ولا أطراف)
// ---------------------------------------------------------------------------

interface ReportUnit {
  type: 'all' | 'institute' | 'branch' | 'department';
  id: string | null;
  name: string;
}

interface Report {
  scope: { type: string; id: string | null; name: string };
  period: { from: string; to: string };
  correspondence: {
    sent: number;
    new_threads: number;
    replies: number;
    forwards: number;
    closed: number;
    overdue_open: number;
    with_due_date: number;
    avg_first_reply_hours: number | null;
    median_first_reply_hours: number | null;
    replied_threads: number;
  };
  approvals: { requests: number; by_status: Record<string, number>; avg_decision_hours: number | null };
  announcements: { published: number; requiring_ack: number; ack_rate: number | null; overdue_acks: number };
  usage: { employees: number; active_last_30_days: number; active_devices: number; chat_messages: number };
  monthly: Array<{ month: string; sent: number }>;
  breakdown: {
    rows: Array<{
      unit: { id: string; name: string; code: string };
      employees: number;
      sent: number;
      closed: number;
      overdue_open: number;
      avg_first_reply_hours: number | null;
    }>;
    merged_small_units: { units: number; employees: number; sent: number; overdue_open: number } | null;
    min_group_size: number;
  };
  generated_at: string;
}

interface Health {
  status: 'ok' | 'degraded';
  checks: Record<string, { ok: boolean; error?: string; [k: string]: unknown }>;
  checked_at: string;
}

const reportsApi = {
  units: () => apiFetch<ReportUnit[]>('/reports/units/'),
  report: (u: ReportUnit, from: string, to: string) =>
    apiFetch<Report>(`/reports/?unit_type=${u.type}${u.id ? `&unit_id=${u.id}` : ''}&from=${from}&to=${to}`),
  health: () => apiFetch<Health>('/reports/health/'),
};

// ---------------------------------------------------------------------------
// عناصر العرض
// ---------------------------------------------------------------------------

const fmt = new Intl.NumberFormat('ar');
const hours = (h: number | null) => (h === null ? '—' : h < 48 ? `${fmt.format(h)} ساعة` : `${fmt.format(Math.round(h / 24))} يوم`);

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'warn' }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={cn('mt-1 text-2xl font-semibold tabular-nums text-gray-900', tone === 'warn' && 'text-amber-700')}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-gray-400">{hint}</div>}
    </Card>
  );
}

const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};

/**
 * أعمدة شهرية بلا مكتبة: سلسلة واحدة (لا مفتاح ألوان — العنوان يسميها)، أعمدة
 * رفيعة بحواف علوية 4px مثبتة على خط الأساس، شبكة باهتة، تلميح عند التمرير
 * لكل عمود، وتسمية مباشرة لأعلى قيمة فقط، وعرض جدولي بديل.
 */
function MonthlyBars({ data }: { data: Report['monthly'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const max = Math.max(1, ...data.map((d) => d.sent));
  const peak = data.findIndex((d) => d.sent === max);

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">المراسلات المرسلة شهريًا</h3>
        <Button variant="ghost" size="sm" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>
          {asTable ? <BarChart3 className="h-4 w-4" /> : <Table2 className="h-4 w-4" />}
          {asTable ? 'رسم' : 'جدول'}
        </Button>
      </div>
      {data.length === 0 ? (
        <p className="py-10 text-center text-sm text-gray-400">لا مراسلات في هذه الفترة</p>
      ) : asTable ? (
        <table className="w-full text-sm">
          <tbody>
            {data.map((d) => (
              <tr key={d.month} className="border-t border-gray-100">
                <td className="py-1.5 text-gray-700">{monthLabel(d.month)}</td>
                <td className="py-1.5 text-end tabular-nums text-gray-900">{fmt.format(d.sent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="relative">
          <div className="absolute inset-x-0 top-0 border-t border-dashed border-gray-200" aria-hidden />
          <span className="absolute -top-2 end-0 bg-white ps-1 text-[11px] tabular-nums text-gray-400">{fmt.format(max)}</span>
          <div className="flex h-44 items-end gap-0.5 border-b border-gray-300 pt-4" dir="ltr" role="list" aria-label="المراسلات المرسلة شهريًا">
            {data.map((d, i) => (
              <div
                key={d.month}
                role="listitem"
                aria-label={`${monthLabel(d.month)}: ${d.sent}`}
                className="relative flex h-full flex-1 items-end justify-center"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                {i === peak && hover === null && (
                  <span className="absolute text-[11px] tabular-nums text-gray-600" style={{ bottom: `calc(${(d.sent / max) * 100}% + 4px)` }}>
                    {fmt.format(d.sent)}
                  </span>
                )}
                <div
                  className={cn('w-full max-w-10 rounded-t', hover === i ? 'bg-primary-700' : 'bg-primary-600')}
                  style={{ height: `${Math.max((d.sent / max) * 100, d.sent ? 2 : 0)}%` }}
                />
                {hover === i && (
                  <div className="pointer-events-none absolute -top-2 z-10 -translate-y-full whitespace-nowrap rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs shadow-md" dir="rtl">
                    <div className="text-gray-500">{monthLabel(d.month)}</div>
                    <div className="font-semibold tabular-nums text-gray-900">{fmt.format(d.sent)} مراسلة</div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="mt-1 flex gap-0.5 text-[11px] text-gray-500" dir="ltr">
            {data.map((d) => (
              <span key={d.month} className="flex-1 truncate text-center">
                {MONTHS[Number(d.month.split('-')[1]) - 1]}
              </span>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function HealthCard() {
  const { data, isLoading } = useQuery({ queryKey: ['reports', 'health'], queryFn: reportsApi.health, refetchInterval: 60_000 });
  const labels: Record<string, string> = {
    database: 'قاعدة البيانات',
    cache: 'الذاكرة المؤقتة',
    realtime: 'الاتصال الفوري',
    blob_storage: 'تخزين المرفقات المشفرة',
    key_transparency: 'سلسلة شفافية المفاتيح',
  };
  return (
    <Card className="p-5">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900">
        <Activity className="h-4 w-4" />
        حالة الخدمات
      </h3>
      {isLoading || !data ? (
        <Spinner />
      ) : (
        <ul className="space-y-1.5 text-sm">
          {Object.entries(data.checks).map(([key, c]) => (
            <li key={key} className="flex items-center justify-between">
              <span className="text-gray-700">{labels[key] ?? key}</span>
              <span className={cn('flex items-center gap-1 text-xs', c.ok ? 'text-emerald-700' : 'text-red-700')}>
                {c.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                {c.ok ? 'سليمة' : `عطل (${c.error ?? 'غير معروف'})`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// الصفحة
// ---------------------------------------------------------------------------

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** يصدّر التقرير المعروض نفسه (نفس الوحدة والفترة) كملف Excel. */
async function downloadExcel(u: ReportUnit, from: string, to: string): Promise<void> {
  const res = await rawFetch(`/reports/export/?unit_type=${u.type}${u.id ? `&unit_id=${u.id}` : ''}&from=${from}&to=${to}`, {});
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  saveBlob(await res.blob(), `تقرير-${u.name}-${from}-${to}.xlsx`);
}

export function Reports() {
  const { data: units, isLoading: unitsLoading } = useQuery({ queryKey: ['reports', 'units'], queryFn: reportsApi.units });
  const [unitKey, setUnitKey] = useState('');
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 89 * 86400_000)));
  const [to, setTo] = useState(isoDay(new Date()));
  const [applied, setApplied] = useState<{ unit: ReportUnit; from: string; to: string } | null>(null);

  const keyOf = (u: ReportUnit) => `${u.type}:${u.id ?? ''}`;
  const selected = useMemo(() => (units ?? []).find((u) => keyOf(u) === unitKey), [units, unitKey]);
  useEffect(() => {
    if (units?.length && !unitKey) {
      setUnitKey(keyOf(units[0]));
      setApplied({ unit: units[0], from, to });
    }
  }, [units, unitKey, from, to]);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const exportExcel = async () => {
    if (!applied) return;
    setExporting(true);
    setExportError(null);
    try {
      await downloadExcel(applied.unit, applied.from, applied.to);
    } catch (err) {
      setExportError(toUserMessage(err, 'تعذر تصدير التقرير'));
    } finally {
      setExporting(false);
    }
  };

  const { data: report, isFetching, error } = useQuery({
    queryKey: ['reports', 'report', applied],
    queryFn: () => reportsApi.report(applied!.unit, applied!.from, applied!.to),
    enabled: Boolean(applied),
  });

  if (unitsLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }
  if (!units?.length) {
    return (
      <EmptyState
        icon={BarChart3}
        title="لا تملك صلاحية التقارير"
        description="التقارير الإحصائية متاحة لمن يملك صلاحية «reports.view_metadata» على وحدة تنظيمية."
        className="mx-auto mt-8 max-w-lg"
      />
    );
  }

  const c = report?.correspondence;
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">التقارير</h2>
        <p className="text-xs text-gray-500">
          أعداد وأزمنة مجمّعة لكل وحدة فقط — لا أسماء ولا عناوين ولا أطراف مراسلات ولا محتوى. الوحدات الأصغر من{' '}
          {report?.breakdown.min_group_size ?? 3} موظفين تُدمج حتى لا يُستدل على شخص بعينه. كل عرض أو تصدير لتقرير يُسجَّل في سجل التدقيق.
        </p>
      </div>
      <Card className="p-4">
        <form
          className="grid grid-cols-1 gap-3 md:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (selected) setApplied({ unit: selected, from, to });
          }}
        >
          <div className="md:col-span-2">
            <Label htmlFor="r-unit">الوحدة</Label>
            <select id="r-unit" value={unitKey} onChange={(e) => setUnitKey(e.target.value)} className="h-10 w-full rounded-lg border border-gray-300 bg-white px-2 text-sm">
              {units.map((u) => (
                <option key={keyOf(u)} value={keyOf(u)}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="r-from">من</Label>
            <Input id="r-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="r-to">إلى</Label>
            <Input id="r-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="flex items-end gap-2">
            <Button type="submit" className="flex-1" loading={isFetching}>
              عرض
            </Button>
            <Button type="button" variant="outline" onClick={() => void exportExcel()} loading={exporting} disabled={!report} title="تصدير التقرير المعروض كملف Excel">
              <Download className="h-4 w-4" />
              Excel
            </Button>
          </div>
        </form>
        {exportError && <p className="mt-2 text-sm text-red-600">{exportError}</p>}
      </Card>

      {error && <Card className="p-4 text-sm text-red-600">{toUserMessage(error, 'تعذر تحميل التقرير')}</Card>}

      {report && c && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label="مراسلات مرسلة" value={fmt.format(c.sent)} hint={`${fmt.format(c.new_threads)} جديدة · ${fmt.format(c.replies)} رد`} />
            <Tile label="معاملات مغلقة" value={fmt.format(c.closed)} />
            <Tile label="متأخرة بلا رد" value={fmt.format(c.overdue_open)} hint="تجاوزت تاريخ الاستحقاق" tone={c.overdue_open ? 'warn' : undefined} />
            <Tile label="متوسط زمن أول رد" value={hours(c.avg_first_reply_hours)} hint={`الوسيط ${hours(c.median_first_reply_hours)}`} />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <MonthlyBars data={report.monthly} />
            </div>
            <div className="space-y-4">
              <Card className="space-y-2 p-5 text-sm">
                <h3 className="font-semibold text-gray-900">الاعتماد والتعاميم</h3>
                <p className="flex justify-between"><span className="text-gray-600">طلبات اعتماد</span><span className="tabular-nums">{fmt.format(report.approvals.requests)}</span></p>
                <p className="flex justify-between"><span className="text-gray-600">قيد الاعتماد</span><span className="tabular-nums">{fmt.format(report.approvals.by_status.pending ?? 0)}</span></p>
                <p className="flex justify-between"><span className="text-gray-600">متوسط زمن القرار</span><span>{hours(report.approvals.avg_decision_hours)}</span></p>
                <p className="flex justify-between"><span className="text-gray-600">تعاميم منشورة</span><span className="tabular-nums">{fmt.format(report.announcements.published)}</span></p>
                <p className="flex justify-between"><span className="text-gray-600">نسبة الإقرار</span><span>{report.announcements.ack_rate === null ? '—' : `${Math.round(report.announcements.ack_rate * 100)}٪`}</span></p>
                <p className="flex justify-between"><span className="text-gray-600">إقرارات متأخرة</span><span className="tabular-nums">{fmt.format(report.announcements.overdue_acks)}</span></p>
              </Card>
              <Card className="space-y-2 p-5 text-sm">
                <h3 className="font-semibold text-gray-900">الاستخدام</h3>
                <p className="flex justify-between"><span className="text-gray-600">الموظفون</span><span className="tabular-nums">{fmt.format(report.usage.employees)}</span></p>
                <p className="flex justify-between"><span className="text-gray-600">نشطون آخر 30 يومًا</span><span className="tabular-nums">{fmt.format(report.usage.active_last_30_days)}</span></p>
                <p className="flex justify-between"><span className="text-gray-600">أجهزة مفعّلة التشفير</span><span className="tabular-nums">{fmt.format(report.usage.active_devices)}</span></p>
                <p className="flex justify-between"><span className="text-gray-600">رسائل الشات (عدد فقط)</span><span className="tabular-nums">{fmt.format(report.usage.chat_messages)}</span></p>
              </Card>
            </div>
          </div>

          <Card className="overflow-x-auto p-5">
            <h3 className="mb-3 text-sm font-semibold text-gray-900">حسب الوحدات الفرعية — {report.scope.name}</h3>
            {report.breakdown.rows.length === 0 && !report.breakdown.merged_small_units ? (
              <p className="text-sm text-gray-400">لا وحدات فرعية</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-xs text-gray-500">
                  <tr>
                    <th className="py-2 text-start font-medium">الوحدة</th>
                    <th className="py-2 text-end font-medium">الموظفون</th>
                    <th className="py-2 text-end font-medium">مرسلة</th>
                    <th className="py-2 text-end font-medium">مغلقة</th>
                    <th className="py-2 text-end font-medium">متأخرة</th>
                    <th className="py-2 text-end font-medium">متوسط أول رد</th>
                  </tr>
                </thead>
                <tbody>
                  {report.breakdown.rows.map((r) => (
                    <tr key={r.unit.id} className="border-t border-gray-100">
                      <td className="py-2">{r.unit.name}</td>
                      <td className="py-2 text-end tabular-nums">{fmt.format(r.employees)}</td>
                      <td className="py-2 text-end tabular-nums">{fmt.format(r.sent)}</td>
                      <td className="py-2 text-end tabular-nums">{fmt.format(r.closed)}</td>
                      <td className={cn('py-2 text-end tabular-nums', r.overdue_open && 'text-amber-700')}>{fmt.format(r.overdue_open)}</td>
                      <td className="py-2 text-end">{hours(r.avg_first_reply_hours)}</td>
                    </tr>
                  ))}
                  {report.breakdown.merged_small_units && (
                    <tr className="border-t border-gray-100 text-gray-500">
                      <td className="py-2">وحدات صغيرة مدمجة ({fmt.format(report.breakdown.merged_small_units.units)})</td>
                      <td className="py-2 text-end tabular-nums">{fmt.format(report.breakdown.merged_small_units.employees)}</td>
                      <td className="py-2 text-end tabular-nums">{fmt.format(report.breakdown.merged_small_units.sent)}</td>
                      <td className="py-2 text-end">—</td>
                      <td className="py-2 text-end tabular-nums">{fmt.format(report.breakdown.merged_small_units.overdue_open)}</td>
                      <td className="py-2 text-end">—</td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
      <HealthCard />
    </div>
  );
}

export const ReportsPages = { Reports };
