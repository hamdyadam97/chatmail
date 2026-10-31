/** `/api/v1/approvals/*` — طلبات الاعتماد وقراراتها الموقّعة والتفويضات والمسارات. */
import { apiFetch } from '../../shared/api';

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
}

export interface RequestStep {
  step_order: number;
  step_type: 'all' | 'any';
  status: 'waiting' | 'active' | 'approved' | 'rejected' | 'returned' | 'cancelled';
  approvers: Array<{ user: UserRef; decision: DecisionRecord | null }>;
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
}

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
  steps: Array<{ step_order: number; type: 'all' | 'any'; approver_selectors: Array<Record<string, string>> }>;
}

export interface StepSpec {
  type: 'all' | 'any';
  approver_ids: string[];
}

export const approvalsApi = {
  list: (box: 'pending_mine' | 'requested_by_me') => apiFetch<ApprovalRequest[]>(`/approvals/?box=${box}`),
  forCorrespondence: (correspondenceId: string) =>
    apiFetch<ApprovalRequest[]>(`/approvals/?box=correspondence&correspondence_id=${correspondenceId}`),
  get: (id: string) => apiFetch<ApprovalRequest>(`/approvals/${id}/`),
  create: (body: { correspondence_id: string; steps?: StepSpec[]; workflow_id?: string }) =>
    apiFetch<ApprovalRequest>('/approvals/', { method: 'POST', body }),
  decide: (id: string, decision: Decision) =>
    apiFetch<ApprovalRequest>(`/approvals/${id}/decide/`, { method: 'POST', body: { decision } }),
  cancel: (id: string) => apiFetch<ApprovalRequest>(`/approvals/${id}/cancel/`, { method: 'POST' }),
  complete: (id: string) => apiFetch<ApprovalRequest>(`/approvals/${id}/complete/`, { method: 'POST' }),
  delegations: () => apiFetch<{ given: Delegation[]; received: Delegation[] }>('/approvals/delegations/'),
  createDelegation: (body: { delegate_id: string; starts_at: string; ends_at: string }) =>
    apiFetch<Delegation>('/approvals/delegations/', { method: 'POST', body }),
  revokeDelegation: (id: string) =>
    apiFetch<Delegation>(`/approvals/delegations/${id}/revoke/`, { method: 'POST' }),
  workflows: () => apiFetch<WorkflowTemplate[]>('/approvals/workflows/'),
};

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
