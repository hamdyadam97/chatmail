import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileSignature, Plus, Trash2 } from 'lucide-react';
import { Button, Card, EmptyState, Input, Label, Spinner } from '../../shared/ui';
import { toUserMessage } from '../../shared/api';
import { RecipientPicker } from '../correspondence/components';
import { approvalsApi, ROLE_OPTIONS, SCOPE_OPTIONS, type SelectorScope, type WorkflowTemplate } from './api';

/** role = USER_PICK: موظف محدد بالاسم بدل الدور. */
const USER_PICK = '__user';

interface DraftStep {
  role: string;
  scope: SelectorScope;
  userIds: string[];
}

const NEW_STEP = (role = 'branch_manager', scope: SelectorScope = 'sender_branch'): DraftStep => ({ role, scope, userIds: [] });

const roleLabel = (code: string) => ROLE_OPTIONS.find((r) => r.code === code)?.label ?? code;
const scopeLabel = (code: string) => SCOPE_OPTIONS.find((s) => s.code === code)?.label ?? code;

function describe(t: WorkflowTemplate): string {
  return t.steps
    .map((s) => s.approver_selectors.map((sel) => (sel.role ? roleLabel(sel.role) : sel.name ?? 'موظف محدد')).join(' أو '))
    .join(' ← ');
}

/** أنواع الطلبات بتوقيع (صرف، إجازة…): يحدد المسؤول مرة واحدة من يوقّع كل نوع وبأي ترتيب. */
export function RequestTypesPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['approvals', 'signable-types'], queryFn: approvalsApi.signableTypes });
  const [name, setName] = useState('');
  const [steps, setSteps] = useState<DraftStep[]>([NEW_STEP()]);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['approvals', 'signable-types'] });
    void queryClient.invalidateQueries({ queryKey: ['approvals', 'request-types'] });
  };
  const create = useMutation({
    mutationFn: () =>
      approvalsApi.createType({
        name: name.trim(),
        signable: true,
        steps: steps.map((s) => ({
          type: 'any' as const,
          approver_selectors: s.role === USER_PICK ? s.userIds.map((id) => ({ user: id })) : [{ role: s.role, scope: s.scope }],
        })),
      }),
    onSuccess: () => {
      setName('');
      setSteps([NEW_STEP()]);
      setError(null);
      refresh();
    },
    onError: (err) => setError(toUserMessage(err, 'تعذر الحفظ')),
  });
  const retire = useMutation({ mutationFn: approvalsApi.retireType, onSuccess: refresh });
  const setStep = (i: number, patch: Partial<DraftStep>) => setSteps((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">أنواع الطلبات بتوقيع</h2>
        <p className="text-sm text-gray-500">
          مثل طلب الصرف أو الإجازة: الموظف يرفع ملف الطلب من «الموافقات ← طلب جديد»، ويمر على المعتمدين بالترتيب، وكل
          معتمد يوقّع على الملف.
        </p>
      </div>

      <Card className="space-y-3 p-5" data-testid="new-request-type">
        <h3 className="text-sm font-semibold text-gray-900">نوع جديد</h3>
        <div className="md:w-1/2">
          <Label htmlFor="rt-name">اسم النوع</Label>
          <Input id="rt-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="طلب صرف" />
        </div>
        <div className="space-y-2">
          {steps.map((s, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2 rounded-lg bg-gray-50 p-3">
              <span className="w-20 pb-2 text-sm font-medium text-gray-700">التوقيع {i + 1}</span>
              <div>
                <Label htmlFor={`rt-role-${i}`}>من يوقّع</Label>
                <select id={`rt-role-${i}`} value={s.role} onChange={(e) => setStep(i, { role: e.target.value })} className="h-10 rounded-lg border border-gray-300 bg-white px-2 text-sm">
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.label}
                    </option>
                  ))}
                  <option value={USER_PICK}>موظف محدد…</option>
                </select>
              </div>
              {s.role === USER_PICK ? (
                <div className="min-w-[16rem] flex-1">
                  <RecipientPicker
                    id={`rt-user-${i}`}
                    label="الموظف"
                    value={s.userIds}
                    onChange={(ids) => setStep(i, { userIds: ids.slice(-1) })}
                  />
                </div>
              ) : (
              <div>
                <Label htmlFor={`rt-scope-${i}`}>النطاق</Label>
                <select id={`rt-scope-${i}`} value={s.scope} onChange={(e) => setStep(i, { scope: e.target.value as SelectorScope })} className="h-10 rounded-lg border border-gray-300 bg-white px-2 text-sm">
                  {SCOPE_OPTIONS.map((o) => (
                    <option key={o.code} value={o.code}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              )}
              {steps.length > 1 && (
                <Button size="sm" variant="ghost" aria-label="حذف الخطوة" onClick={() => setSteps((all) => all.filter((_, j) => j !== i))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
          {steps.length < 5 && (
            <Button size="sm" variant="outline" onClick={() => setSteps((all) => [...all, NEW_STEP('executive', 'central')])}>
              <Plus className="h-4 w-4" />
              إضافة توقيع
            </Button>
          )}
        </div>
        <p className="text-xs text-gray-500">
          المدير التنفيذي ومدير النظام دورهما على مستوى النظام كله؛ مدير الفرع والإقليمي «في فرع مقدّم الطلب». الدور يرسل
          الطلب لكل من يحمله؛ لشخص واحد بعينه اختر «موظف محدد».
        </p>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={!name.trim() || steps.some((s) => s.role === USER_PICK && s.userIds.length === 0)}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            حفظ النوع
          </Button>
        </div>
      </Card>

      {isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : !data?.length ? (
        <EmptyState icon={FileSignature} title="لا أنواع بعد" description="أضف نوعًا مثل «طلب صرف» أو «طلب إجازة»." />
      ) : (
        <Card className="divide-y divide-gray-100">
          {data.map((t) => (
            <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm" data-testid="request-type-row">
              <span>
                <span className="font-medium text-gray-900">{t.name}</span>
                <span className="ms-2 text-gray-500">{describe(t)}</span>
                <span className="ms-2 text-xs text-gray-400">
                  ({t.steps.map((s) => (s.approver_selectors[0]?.scope ? scopeLabel(s.approver_selectors[0].scope) : 'بالاسم')).join('، ')})
                </span>
              </span>
              <Button size="sm" variant="ghost" loading={retire.isPending && retire.variables === t.id} onClick={() => retire.mutate(t.id)}>
                إيقاف
              </Button>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
