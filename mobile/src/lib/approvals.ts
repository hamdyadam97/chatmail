/** الموافقات — نفس عقد الموقع (`/api/v1/approvals/`). */
import { API_BASE, ApiError, api, authHeaders, refreshSession } from './api';
import type { UserRef } from './types';

export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'returned' | 'completed' | 'cancelled';
export type Decision = 'approved' | 'rejected' | 'returned';
export type StepStatus = 'waiting' | 'active' | 'approved' | 'rejected' | 'returned' | 'cancelled' | 'skipped';

export interface FileMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface ApprovalRequest {
  id: string;
  correspondence: { id: string; reference_number: string | null };
  status: RequestStatus;
  current_step_order: number;
  requested_by: UserRef;
  created_at: string;
  decided_at: string | null;
  steps: {
    step_order: number;
    step_type: 'all' | 'any';
    status: StepStatus;
    approvers: { user: UserRef; decision: { decision: Decision; decided_at: string; verify_code: string | null } | null; deferred_at: string | null }[];
  }[];
  my_slot: { slot_user_id: string; delegated: boolean } | null;
  my_early_step: number | null;
  reminded_at?: string | null;
  signable: boolean;
  workflow_name: string | null;
  title: string | null;
  source_file: FileMeta | null;
  signed_file: FileMeta | null;
  signature_count: number;
  page_count: number | null;
  events: { kind: string; actor: UserRef; step_order: number; note: string; created_at: string }[];
  can_resubmit: boolean;
  deliver_to?: UserRef[];
  deliver_cc?: UserRef[];
  delivered_correspondence?: { id: string; reference_number: string | null } | null;
}

export interface RequestType {
  id: string;
  name: string;
  steps: unknown[];
}

export type Box = 'pending_mine' | 'requested_by_me' | 'received';

export const STATUS_LABELS: Record<RequestStatus, string> = {
  pending: 'قيد الاعتماد',
  approved: 'معتمد',
  rejected: 'مرفوض',
  returned: 'معاد للمراجعة',
  completed: 'مكتمل',
  cancelled: 'ملغى',
};

export const STEP_LABELS: Record<StepStatus, string> = {
  waiting: 'بالانتظار',
  active: 'جارية',
  approved: 'معتمدة',
  rejected: 'مرفوضة',
  returned: 'معادة',
  cancelled: 'ملغاة',
  skipped: 'تم تخطيها',
};

export const EVENT_LABELS: Record<string, string> = {
  approved: 'اعتمد',
  rejected: 'رفض',
  returned: 'أعاده للمراجعة',
  deferred: 'أجّل البتّ',
  resubmitted: 'أعاد إرساله',
  resubmitted_file: 'أعاد إرساله بملف جديد',
  skipped: 'تخطّى هذه الخطوة وقرر مباشرة',
  carried: 'اعتمد هذه الخطوة أيضًا (باعتماده السابق)',
  reminded: 'ذكّر بالتوقيع',
};

/** عنوان الطلب للعرض (بلا اسم النوع المكرر). */
export function requestTitle(r: ApprovalRequest): string {
  if (r.signable && r.title) return r.title.replace(`${r.workflow_name}: `, '');
  return r.correspondence.reference_number ?? 'طلب اعتماد';
}

export const approvalsApi = {
  list: (box: Box) => api<ApprovalRequest[]>(`/approvals/?box=${box}`),
  get: (id: string) => api<ApprovalRequest>(`/approvals/${id}/`),
  decide: (id: string, body: { decision: Decision; note?: string; password?: string; page?: number }) =>
    api<ApprovalRequest>(`/approvals/${id}/decide/`, { method: 'POST', body }),
  defer: (id: string, note: string) => api<ApprovalRequest>(`/approvals/${id}/defer/`, { method: 'POST', body: { note } }),
  remind: (id: string) => api<ApprovalRequest & { reminded: number }>(`/approvals/${id}/remind/`, { method: 'POST' }),
  cancel: (id: string) => api<ApprovalRequest>(`/approvals/${id}/cancel/`, { method: 'POST' }),
  signature: () => api<{ has_signature: boolean }>('/approvals/signature/'),
  types: () => api<RequestType[]>('/approvals/request-types/'),
};

/** «طلب جديد»: ملف PDF أو صورة (تتحول PDF على الخادم). */
export async function fileRequest(input: {
  workflowId: string;
  title: string;
  note: string;
  file: { uri: string; name: string; mime: string };
  deliverTo?: string[];
}): Promise<ApprovalRequest> {
  const send = async () => {
    const form = new FormData();
    form.append('workflow_id', input.workflowId);
    form.append('title', input.title);
    form.append('note', input.note);
    for (const id of input.deliverTo ?? []) form.append('deliver_to', id);
    // React Native: {uri, name, type} يرفع الملف من مساره المحلي.
    form.append('file', { uri: input.file.uri, name: input.file.name, type: input.file.mime } as unknown as Blob);
    return fetch(`${API_BASE}/approvals/file-request/`, { method: 'POST', headers: await authHeaders(), body: form });
  };
  let res: Response;
  try {
    res = await send();
    if (res.status === 401 && (await refreshSession())) res = await send();
  } catch {
    throw new ApiError(0, null, 'تعذر الاتصال بالخادم — تأكد من الإنترنت');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data as ApprovalRequest;
}
