/**
 * إدارة الموظفين والهيكل والأدوار — بيانات حسابات وتنظيم فقط. لا شيء هنا
 * يلمس الأجهزة أو المفاتيح أو المحتوى (الفصل التقني SEC-08)، والخادم يفرض
 * النطاق لكل عملية (accounts.manage_users / org.manage_structure /
 * accounts.manage_sessions / roles.manage).
 */
import { ApiError, apiFetch, rawFetch } from '../../shared/api';

export interface UnitRef {
  id: string;
  name: string;
  code: string;
}

export interface Membership {
  id: string;
  institute: UnitRef;
  branch: UnitRef | null;
  department: UnitRef | null;
  job_title: string;
  employment_type: EmploymentType;
  is_primary: boolean;
  started_on: string;
  ended_on: string | null;
  is_current: boolean;
}

export type EmploymentType = 'full_time' | 'part_time' | 'volunteer' | 'contract';

export interface ManagedUser {
  id: string;
  username: string;
  first_name: string;
  last_name: string;
  full_name: string;
  phone: string;
  optional_email: string | null;
  is_active: boolean;
  must_change_password: boolean;
  mfa_enabled: boolean;
  last_login_at: string | null;
  created_at: string;
  deactivated_at: string | null;
  active_sessions: number | null;
  memberships: Membership[];
}

export interface Page<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface Institute {
  id: string;
  name: string;
  code: string;
  is_active: boolean;
}

export interface Branch {
  id: string;
  institute: string;
  name: string;
  code: string;
  city: string;
  is_active: boolean;
}

export interface Department {
  id: string;
  institute: string;
  branch: string | null;
  parent: string | null;
  name: string;
  code: string;
}

export interface UnitChoice {
  institute: string;
  branch?: string | null;
  department?: string | null;
}

export type RoleScope = 'institute' | 'branch' | 'branches' | 'central';

export interface RoleInfo {
  code: string;
  name_ar: string;
  /** الأدوار الخمسة فقط تُسند؛ القديمة تظهر ما دام أحد يحملها. */
  assignable: boolean;
  scope: RoleScope | null;
  holders: number;
  permissions: Array<{ code: string; name_ar: string }>;
}

export interface Assignment {
  id: string;
  user: string;
  full_name: string;
  role: string;
  role_name: string;
  institute: string | null;
  branch: string | null;
  department: string | null;
  granted_by: string | null;
  granted_at: string;
  expires_at: string | null;
}

export const adminApi = {
  /** branch: معرّف فرع العضوية الرئيسية، أو 'none' لمن لا فرع له. */
  managed: (params: { q?: string; status?: 'active' | 'inactive' | 'all'; branch?: string; page?: number }) => {
    const s = new URLSearchParams({ page: String(params.page ?? 1), status: params.status ?? 'all' });
    if (params.q) s.set('q', params.q);
    if (params.branch) s.set('branch', params.branch);
    return apiFetch<Page<ManagedUser>>(`/users/managed/?${s.toString()}`);
  },
  createUser: (body: {
    username: string;
    first_name: string;
    last_name: string;
    phone: string;
    optional_email?: string | null;
    membership?: { institute_id: string; branch_id?: string | null; department_id?: string | null; job_title?: string; employment_type?: EmploymentType };
  }) => apiFetch<{ id: string; temp_password?: string }>('/users/', { method: 'POST', body }),
  setActive: (id: string, isActive: boolean, reason = '') =>
    apiFetch<unknown>(`/users/${id}/`, { method: 'PATCH', body: { is_active: isActive, deactivation_reason: reason } }),
  /** استيراد موظفين من Excel: معاينة (apply=false) ثم إنشاء بنفس الملف. */
  importEmployees: async (file: File, opts: { apply: boolean; createBranches: boolean }): Promise<ImportResult> => {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('apply', opts.apply ? '1' : '0');
    form.append('create_branches', opts.createBranches ? '1' : '0');
    const res = await rawFetch('/users/import/', { method: 'POST', headers: { Accept: 'application/json' }, body: form });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, data);
    return data as ImportResult;
  },
  /** قائمة الموظفين بنفس فلاتر الصفحة كملف Excel. */
  exportManaged: async (params: { q?: string; status?: string; branch?: string }): Promise<Blob> => {
    const s = new URLSearchParams();
    if (params.q) s.set('q', params.q);
    if (params.status) s.set('status', params.status);
    if (params.branch) s.set('branch', params.branch);
    const res = await rawFetch(`/users/managed/export/?${s.toString()}`, {});
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
    return res.blob();
  },
  importTemplate: async (): Promise<Blob> => {
    const res = await rawFetch('/users/import/template/', {});
    if (!res.ok) throw new ApiError(res.status, null);
    return res.blob();
  },
  resetPassword: (id: string) => apiFetch<{ temp_password: string }>(`/users/${id}/reset-password/`, { method: 'POST' }),
  /** حذف نهائي لحساب لم يُستخدم أبدًا؛ الخادم يرفض (409) ما سواه. */
  deleteUser: (id: string) => apiFetch<null>(`/users/${id}/`, { method: 'DELETE' }),
  revokeSessions: (id: string) => apiFetch<{ revoked: number }>(`/users/${id}/revoke-sessions/`, { method: 'POST' }),
  memberships: (id: string) => apiFetch<Membership[]>(`/users/${id}/memberships/`),
  addMembership: (id: string, body: UnitChoice & { job_title?: string; employment_type?: EmploymentType; is_primary?: boolean }) =>
    apiFetch<Membership>(`/users/${id}/memberships/`, { method: 'POST', body }),
  updateMembership: (id: string, mid: string, body: { job_title?: string; make_primary?: boolean; end?: boolean }) =>
    apiFetch<Membership>(`/users/${id}/memberships/${mid}/`, { method: 'PATCH', body }),
  transfer: (id: string, body: UnitChoice & { job_title?: string; employment_type?: EmploymentType }) =>
    apiFetch<Membership>(`/users/${id}/transfer/`, { method: 'POST', body }),

  institutes: () => apiFetch<Institute[]>('/org/institutes/'),
  branches: () => apiFetch<Branch[]>('/org/branches/'),
  departments: () => apiFetch<Department[]>('/org/departments/'),
  createInstitute: (body: { name: string; code: string }) => apiFetch<Institute>('/org/institutes/', { method: 'POST', body }),
  createBranch: (body: { institute: string; name: string; code: string; city: string }) =>
    apiFetch<Branch>('/org/branches/', { method: 'POST', body }),
  updateBranch: (id: string, body: Partial<Pick<Branch, 'name' | 'city' | 'is_active'>>) =>
    apiFetch<Branch>(`/org/branches/${id}/`, { method: 'PATCH', body }),
  createDepartment: (body: { institute: string; branch: string | null; parent: string | null; name: string; code: string }) =>
    apiFetch<Department>('/org/departments/', { method: 'POST', body }),
  updateDepartment: (id: string, body: Partial<Pick<Department, 'name'>>) =>
    apiFetch<Department>(`/org/departments/${id}/`, { method: 'PATCH', body }),

  roleCatalog: () => apiFetch<RoleInfo[]>('/roles/catalog/'),
  assignments: (username?: string) =>
    apiFetch<Assignment[]>(`/roles/assignments/${username ? `?user=${encodeURIComponent(username)}` : ''}`),
  assign: (body: { user_id: string; role_code: string; institute_id?: string | null; branch_id?: string | null; branch_ids?: string[]; department_id?: string | null; expires_at?: string | null }) =>
    apiFetch<unknown>('/roles/assignments/', { method: 'POST', body }),
  revokeAssignment: (id: string) => apiFetch<null>(`/roles/assignments/${id}/`, { method: 'DELETE' }),
};

export const EMPLOYMENT_LABELS: Record<EmploymentType, string> = {
  full_time: 'دوام كامل',
  part_time: 'دوام جزئي',
  volunteer: 'تطوع',
  contract: 'عقد',
};

export function unitLabel(m: Pick<Membership, 'institute' | 'branch' | 'department'>): string {
  return [m.institute.name, m.branch?.name, m.department?.name].filter(Boolean).join(' / ');
}

export interface ImportRow {
  name: string;
  username: string;
  branch: string;
  branch_matched: string | null;
  status: string;
  will_create: boolean;
  created: boolean;
  temp_password?: string;
}

export interface ImportResult {
  applied: boolean;
  created: number;
  rows: ImportRow[];
  shared_temp_password: string | null;
  new_branches: string[];
}
