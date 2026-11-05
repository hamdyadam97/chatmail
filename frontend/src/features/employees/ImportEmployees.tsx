import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Download, FileSpreadsheet } from 'lucide-react';
import { Button, Label } from '../../shared/ui';
import { ApiError, toUserMessage } from '../../shared/api';
import { saveBlob } from '../../shared/lib/download';
import { cn } from '../../shared/lib/cn';
import { adminApi, type ImportResult, type ImportRow } from '../admin/api';
import { Modal } from '../admin/components';

/** نص الخلية في CSV: بين علامتي تنصيص، ومنع حقن الصيغ في Excel. */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

function downloadResult(result: ImportResult): void {
  const header = ['الاسم', 'اسم المستخدم', 'كلمة المرور المؤقتة', 'الفرع', 'الحالة'];
  const lines = result.rows.map((r) =>
    [r.name, r.username, r.temp_password ?? (r.created ? result.shared_temp_password ?? '' : ''), r.branch_matched ?? r.branch, r.status]
      .map(csvCell)
      .join(','),
  );
  const csv = '﻿' + [header.map(csvCell).join(','), ...lines].join('\r\n');
  saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'نتيجة-استيراد-الموظفين.csv');
}

function tone(r: ImportRow, applied: boolean): string {
  if (applied ? r.created : r.will_create) return 'bg-green-50 text-green-800';
  if (r.status === 'موجود مسبقًا') return 'bg-gray-100 text-gray-600';
  return 'bg-amber-50 text-amber-800';
}

export function ImportEmployees({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [createBranches, setCreateBranches] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: (apply: boolean) => {
      if (!file) throw new Error('اختر ملف Excel');
      return adminApi.importEmployees(file, { apply, createBranches });
    },
    onSuccess: (r) => {
      setResult(r);
      if (r.applied) onDone();
    },
    onError: (err) => setError(err instanceof ApiError ? toUserMessage(err, 'تعذر قراءة الملف') : (err as Error).message),
  });
  const template = useMutation({
    mutationFn: adminApi.importTemplate,
    onSuccess: (blob) => saveBlob(blob, 'نموذج-الموظفين.xlsx'),
  });

  const toCreate = result ? result.rows.filter((r) => r.will_create).length : 0;
  const hasRandom = !!result?.rows.some((r) => r.temp_password);

  return (
    <Modal title="استيراد موظفين من Excel" onClose={onClose} wide>
      <div className="space-y-4">
        {!result?.applied && (
          <>
            <div className="space-y-2 rounded-lg bg-gray-50 p-3 text-sm text-gray-700">
              <p>
                الصف الأول عناوين الأعمدة: <b>الاسم</b>، و<b>اسم المستخدم</b> (أو <b>البريد الإلكتروني</b> ويؤخذ ما قبل @)، واختياريًا{' '}
                <b>الفرع</b> و<b>المعهد</b> و<b>ملاحظة</b>. لن يُنشأ شيء قبل أن تراجع المعاينة وتؤكد.
              </p>
              <Button size="sm" variant="outline" loading={template.isPending} onClick={() => template.mutate()}>
                <Download className="h-4 w-4" />
                تنزيل نموذج فارغ
              </Button>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <Label htmlFor="imp-file">ملف Excel</Label>
                <input
                  id="imp-file"
                  type="file"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    setResult(null);
                    setError(null);
                  }}
                  className="block text-sm"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-primary-600"
                  checked={createBranches}
                  onChange={(e) => {
                    setCreateBranches(e.target.checked);
                    setResult(null);
                  }}
                />
                أنشئ الفروع غير الموجودة
              </label>
              <Button variant="outline" disabled={!file} loading={run.isPending && !result} onClick={() => (setError(null), run.mutate(false))}>
                <FileSpreadsheet className="h-4 w-4" />
                معاينة
              </Button>
            </div>
          </>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        {result && (
          <div className="space-y-3">
            {result.applied ? (
              <p className="text-sm font-medium text-green-800">أُنشئ {result.created} حساب.</p>
            ) : (
              <p className="text-sm text-gray-700">
                سيُنشأ <b>{toCreate}</b> حساب من {result.rows.length} صف. الصفوف الأخرى لن تُستورد، والسبب أمام كل منها.
              </p>
            )}
            {result.new_branches.length > 0 && (
              <p className="text-sm text-gray-700">
                {result.applied ? 'أُنشئت الفروع: ' : 'ستُنشأ الفروع: '}
                {result.new_branches.join('، ')}
              </p>
            )}
            {result.applied && result.shared_temp_password && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                كلمة المرور المؤقتة للحسابات الجديدة: <code dir="ltr" className="font-mono">{result.shared_temp_password}</code> — يُطلب من كل
                موظف تغييرها عند أول دخول.
              </p>
            )}
            {result.applied && hasRandom && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                بعض الحسابات أخذت كلمة مؤقتة خاصة (تظهر في الجدول الآن فقط). نزّل النتيجة، وسلّم كل موظف كلمته وحده، ثم احذف الملف.
              </p>
            )}
            <div className="max-h-80 overflow-auto rounded-lg border border-gray-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-gray-50 text-gray-600">
                  <tr>
                    <th className="p-2 text-start font-medium">الاسم</th>
                    <th className="p-2 text-start font-medium">اسم المستخدم</th>
                    <th className="p-2 text-start font-medium">الفرع</th>
                    <th className="p-2 text-start font-medium">الحالة</th>
                    {hasRandom && <th className="p-2 text-start font-medium">كلمة المرور</th>}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r, i) => (
                    <tr key={i} className="border-t border-gray-100">
                      <td className="p-2">{r.name || '—'}</td>
                      <td className="p-2 font-mono" dir="ltr">
                        {r.username || '—'}
                      </td>
                      <td className="p-2">{r.branch_matched ?? (r.branch || 'بلا فرع')}</td>
                      <td className="p-2">
                        <span className={cn('rounded px-1.5 py-0.5 text-xs', tone(r, result.applied))}>{r.status}</span>
                      </td>
                      {hasRandom && (
                        <td className="p-2 font-mono" dir="ltr">
                          {r.temp_password ?? ''}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              {result.applied ? (
                <>
                  <Button variant="outline" onClick={() => downloadResult(result)}>
                    <Download className="h-4 w-4" />
                    تنزيل النتيجة
                  </Button>
                  <Button onClick={onClose}>تم</Button>
                </>
              ) : (
                <>
                  <Button variant="outline" onClick={onClose}>
                    إلغاء
                  </Button>
                  <Button disabled={toCreate === 0} loading={run.isPending} onClick={() => run.mutate(true)}>
                    إنشاء {toCreate} حساب
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
