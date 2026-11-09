import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { Button, Card, Input, Label, Spinner } from '../../shared/ui';
import { ApiError, toUserMessage } from '../../shared/api';
import { RecipientPicker } from '../correspondence/components';
import { adminApi, type RoleScope } from '../admin/api';
import { Modal, useOrg } from '../admin/components';

const SELECT = 'h-10 w-full rounded-lg border border-gray-300 bg-white px-2 text-sm';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ar', { dateStyle: 'medium' }).format(new Date(iso));
}

const SCOPE_HINT: Record<RoleScope, string> = {
  institute: 'على معهد',
  branch: 'على فرع واحد',
  branches: 'على فروع يحددها المسؤول',
  central: 'مركزي — كل المجموعة',
};

function Catalog() {
  const { data, isLoading } = useQuery({ queryKey: ['roles', 'catalog'], queryFn: adminApi.roleCatalog });
  if (isLoading) return <Spinner />;
  const active = (data ?? []).filter((r) => r.assignable);
  const legacy = (data ?? []).filter((r) => !r.assignable);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {active.map((r) => (
          <Card key={r.code} className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-medium text-gray-900">{r.name_ar}</span>
              {r.scope && <span className="text-xs text-gray-500">{SCOPE_HINT[r.scope]}</span>}
            </div>
            <ul className="space-y-1 text-xs text-gray-600">
              {r.permissions.map((p) => (
                <li key={p.code}>• {p.name_ar}</li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
      {legacy.length > 0 && (
        <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
          أدوار قديمة لم تعد تُسند وما زال يحملها أحد:{' '}
          {legacy.map((r) => `${r.name_ar} (${r.holders})`).join('، ')}. اسحبها من الجدول أدناه وأسند بدلًا منها أحد الأدوار الخمسة.
        </p>
      )}
    </div>
  );
}

function AssignDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: roles } = useQuery({ queryKey: ['roles', 'catalog'], queryFn: adminApi.roleCatalog });
  const { institutes, branches } = useOrg();
  const [user, setUser] = useState<string[]>([]);
  const [role, setRole] = useState('');
  const [institute, setInstitute] = useState('');
  const [branch, setBranch] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [expires, setExpires] = useState('');
  const scope = roles?.find((r) => r.code === role)?.scope ?? null;
  const instName = useMemo(() => new Map(institutes.map((i) => [i.id, i.name])), [institutes]);
  const ready =
    !!user.length &&
    !!role &&
    (scope === 'central' || (scope === 'institute' && !!institute) || (scope === 'branch' && !!branch) || (scope === 'branches' && picked.length > 0));
  const assign = useMutation({
    mutationFn: () =>
      adminApi.assign({
        user_id: user[0],
        role_code: role,
        institute_id: scope === 'institute' ? institute : null,
        branch_id: scope === 'branch' ? branch : null,
        branch_ids: scope === 'branches' ? picked : [],
        expires_at: expires ? new Date(expires).toISOString() : null,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['roles'] });
      onClose();
    },
  });
  return (
    <Modal title="إسناد دور" onClose={onClose} wide>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); assign.mutate(); }}>
        <RecipientPicker id="as-user" label="الموظف" value={user} onChange={(ids) => setUser(ids.slice(-1))} />
        <div className="md:w-1/2">
          <Label htmlFor="as-role">الدور</Label>
          <select id="as-role" value={role} onChange={(e) => setRole(e.target.value)} className={SELECT}>
            <option value="">اختر…</option>
            {(roles ?? []).filter((r) => r.assignable).map((r) => <option key={r.code} value={r.code}>{r.name_ar}</option>)}
          </select>
        </div>
        {scope === 'central' && <p className="text-sm text-gray-600">دور مركزي: يشمل المجموعة كلها.</p>}
        {scope === 'institute' && (
          <div className="md:w-1/2">
            <Label htmlFor="as-inst">المعهد</Label>
            <select id="as-inst" value={institute} onChange={(e) => setInstitute(e.target.value)} className={SELECT}>
              <option value="">اختر…</option>
              {institutes.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </div>
        )}
        {scope === 'branch' && (
          <div className="md:w-1/2">
            <Label htmlFor="as-branch">الفرع</Label>
            <select id="as-branch" value={branch} onChange={(e) => setBranch(e.target.value)} className={SELECT}>
              <option value="">اختر…</option>
              {institutes.map((i) => (
                <optgroup key={i.id} label={i.name}>
                  {branches.filter((b) => b.institute === i.id).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
        )}
        {scope === 'branches' && (
          <fieldset>
            <legend className="mb-1 text-sm font-medium text-gray-700">فروع المدير الإقليمي ({picked.length})</legend>
            <div className="max-h-64 space-y-3 overflow-y-auto rounded-lg border border-gray-200 p-3">
              {institutes.map((i) => {
                const own = branches.filter((b) => b.institute === i.id);
                if (!own.length) return null;
                return (
                  <div key={i.id}>
                    <p className="mb-1 text-xs font-semibold text-gray-500">{instName.get(i.id)}</p>
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {own.map((b) => (
                        <label key={b.id} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="accent-primary-600"
                            checked={picked.includes(b.id)}
                            onChange={(e) => setPicked((p) => (e.target.checked ? [...p, b.id] : p.filter((x) => x !== b.id)))}
                          />
                          {b.name}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </fieldset>
        )}
        <div className="md:w-1/2">
          <Label htmlFor="as-exp">ينتهي في (اختياري)</Label>
          <Input id="as-exp" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </div>
        {assign.error && <p className="text-sm text-red-600">{toUserMessage(assign.error, 'تعذر الإسناد')}</p>}
        <div className="flex justify-end">
          <Button type="submit" loading={assign.isPending} disabled={!ready}>
            إسناد
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Assignments() {
  const qc = useQueryClient();
  const { institutes, branches, departments } = useOrg();
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ['roles', 'assignments', query],
    queryFn: () => adminApi.assignments(query || undefined),
    retry: false,
  });
  const revoke = useMutation({
    mutationFn: adminApi.revokeAssignment,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['roles'] }),
  });
  const unitName = useMemo(() => {
    const m = new Map<string, string>();
    institutes.forEach((i) => m.set(i.id, i.name));
    branches.forEach((b) => m.set(b.id, b.name));
    departments.forEach((d) => m.set(d.id, d.name));
    return (id: string | null) => (id ? m.get(id) ?? id : null);
  }, [institutes, branches, departments]);

  if (error instanceof ApiError && error.status === 403) {
    return (
      <p className="flex items-center gap-2 text-sm text-gray-500">
        <Lock className="h-4 w-4" />
        إسناد الأدوار لمسؤول النظام فقط.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setQuery(filter.trim()); }}>
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="اسم المستخدم" dir="ltr" className="w-56" aria-label="تصفية باسم المستخدم" />
          <Button type="submit" variant="outline">تصفية</Button>
        </form>
        <Button className="ms-auto" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" />
          إسناد دور
        </Button>
      </div>
      {isLoading ? (
        <Spinner />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2 text-start font-medium">المستخدم</th>
                <th className="px-4 py-2 text-start font-medium">الدور</th>
                <th className="px-4 py-2 text-start font-medium">النطاق</th>
                <th className="px-4 py-2 text-start font-medium">منذ</th>
                <th className="px-4 py-2 text-start font-medium">ينتهي</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(data ?? []).map((a) => (
                <tr key={a.id} className="border-t border-gray-100">
                  <td className="px-4 py-2">
                    {a.full_name || a.user} <span className="text-xs text-gray-400" dir="ltr">{a.user}</span>
                  </td>
                  <td className="px-4 py-2">{a.role_name}</td>
                  <td className="px-4 py-2 text-gray-700">{unitName(a.department) ?? unitName(a.branch) ?? unitName(a.institute) ?? 'مركزي'}</td>
                  <td className="px-4 py-2 text-xs text-gray-500">{formatDate(a.granted_at)}</td>
                  <td className="px-4 py-2 text-xs text-gray-500">{formatDate(a.expires_at)}</td>
                  <td className="px-4 py-2 text-end">
                    <Button variant="ghost" size="sm" onClick={() => revoke.mutate(a.id)} aria-label="سحب الدور">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {open && <AssignDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

export function Roles() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">الأدوار والصلاحيات</h2>
        <p className="mt-1 flex items-start gap-1.5 text-xs text-gray-600">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
          لا يوجد في هذا النظام أي دور أو صلاحية تمنح قراءة مراسلات الآخرين — ولا يمكن إنشاؤها. قراءة المحتوى مشتقة فقط من كونك
          طرفًا فيه (والأرشيف المركزي يرى المصنّف للأرشفة فقط، مع تسجيل كل اطلاع).
        </p>
      </div>
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-900">ما يمنحه كل دور</h3>
        <Catalog />
      </section>
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-900">الإسنادات</h3>
        <Assignments />
      </section>
    </div>
  );
}

export const RolesPages = { Roles };
