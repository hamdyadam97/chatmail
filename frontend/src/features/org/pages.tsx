import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, FolderTree, Network, Pencil, Plus } from 'lucide-react';
import { Button, Card, EmptyState, Input, Label, Spinner } from '../../shared/ui';
import { toUserMessage } from '../../shared/api';
import { cn } from '../../shared/lib/cn';
import { adminApi, type Branch, type Department } from '../admin/api';
import { Modal, useOrg } from '../admin/components';

const SELECT = 'h-10 w-full rounded-lg border border-gray-300 bg-white px-2 text-sm';

function useRefreshOrg() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['org'] });
}

function Header({ title, onAdd, addLabel, note }: { title: string; onAdd: () => void; addLabel: string; note: string }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
        <p className="text-xs text-gray-500">{note}</p>
      </div>
      <Button onClick={onAdd}>
        <Plus className="h-4 w-4" />
        {addLabel}
      </Button>
    </div>
  );
}

function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="text-sm text-red-600">{toUserMessage(error, 'تعذرت العملية — تحقق من صلاحيتك على هذه الوحدة')}</p>;
}

// ---------------------------------------------------------------------------

export function Institutes() {
  const { institutes, branches, loading } = useOrg();
  const refresh = useRefreshOrg();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const create = useMutation({
    mutationFn: () => adminApi.createInstitute({ name: name.trim(), code: code.trim().toUpperCase() }),
    onSuccess: () => {
      setOpen(false);
      setName('');
      setCode('');
      void refresh();
    },
  });
  return (
    <div className="space-y-4">
      <Header
        title="المعاهد"
        addLabel="معهد جديد"
        onAdd={() => setOpen(true)}
        note="رمز المعهد يدخل في الأرقام المرجعية للمراسلات والتعاميم (مثل AHL-RYD-2026-000001). إضافة معهد صلاحية مركزية."
      />
      {loading ? (
        <Spinner />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {institutes.map((i) => (
            <Card key={i.id} className="p-4">
              <div className="flex items-center gap-2">
                <Building2 className="h-5 w-5 text-gray-400" />
                <span className="font-medium text-gray-900">{i.name}</span>
                <span className="ms-auto font-mono text-xs text-gray-500" dir="ltr">
                  {i.code}
                </span>
              </div>
              <p className="mt-2 text-xs text-gray-500">{branches.filter((b) => b.institute === i.id).length} فروع</p>
            </Card>
          ))}
        </div>
      )}
      {open && (
        <Modal title="معهد جديد" onClose={() => setOpen(false)}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <div>
              <Label htmlFor="i-name">الاسم</Label>
              <Input id="i-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="i-code">الرمز (لاتيني، يظهر في الأرقام المرجعية)</Label>
              <Input id="i-code" dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} maxLength={32} />
            </div>
            <FormError error={create.error} />
            <div className="flex justify-end">
              <Button type="submit" loading={create.isPending} disabled={!name.trim() || !code.trim()}>
                إضافة
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function BranchForm({ branch, onClose }: { branch?: Branch; onClose: () => void }) {
  const { institutes } = useOrg();
  const refresh = useRefreshOrg();
  const [institute, setInstitute] = useState(branch?.institute ?? '');
  const [name, setName] = useState(branch?.name ?? '');
  const [code, setCode] = useState(branch?.code ?? '');
  const [city, setCity] = useState(branch?.city ?? '');
  const [active, setActive] = useState(branch?.is_active ?? true);
  const save = useMutation({
    mutationFn: () =>
      branch
        ? adminApi.updateBranch(branch.id, { name: name.trim(), city: city.trim(), is_active: active })
        : adminApi.createBranch({ institute, name: name.trim(), code: code.trim().toUpperCase(), city: city.trim() }),
    onSuccess: () => {
      void refresh();
      onClose();
    },
  });
  return (
    <Modal title={branch ? `تعديل ${branch.name}` : 'فرع جديد'} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        {!branch && (
          <div>
            <Label htmlFor="b-inst">المعهد</Label>
            <select id="b-inst" className={SELECT} value={institute} onChange={(e) => setInstitute(e.target.value)}>
              <option value="">اختر…</option>
              {institutes.map((i) => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
          </div>
        )}
        <div>
          <Label htmlFor="b-name">الاسم</Label>
          <Input id="b-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {!branch && (
          <div>
            <Label htmlFor="b-code">الرمز (يظهر في الأرقام المرجعية)</Label>
            <Input id="b-code" dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} maxLength={32} />
          </div>
        )}
        <div>
          <Label htmlFor="b-city">المدينة</Label>
          <Input id="b-city" value={city} onChange={(e) => setCity(e.target.value)} />
        </div>
        {branch && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="accent-primary-600" />
            فرع نشط
          </label>
        )}
        <FormError error={save.error} />
        <div className="flex justify-end">
          <Button type="submit" loading={save.isPending} disabled={!name.trim() || (!branch && (!institute || !code.trim()))}>
            حفظ
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function Branches() {
  const { institutes, branches, departments, loading } = useOrg();
  const [editing, setEditing] = useState<Branch | 'new' | null>(null);
  return (
    <div className="space-y-4">
      <Header title="الفروع" addLabel="فرع جديد" onAdd={() => setEditing('new')} note="إضافة فرع أو تعديله تتطلب صلاحية إدارة الهيكل في المعهد أو الفرع." />
      {loading ? (
        <Spinner />
      ) : branches.length === 0 ? (
        <EmptyState icon={Network} title="لا فروع" />
      ) : (
        institutes.map((i) => {
          const list = branches.filter((b) => b.institute === i.id);
          if (list.length === 0) return null;
          return (
            <Card key={i.id} className="overflow-hidden">
              <div className="border-b border-gray-100 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-700">{i.name}</div>
              {list.map((b) => (
                <div key={b.id} className={cn('flex items-center gap-3 border-b border-gray-100 px-4 py-2.5 text-sm last:border-0', !b.is_active && 'text-gray-400')}>
                  <span className="font-medium">{b.name}</span>
                  <span className="font-mono text-xs text-gray-500" dir="ltr">{b.code}</span>
                  <span className="text-xs text-gray-500">{b.city}</span>
                  <span className="text-xs text-gray-400">{departments.filter((d) => d.branch === b.id).length} أقسام</span>
                  {!b.is_active && <span className="text-xs">غير نشط</span>}
                  <Button variant="ghost" size="sm" className="ms-auto" onClick={() => setEditing(b)} aria-label={`تعديل ${b.name}`}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </Card>
          );
        })
      )}
      {editing && <BranchForm branch={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function DepartmentForm({ department, onClose }: { department?: Department; onClose: () => void }) {
  const { institutes, branches, departments } = useOrg();
  const refresh = useRefreshOrg();
  const [institute, setInstitute] = useState(department?.institute ?? '');
  const [branch, setBranch] = useState(department?.branch ?? '');
  const [parent, setParent] = useState(department?.parent ?? '');
  const [name, setName] = useState(department?.name ?? '');
  const [code, setCode] = useState(department?.code ?? '');
  const save = useMutation({
    mutationFn: () =>
      department
        ? adminApi.updateDepartment(department.id, { name: name.trim() })
        : adminApi.createDepartment({ institute, branch: branch || null, parent: parent || null, name: name.trim(), code: code.trim().toUpperCase() }),
    onSuccess: () => {
      void refresh();
      onClose();
    },
  });
  const parents = departments.filter((d) => d.institute === institute && (branch ? d.branch === branch : !d.branch));
  return (
    <Modal title={department ? `تعديل ${department.name}` : 'قسم جديد'} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        {!department && (
          <>
            <div>
              <Label htmlFor="d-inst">المعهد</Label>
              <select id="d-inst" className={SELECT} value={institute} onChange={(e) => { setInstitute(e.target.value); setBranch(''); setParent(''); }}>
                <option value="">اختر…</option>
                {institutes.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </div>
            <div>
              <Label htmlFor="d-branch">الفرع</Label>
              <select id="d-branch" className={SELECT} value={branch} disabled={!institute} onChange={(e) => { setBranch(e.target.value); setParent(''); }}>
                <option value="">— على مستوى المعهد —</option>
                {branches.filter((b) => b.institute === institute).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div>
              <Label htmlFor="d-parent">قسم أب (اختياري)</Label>
              <select id="d-parent" className={SELECT} value={parent} disabled={!institute} onChange={(e) => setParent(e.target.value)}>
                <option value="">—</option>
                {parents.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
          </>
        )}
        <div>
          <Label htmlFor="d-name">الاسم</Label>
          <Input id="d-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {!department && (
          <div>
            <Label htmlFor="d-code">الرمز</Label>
            <Input id="d-code" dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} maxLength={32} />
          </div>
        )}
        <FormError error={save.error} />
        <div className="flex justify-end">
          <Button type="submit" loading={save.isPending} disabled={!name.trim() || (!department && (!institute || !code.trim()))}>
            حفظ
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DepartmentTree({ items, parent, depth, onEdit }: { items: Department[]; parent: string | null; depth: number; onEdit: (d: Department) => void }) {
  // الجذور: بلا أب، أو أبوها خارج هذا النطاق (لا يختفي قسم من العرض).
  const children = items.filter((d) =>
    parent === null ? !d.parent || !items.some((x) => x.id === d.parent) : d.parent === parent,
  );
  return (
    <>
      {children.map((d) => (
        <div key={d.id}>
          <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-2 text-sm" style={{ paddingInlineStart: `${1 + depth * 1.5}rem` }}>
            <FolderTree className="h-4 w-4 text-gray-400" />
            <span>{d.name}</span>
            <span className="font-mono text-xs text-gray-500" dir="ltr">{d.code}</span>
            <Button variant="ghost" size="sm" className="ms-auto" onClick={() => onEdit(d)} aria-label={`تعديل ${d.name}`}>
              <Pencil className="h-4 w-4" />
            </Button>
          </div>
          <DepartmentTree items={items} parent={d.id} depth={depth + 1} onEdit={onEdit} />
        </div>
      ))}
    </>
  );
}

export function Departments() {
  const { institutes, branches, departments, loading } = useOrg();
  const [editing, setEditing] = useState<Department | 'new' | null>(null);
  return (
    <div className="space-y-4">
      <Header title="الأقسام" addLabel="قسم جديد" onAdd={() => setEditing('new')} note="الأقسام شجرية، على مستوى المعهد أو داخل فرع." />
      {loading ? (
        <Spinner />
      ) : departments.length === 0 ? (
        <EmptyState icon={FolderTree} title="لا أقسام" />
      ) : (
        institutes.map((i) => {
          const scopes: Array<{ key: string; label: string; items: Department[] }> = [
            { key: `${i.id}:inst`, label: `${i.name} — على مستوى المعهد`, items: departments.filter((d) => d.institute === i.id && !d.branch) },
            ...branches
              .filter((b) => b.institute === i.id)
              .map((b) => ({ key: b.id, label: `${i.name} — ${b.name}`, items: departments.filter((d) => d.branch === b.id) })),
          ].filter((s) => s.items.length > 0);
          return scopes.map((s) => (
            <Card key={s.key} className="overflow-hidden">
              <div className="border-b border-gray-100 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-700">{s.label}</div>
              <DepartmentTree items={s.items} parent={null} depth={0} onEdit={setEditing} />
            </Card>
          ));
        })
      )}
      {editing && <DepartmentForm department={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

export const OrgPages = { Institutes, Branches, Departments };
