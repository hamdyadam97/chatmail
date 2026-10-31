import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleDashed, Plus, Trash2, XCircle } from 'lucide-react';
import { Button, Card, Label } from '../../shared/ui';
import { cn } from '../../shared/lib/cn';
import { toUserMessage } from '../../shared/api';
import type { CorrespondenceDetail } from '../correspondence/api';
import {
  approvalsApi,
  DECISION_LABELS,
  STATUS_LABELS,
  type ApprovalRequest,
  type RequestStatus,
  type StepSpec,
} from './api';

const STATUS_STYLES: Record<RequestStatus, string> = {
  pending: 'bg-amber-50 text-amber-700',
  approved: 'bg-emerald-50 text-emerald-700',
  completed: 'bg-emerald-100 text-emerald-800',
  rejected: 'bg-red-50 text-red-700',
  returned: 'bg-orange-50 text-orange-700',
  cancelled: 'bg-gray-100 text-gray-600',
};

export function StatusBadge({ status }: { status: RequestStatus }) {
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_STYLES[status])}>
      {STATUS_LABELS[status]}
    </span>
  );
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

/** الخطوات والقرارات. */
export function StepsView({ request }: { request: ApprovalRequest }) {
  return (
    <ol className="space-y-3">
      {request.steps.map((step) => (
        <li
          key={step.step_order}
          className={cn(
            'rounded-lg border p-3',
            step.status === 'active' ? 'border-amber-300 bg-amber-50/40' : 'border-gray-200',
          )}
        >
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium text-gray-900">
              الخطوة {step.step_order} — {step.step_type === 'all' ? 'يلزم اعتماد الجميع' : 'يكفي معتمد واحد'}
            </span>
            <span className="text-xs text-gray-500">
              {{ waiting: 'بالانتظار', active: 'جارية', approved: 'معتمدة', rejected: 'مرفوضة', returned: 'معادة', cancelled: 'ملغاة' }[step.status]}
            </span>
          </div>
          <ul className="space-y-1.5">
            {step.approvers.map(({ user, decision }) => (
              <li key={user.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-1.5">
                  {decision?.decision === 'approved' ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  ) : decision ? (
                    <XCircle className="h-4 w-4 text-red-600" />
                  ) : (
                    <CircleDashed className="h-4 w-4 text-gray-400" />
                  )}
                  {user.full_name}
                </span>
                {decision ? (
                  <span className="flex flex-wrap items-center gap-3">
                    <span className="text-xs text-gray-600">
                      {DECISION_LABELS[decision.decision]}
                      {decision.delegated && ` — بالتفويض عبر ${decision.approver.full_name}`} · {formatDate(decision.decided_at)}
                    </span>
                  </span>
                ) : (
                  <span className="text-xs text-gray-400">لم يُتخذ قرار</span>
                )}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

/** لوحة الاعتماد داخل صفحة المراسلة: الطلبات القائمة + إنشاء طلب (للمرسل). */
export function ApprovalPanel({ detail, isSender }: { detail: CorrespondenceDetail; isSender: boolean }) {
  const queryClient = useQueryClient();
  const { data: requests } = useQuery({
    queryKey: ['approvals', 'correspondence', detail.id],
    queryFn: () => approvalsApi.forCorrespondence(detail.id),
    enabled: detail.status !== 'draft',
  });
  const [building, setBuilding] = useState(false);
  const hasPending = (requests ?? []).some((r) => r.status === 'pending');
  if (detail.status === 'draft') return null;
  if (!isSender && (requests ?? []).length === 0) return null;

  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">الاعتماد</h3>
        {isSender && !hasPending && detail.status === 'sent' && !building && (
          <Button variant="outline" size="sm" onClick={() => setBuilding(true)}>
            <Plus className="h-4 w-4" />
            طلب اعتماد
          </Button>
        )}
      </div>
      {(requests ?? []).map((r) => (
        <Link
          key={r.id}
          to={`/approvals/${r.id}`}
          className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 text-sm hover:bg-gray-50"
        >
          <span>
            طلب بتاريخ {formatDate(r.created_at)} — الخطوة {r.current_step_order} من {r.steps.length}
          </span>
          <span className="flex items-center gap-2">
            {r.my_slot && <span className="text-xs font-medium text-amber-700">بانتظار قرارك</span>}
            <StatusBadge status={r.status} />
          </span>
        </Link>
      ))}
      {building && (
        <RequestBuilder
          detail={detail}
          onCancel={() => setBuilding(false)}
          onCreated={() => {
            setBuilding(false);
            void queryClient.invalidateQueries({ queryKey: ['approvals'] });
          }}
        />
      )}
    </Card>
  );
}

function RequestBuilder({
  detail,
  onCancel,
  onCreated,
}: {
  detail: CorrespondenceDetail;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const participants = detail.participants.filter((p) => p.kind === 'to' || p.kind === 'cc');
  const [mode, setMode] = useState<'steps' | 'workflow'>('steps');
  const [steps, setSteps] = useState<StepSpec[]>([{ type: 'all', approver_ids: [] }]);
  const [workflowId, setWorkflowId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { data: workflows } = useQuery({ queryKey: ['approval-workflows'], queryFn: approvalsApi.workflows });
  const nameOf = (id: string) => participants.find((p) => p.user.id === id)?.user.full_name ?? id;

  const create = useMutation({
    mutationFn: () =>
      approvalsApi.create(
        mode === 'workflow'
          ? { correspondence_id: detail.id, workflow_id: workflowId }
          : { correspondence_id: detail.id, steps: steps.filter((s) => s.approver_ids.length > 0) },
      ),
    onSuccess: onCreated,
    onError: (err) => {
      const data = (err as { data?: { not_participants?: string[] } }).data;
      setError(
        data?.not_participants?.length
          ? `هؤلاء ليسوا مستلمين للمراسلة فلا يستطيعون الاطلاع عليها: ${data.not_participants.map(nameOf).join('، ')}. أرسل لهم المراسلة (أو أحِلها) أولًا.`
          : toUserMessage(err, 'تعذر إنشاء طلب الاعتماد'),
      );
    },
  });

  const toggle = (index: number, userId: string) =>
    setSteps((prev) =>
      prev.map((s, i) =>
        i !== index
          ? s
          : {
              ...s,
              approver_ids: s.approver_ids.includes(userId)
                ? s.approver_ids.filter((x) => x !== userId)
                : [...s.approver_ids, userId],
            },
      ),
    );

  return (
    <div className="space-y-3 rounded-lg border border-gray-200 p-4">
      <p className="text-xs text-gray-500">
        المعتمدون يجب أن يكونوا من مستلمي المراسلة (إلى/نسخة): يطّلعون على المحتوى المشفّر عبر خيطها، ولا يمنح طلب
        الاعتماد أي أحد صلاحية قراءة إضافية.
      </p>
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={mode === 'steps'} onChange={() => setMode('steps')} className="accent-primary-600" />
          خطوات يدوية
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            checked={mode === 'workflow'}
            onChange={() => setMode('workflow')}
            className="accent-primary-600"
            disabled={!workflows?.length}
          />
          مسار معرّف {workflows && workflows.length === 0 && '(لا توجد مسارات)'}
        </label>
      </div>

      {mode === 'workflow' ? (
        <div>
          <Label htmlFor="wf">المسار</Label>
          <select
            id="wf"
            value={workflowId}
            onChange={(e) => setWorkflowId(e.target.value)}
            className="h-10 w-full rounded-lg border border-gray-300 bg-white px-2 text-sm"
          >
            <option value="">اختر مسارًا</option>
            {(workflows ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.steps.length} خطوات)
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="space-y-3">
          {steps.map((step, i) => (
            <div key={i} className="rounded-lg bg-gray-50 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium">الخطوة {i + 1}</span>
                <span className="flex items-center gap-2">
                  <select
                    value={step.type}
                    onChange={(e) =>
                      setSteps((prev) => prev.map((s, j) => (j === i ? { ...s, type: e.target.value as 'all' | 'any' } : s)))
                    }
                    className="h-8 rounded-lg border border-gray-300 bg-white px-2 text-xs"
                    aria-label="نوع الخطوة"
                  >
                    <option value="all">يلزم اعتماد الجميع</option>
                    <option value="any">يكفي معتمد واحد</option>
                  </select>
                  {steps.length > 1 && (
                    <button
                      type="button"
                      aria-label="حذف الخطوة"
                      onClick={() => setSteps((prev) => prev.filter((_, j) => j !== i))}
                      className="text-gray-400 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </span>
              </div>
              <div className="flex flex-wrap gap-3">
                {participants.map((p) => (
                  <label key={p.user.id} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={step.approver_ids.includes(p.user.id)}
                      onChange={() => toggle(i, p.user.id)}
                      className="accent-primary-600"
                    />
                    {p.user.full_name}
                  </label>
                ))}
              </div>
            </div>
          ))}
          {steps.length < 10 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSteps((prev) => [...prev, { type: 'all', approver_ids: [] }])}
            >
              <Plus className="h-4 w-4" />
              إضافة خطوة لاحقة
            </Button>
          )}
        </div>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          إلغاء
        </Button>
        <Button
          size="sm"
          loading={create.isPending}
          disabled={mode === 'workflow' ? !workflowId : !steps.some((s) => s.approver_ids.length > 0)}
          onClick={() => {
            setError(null);
            create.mutate();
          }}
        >
          إرسال طلب الاعتماد
        </Button>
      </div>
    </div>
  );
}
