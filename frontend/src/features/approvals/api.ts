/** `/api/v1/approvals/*` — طلبات الاعتماد وقراراتها الموقّعة والتفويضات والمسارات. */
import { ApiError, apiFetch, rawFetch } from '../../shared/api';

export interface UserRef {
  id: string;
  full_name: string;
  username: string;
}

export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'returned' | 'completed' | 'cancelled';
export type Decision = 'approved' | 'rejected' | 'returned';

export interface DecisionRecord {
  decision: Decision;
  slot_user_id: string;
  approver: UserRef;
  delegated: boolean;
  decided_at: string;
  /** طلب بتوقيع: رمز التحقق المطبوع في مربع التوقيع، والصفحة. */
  verify_code: string | null;
  signed_page: number | null;
}

export type VerifyResult =
  | { valid: false }
  | {
      valid: true;
      code: string;
      signer: string;
      on_behalf_of: string | null;
      signed_at: string;
      page: number | null;
      request_type: string | null;
      reference_number: string | null;
      requested_by: string;
      request_status: RequestStatus;
      /** استُبدل ملف الطلب بعد هذا التوقيع (نسخة سابقة). */
      superseded: boolean;
    };

export type EventKind = Decision | 'deferred' | 'resubmitted' | 'resubmitted_file';

/** سجل الطلب: القرارات والتأجيل وإعادة الإرسال، مع الملاحظة إن وُجدت. */
export interface RequestEvent {
  kind: EventKind;
  actor: UserRef;
  on_behalf_of: UserRef | null;
  step_order: number;
  round: number;
  note: string;
  created_at: string;
}

export interface RequestStep {
  step_order: number;
  step_type: 'all' | 'any';
  status: 'waiting' | 'active' | 'approved' | 'rejected' | 'returned' | 'cancelled';
  approvers: Array<{ user: UserRef; decision: DecisionRecord | null; deferred_at: string | null }>;
}

export interface ApprovalRequest {
  id: string;
  correspondence: { id: string; reference_number: string | null };
  status: RequestStatus;
  current_step_order: number;
  requested_by: UserRef;
  content_hash: string;
  workflow_id: string | null;
  created_at: string;
  decided_at: string | null;
  completed_at: string | null;
  steps: RequestStep[];
  my_slot: { slot_user_id: string; delegated: boolean } | null;
  /** طلب بتوقيع (صرف، إجازة…): الاعتماد يختم توقيع المعتمد على الملف. */
  signable: boolean;
  workflow_name: string | null;
  title: string | null;
  source_file: FileRef | null;
  signed_file: FileRef | null;
  signature_count: number;
  /** صفحات الملف، وعدد التوقيعات على كل صفحة ({"2": 1}). */
  page_count: number | null;
  page_signatures: Record<string, number>;
  /** أماكن التوقيعات المختومة (نقاط PDF من أعلى يسار الصفحة)، ومقاس مربع التوقيع. */
  signature_boxes: Array<{ page: number; x: number; y: number; w: number; h: number }>;
  signature_box: { w: number; h: number } | null;
  /** الجولة: تزيد حين يُعاد إرسال الطلب بملف جديد (يوقّع الجميع من جديد). */
  round: number;
  events: RequestEvent[];
  /** مقدّم الطلب وطلبه معاد للمراجعة: «تعديل وإعادة إرسال». */
  can_resubmit: boolean;
}

export interface FileRef {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** محدِّد المعتمد في نوع الطلب: دور + نطاق نسبةً لمقدّم الطلب. */
export type SelectorScope = 'central' | 'sender_branch' | 'sender_institute';

export interface Delegation {
  id: string;
  delegator: UserRef;
  delegate: UserRef;
  starts_at: string;
  ends_at: string;
  revoked_at: string | null;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  version: number;
  signable?: boolean;
  steps: Array<{ step_order: number; type: 'all' | 'any'; approver_selectors: Array<Record<string, string>> }>;
}

export interface StepSpec {
  type: 'all' | 'any';
  approver_ids: string[];
}

export const approvalsApi = {
  list: (box: 'pending_mine' | 'received' | 'cancelled_mine' | 'requested_by_me') => apiFetch<ApprovalRequest[]>(`/approvals/?box=${box}`),
  forCorrespondence: (correspondenceId: string) =>
    apiFetch<ApprovalRequest[]>(`/approvals/?box=correspondence&correspondence_id=${correspondenceId}`),
  get: (id: string) => apiFetch<ApprovalRequest>(`/approvals/${id}/`),
  create: (body: { correspondence_id: string; steps?: StepSpec[]; workflow_id?: string }) =>
    apiFetch<ApprovalRequest>('/approvals/', { method: 'POST', body }),
  decide: (id: string, decision: Decision, note: string, sign?: { password: string; page: number; x?: number; y?: number }) =>
    apiFetch<ApprovalRequest>(`/approvals/${id}/decide/`, { method: 'POST', body: { decision, note, ...(sign ?? {}) } }),
  /** تأجيل: يبقى الطلب عندي وأقرر لاحقًا، ويُبلَّغ مقدّمه. */
  defer: (id: string, note: string) => apiFetch<ApprovalRequest>(`/approvals/${id}/defer/`, { method: 'POST', body: { note } }),
  /** تعديل وإعادة إرسال طلب معاد (ملف جديد اختياري للطلبات بتوقيع). */
  resubmit: (id: string, body: { note: string; file?: File | null }) => {
    const form = new FormData();
    form.append('note', body.note);
    if (body.file) form.append('file', body.file, body.file.name);
    return rawFetch(`/approvals/${id}/resubmit/`, { method: 'POST', headers: { Accept: 'application/json' }, body: form }).then(
      async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new ApiError(res.status, data);
        return data as ApprovalRequest;
      },
    );
  },
  removeApprover: (id: string, approverId: string) =>
    apiFetch<ApprovalRequest>(`/approvals/${id}/remove-approver/`, { method: 'POST', body: { approver_id: approverId } }),
  cancel: (id: string) => apiFetch<ApprovalRequest>(`/approvals/${id}/cancel/`, { method: 'POST' }),
  complete: (id: string) => apiFetch<ApprovalRequest>(`/approvals/${id}/complete/`, { method: 'POST' }),
  delegations: () => apiFetch<{ given: Delegation[]; received: Delegation[] }>('/approvals/delegations/'),
  createDelegation: (body: { delegate_id: string; starts_at: string; ends_at: string }) =>
    apiFetch<Delegation>('/approvals/delegations/', { method: 'POST', body }),
  revokeDelegation: (id: string) =>
    apiFetch<Delegation>(`/approvals/delegations/${id}/revoke/`, { method: 'POST' }),
  workflows: () => apiFetch<WorkflowTemplate[]>('/approvals/workflows/'),
  /** أنواع الطلبات بتوقيع (للمسؤول): إنشاء وإيقاف. */
  signableTypes: () => apiFetch<WorkflowTemplate[]>('/approvals/workflows/?signable=1'),
  createType: (body: {
    name: string;
    signable: true;
    steps: Array<{ type: 'all' | 'any'; approver_selectors: Array<{ role: string; scope: SelectorScope } | { user: string }> }>;
  }) => apiFetch<WorkflowTemplate>('/approvals/workflows/', { method: 'POST', body }),
  retireType: (id: string) => apiFetch<WorkflowTemplate>(`/approvals/workflows/${id}/`, { method: 'PATCH', body: { is_active: false } }),
  /** الأنواع التي يستطيع المستخدم تقديمها من «طلب جديد». */
  requestTypes: () => apiFetch<WorkflowTemplate[]>('/approvals/request-types/'),
  fileRequest: (body: { workflow_id: string; title: string; note: string; file: File }) => {
    const form = new FormData();
    form.append('workflow_id', body.workflow_id);
    form.append('title', body.title);
    form.append('note', body.note);
    form.append('file', body.file, body.file.name);
    return rawFetch('/approvals/file-request/', { method: 'POST', headers: { Accept: 'application/json' }, body: form }).then(
      async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new ApiError(res.status, data);
        return data as ApprovalRequest;
      },
    );
  },
  /** توقيعي المحفوظ (PNG base64). */
  signature: () => apiFetch<{ has_signature: boolean; image: string | null }>('/approvals/signature/'),
  saveSignature: (dataUrl: string) =>
    apiFetch<{ has_signature: boolean; image: string | null }>('/approvals/signature/', { method: 'PUT', body: { image: dataUrl } }),
  verify: (code: string) => apiFetch<VerifyResult>(`/approvals/verify/?code=${encodeURIComponent(code.trim())}`),
  deleteSignature: () => apiFetch<null>('/approvals/signature/', { method: 'DELETE' }),
};

export const ROLE_OPTIONS: Array<{ code: string; label: string }> = [
  { code: 'branch_manager', label: 'مدير الفرع' },
  { code: 'regional_manager', label: 'المدير الإقليمي' },
  { code: 'executive', label: 'المدير التنفيذي' },
  { code: 'sys_admin', label: 'مدير النظام' },
];

export const SCOPE_OPTIONS: Array<{ code: SelectorScope; label: string }> = [
  { code: 'sender_branch', label: 'في فرع مقدّم الطلب' },
  { code: 'sender_institute', label: 'في معهد مقدّم الطلب' },
  { code: 'central', label: 'على مستوى النظام كله' },
];

export const STATUS_LABELS: Record<RequestStatus, string> = {
  pending: 'قيد الاعتماد',
  approved: 'معتمد',
  rejected: 'مرفوض',
  returned: 'معاد للمراجعة',
  completed: 'مكتمل',
  cancelled: 'ملغى',
};

export const DECISION_LABELS: Record<Decision, string> = {
  approved: 'اعتماد',
  rejected: 'رفض',
  returned: 'إعادة للمراجعة',
};

export const EVENT_LABELS: Record<EventKind, string> = {
  approved: 'اعتمد',
  rejected: 'رفض',
  returned: 'أعاده للمراجعة',
  deferred: 'أجّل البتّ',
  resubmitted: 'أعاد إرساله',
  resubmitted_file: 'أعاد إرساله بملف جديد',
};
