import { useQuery } from '@tanstack/react-query';
import { Label } from '../../shared/ui';
import { adminApi, type UnitChoice } from './api';

export function useOrg() {
  const institutes = useQuery({ queryKey: ['org', 'institutes'], queryFn: adminApi.institutes });
  const branches = useQuery({ queryKey: ['org', 'branches'], queryFn: adminApi.branches });
  const departments = useQuery({ queryKey: ['org', 'departments'], queryFn: adminApi.departments });
  return {
    institutes: institutes.data ?? [],
    branches: branches.data ?? [],
    departments: departments.data ?? [],
    loading: institutes.isLoading || branches.isLoading || departments.isLoading,
  };
}

const SELECT = 'h-10 w-full rounded-lg border border-gray-300 bg-white px-2 text-sm';

/** اختيار وحدة متسلسل: معهد ← فرع (اختياري) ← قسم (اختياري). */
export function UnitPicker({
  value,
  onChange,
  idPrefix,
  requireInstitute = true,
  allowCentral = false,
}: {
  value: UnitChoice | null;
  onChange: (v: UnitChoice | null) => void;
  idPrefix: string;
  requireInstitute?: boolean;
  /** يسمح بـ«مركزي» (بلا وحدة) — لإسناد الأدوار. */
  allowCentral?: boolean;
}) {
  const { institutes, branches, departments } = useOrg();
  const inst = value?.institute ?? '';
  const branch = value?.branch ?? '';
  const branchOptions = branches.filter((b) => b.institute === inst);
  const deptOptions = departments.filter((d) => d.institute === inst && (branch ? d.branch === branch : !d.branch));

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <div>
        <Label htmlFor={`${idPrefix}-inst`}>المعهد</Label>
        <select
          id={`${idPrefix}-inst`}
          className={SELECT}
          value={inst}
          onChange={(e) => onChange(e.target.value ? { institute: e.target.value, branch: null, department: null } : null)}
        >
          <option value="">{allowCentral ? 'مركزي (كل المعاهد)' : requireInstitute ? 'اختر…' : '—'}</option>
          {institutes.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} ({i.code})
            </option>
          ))}
        </select>
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-branch`}>الفرع</Label>
        <select
          id={`${idPrefix}-branch`}
          className={SELECT}
          value={branch}
          disabled={!inst}
          onChange={(e) => onChange({ institute: inst, branch: e.target.value || null, department: null })}
        >
          <option value="">— على مستوى المعهد —</option>
          {branchOptions.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} ({b.code})
            </option>
          ))}
        </select>
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-dept`}>القسم</Label>
        <select
          id={`${idPrefix}-dept`}
          className={SELECT}
          value={value?.department ?? ''}
          disabled={!inst}
          onChange={(e) => onChange({ institute: inst, branch: branch || null, department: e.target.value || null })}
        >
          <option value="">—</option>
          {deptOptions.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.code})
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`max-h-[90vh] w-full overflow-y-auto rounded-xl bg-white p-5 shadow-xl ${wide ? 'max-w-3xl' : 'max-w-lg'}`}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          <button type="button" onClick={onClose} className="text-xl leading-none text-gray-400 hover:text-gray-600" aria-label="إغلاق">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
