import { ApiError, apiFetch, refreshAccessToken } from './client';

export interface User {
  id: number | string;
  username: string;
  full_name: string;
  must_change_password: boolean;
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

export type LoginResponse = LoginSuccess | MfaChallenge;

export function isMfaChallenge(response: LoginResponse): response is MfaChallenge {
  return response.mfa_required === true;
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
    apiFetch<MfaVerifyResponse>('/auth/mfa/verify/', {
      method: 'POST',
      auth: false,
      body: { mfa_token, otp },
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
