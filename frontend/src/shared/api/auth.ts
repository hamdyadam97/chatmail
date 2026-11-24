import { ApiError, apiFetch, refreshAccessToken } from './client';

export interface User {
  id: number | string;
  username: string;
  full_name: string;
  must_change_password: boolean;
  /** المعهد الرئيسي للمستخدم نفسه (لشعاره في الرأس). */
  institute?: { code: string; name: string } | null;
  /** قسم «الإدارة» لمدير النظام والمدير التنفيذي فقط (عرض فقط؛ الخادم يتحقق من كل صلاحية). */
  show_admin?: boolean;
}

/** Successful password login (MFA not enabled or not challenged). */
export interface LoginSuccess {
  access: string;
  mfa_required: false;
  user: User;
}

/** Password accepted, but an OTP is required to finish the login. */
export interface MfaChallenge {
  mfa_required: true;
  mfa_token: string;
}

/** Password (and MFA) accepted from a browser this account never used:
 *  the session opens only with a one-time code, sent where the user picks
 *  (their own signed-in browsers / personal e-mail, or the administrators). */
export interface LoginCodeSendOptions {
  /** Another browser of this account is signed in (the code shows there). */
  sessions: boolean;
  /** The account has a personal e-mail. */
  email: boolean;
}

export interface LoginApprovalChallenge {
  approval_required: true;
  mfa_required: false;
  approval_token: string;
  send_options?: LoginCodeSendOptions;
}

export type LoginResponse = LoginSuccess | MfaChallenge | LoginApprovalChallenge;

export function isMfaChallenge(response: LoginResponse): response is MfaChallenge {
  return response.mfa_required === true;
}

export function isApprovalChallenge(response: LoginResponse | MfaVerifyResponse): response is LoginApprovalChallenge {
  return (response as LoginApprovalChallenge).approval_required === true;
}

export interface MfaVerifyResponse {
  access: string;
  user: User;
}

export const authApi = {
  login: (username: string, password: string) =>
    apiFetch<LoginResponse>('/auth/login/', {
      method: 'POST',
      auth: false,
      body: { username, password },
    }),

  verifyMfa: (mfa_token: string, otp: string) =>
    apiFetch<MfaVerifyResponse | LoginApprovalChallenge>('/auth/mfa/verify/', {
      method: 'POST',
      auth: false,
      body: { mfa_token, otp },
    }),

  /** New browser: send the code to myself or to the administrators. */
  sendLoginCode: (approval_token: string, to: 'self' | 'admin') =>
    apiFetch<{ sent_to: string[] }>('/auth/login/code/send/', {
      method: 'POST',
      auth: false,
      body: { approval_token, to },
    }),

  /** New browser: the code (from my other device, my e-mail, or the administrators). */
  loginCode: (approval_token: string, code: string) =>
    apiFetch<MfaVerifyResponse>('/auth/login/code/', {
      method: 'POST',
      auth: false,
      body: { approval_token, code },
    }),

  /** Uses the httpOnly refresh cookie (sent via credentials: 'include'). */
  /** Restores the access token from the refresh cookie (single-flight, see client). */
  refresh: async () => {
    if (!(await refreshAccessToken())) throw new ApiError(401, null, 'لا توجد جلسة صالحة');
  },

  logout: () => apiFetch<null>('/auth/logout/', { method: 'POST' }),

  /** Current user (mounted at /users/ in the backend). */
  me: () => apiFetch<User>('/users/me/'),

  changePassword: (old_password: string, new_password: string) =>
    apiFetch<null>('/auth/password/change/', {
      method: 'POST',
      body: { old_password, new_password },
    }),
};
