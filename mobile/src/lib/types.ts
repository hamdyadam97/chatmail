/** أشكال ردود الخادم (نفس عقد الموقع — ملفات api.ts في frontend/src/features). */

export interface User {
  id: string;
  username: string;
  full_name: string;
  must_change_password: boolean;
}

export type LoginResponse =
  | { access: string; refresh: string; device_token?: string; mfa_required: false; user: User }
  | { mfa_required: true; mfa_token: string }
  | { approval_required: true; mfa_required: false; approval_token: string; send_options?: { sessions: boolean } };

export interface UserRef {
  id: string;
  full_name: string;
  username: string;
}

export interface Participant {
  user: UserRef;
  kind: 'to' | 'cc' | 'bcc';
  read_at: string | null;
}

export interface AttachmentMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export type Folder = 'inbox' | 'sent' | 'drafts' | 'important' | 'archived';

export interface MailSummary {
  id: string;
  reference_number: string | null;
  sender: UserRef;
  subject: string;
  preview: string;
  has_attachments: boolean;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: 'draft' | 'sent' | 'closed';
  created_at: string;
  sent_at: string | null;
  my_kind: 'from' | 'to' | 'cc' | 'bcc' | null;
  read_at: string | null;
  archived: boolean;
  is_important: boolean;
  participants: Participant[];
  thread_count?: number;
  thread_last_at?: string | null;
}

export interface ThreadItem {
  id: string;
  reference_number: string;
  sender_id: string;
  sent_at: string;
  unread: boolean;
  subject: string;
  body: string;
  attachments: AttachmentMeta[];
  forwarded: { sender_name: string; subject: string; body: string; sent_at: string | null } | null;
}

export interface MailDetail extends MailSummary {
  content: { subject: string; body: string; attachments: AttachmentMeta[] } | null;
  thread_items: ThreadItem[];
}

export interface Page<T> {
  count: number;
  next: string | null;
  results: T[];
}

export interface AppNotification {
  id: string;
  kind: string;
  title: string;
  ref_type: string;
  ref_id: string | null;
  created_at: string;
  read_at: string | null;
}

export interface DirectoryUser {
  id: string;
  full_name?: string;
  username?: string;
  primary_membership?: { institute: string; branch: string | null } | null;
}

export interface Profile {
  id: string;
  username: string;
  full_name: string;
  phone: string;
  optional_email: string | null;
  external_address: string | null;
  membership: { institute: string; branch: string | null; department: string | null; job_title: string } | null;
  roles: { code: string; name: string; scope: string }[];
}
