/** `/api/v1/audit-logs/*` — سجل تدقيق للقراءة فقط (معرّفات وأعداد، لا محتوى). */
import { apiFetch } from '../../shared/api';

export interface AuditRow {
  id: number;
  created_at: string;
  action: string;
  actor: { id: string; username: string; full_name: string } | null;
  actor_device_id: string | null;
  target_type: string;
  target_id: string | null;
  org_scope: string;
  ip: string | null;
  user_agent: string;
  metadata: Record<string, unknown>;
}

export interface AuditFilters {
  action?: string;
  actor?: string;
  target_type?: string;
  from?: string;
  to?: string;
  page?: number;
}

export const auditApi = {
  list: (f: AuditFilters) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) q.set(k, String(v));
    return apiFetch<{ count: number; next: string | null; previous: string | null; results: AuditRow[] }>(
      `/audit-logs/?${q.toString()}`,
    );
  },
  actions: () => apiFetch<string[]>('/audit-logs/actions/'),
  mine: () => apiFetch<AuditRow[]>('/audit-logs/mine/'),
};

/** تسميات عربية لأشهر الأحداث؛ غيرها يُعرض بمعرّفه. */
export const ACTION_LABELS: Record<string, string> = {
  login: 'تسجيل دخول',
  login_failed: 'محاولة دخول فاشلة',
  login_mfa_challenge_issued: 'طلب رمز التحقق الثنائي',
  logout: 'تسجيل خروج',
  password_changed: 'تغيير كلمة المرور',
  password_reset: 'إعادة تعيين كلمة المرور (من المسؤول)',
  mfa_setup: 'بدء إعداد التحقق الثنائي',
  mfa_enabled: 'تفعيل التحقق الثنائي',
  mfa_disabled: 'تعطيل التحقق الثنائي',
  mfa_verify_failed: 'رمز تحقق خاطئ',
  session_revoked: 'إلغاء جلسة',
  key_event: 'حدث مفاتيح',
  device_added: 'إضافة جهاز',
  device_approved: 'اعتماد جهاز',
  device_revoked: 'إبطال جهاز',
  correspondence_sent: 'إرسال مراسلة',
  forward: 'إحالة',
  approval_requested: 'طلب اعتماد',
  approval_decided: 'قرار اعتماد',
  announcement_published: 'نشر تعميم',
  announcement_acknowledged: 'إقرار تعميم',
  unauthorized_access_denied: 'محاولة وصول غير مصرح',
  report_viewed: 'عرض تقرير',
  audit_log_viewed: 'عرض سجل التدقيق',
};
