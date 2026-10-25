import { createBrowserRouter, Navigate, useLocation } from 'react-router-dom';
import { AppShell } from './AppShell';
import { RequireAuth } from '../features/auth/RequireAuth';
import LoginPage from '../features/auth/LoginPage';
import { MailLayout } from '../features/mail/MailLayout';
import { ChatWorkspace } from '../features/chat/ChatWorkspace';
import { ApprovalsPages } from '../features/approvals/pages';
import { AnnouncementsPages } from '../features/announcements/pages';
import { EmployeesPages } from '../features/employees/pages';
import { OrgPages } from '../features/org/pages';
import { RolesPages } from '../features/roles/pages';
import { ReportsPages } from '../features/reports/pages';
import { NotificationsPages } from '../features/notifications/pages';
import { DevicesPages } from '../features/devices/pages';
import { RecoveryPages } from '../features/recovery/pages';
import { ArchivePage } from '../features/archive/pages';
import { SecurityPages } from '../features/security/pages';
import { AuditPages } from '../features/audit/pages';
import { SearchPage } from '../features/search/pages';
import { AdminHub, SettingsHub } from '../features/hub/pages';

/** تحويل يحافظ على ?query (روابط المسودات/الإحالة/البحث القديمة). */
function Redirect({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Navigate to="/mail/inbox" replace /> },

      // البريد (Outlook): ثلاث لوحات
      { path: 'mail', element: <Navigate to="/mail/inbox" replace /> },
      { path: 'mail/compose', element: <MailLayout mode="compose" /> },
      { path: 'mail/:folder', element: <MailLayout /> },
      { path: 'mail/:folder/compose', element: <MailLayout mode="compose" /> },
      { path: 'mail/:folder/:id', element: <MailLayout /> },
      { path: 'correspondence/:id', element: <MailLayout mode="legacy" /> },
      { path: 'compose', element: <Redirect to="/mail/compose" /> },
      { path: 'inbox', element: <Redirect to="/mail/inbox" /> },
      { path: 'sent', element: <Redirect to="/mail/sent" /> },
      { path: 'drafts', element: <Redirect to="/mail/drafts" /> },
      { path: 'archived', element: <Redirect to="/mail/archived" /> },
      { path: 'important', element: <Redirect to="/mail/important" /> },
      { path: 'pending-replies', element: <Redirect to="/mail/pending" /> },

      // المحادثات (Slack)
      { path: 'chat', element: <ChatWorkspace /> },
      { path: 'chat/:conversationId', element: <ChatWorkspace /> },
      { path: 'direct-messages', element: <Redirect to="/chat" /> },
      { path: 'group-chats', element: <Redirect to="/chat" /> },
      { path: 'channels', element: <Redirect to="/chat" /> },

      { path: 'approvals', element: <ApprovalsPages.Approvals /> },
      { path: 'approvals/:id', element: <ApprovalsPages.Detail /> },
      { path: 'announcements', element: <AnnouncementsPages.Announcements /> },
      { path: 'announcements/new', element: <AnnouncementsPages.Compose /> },
      { path: 'announcements/:id', element: <AnnouncementsPages.Detail /> },
      { path: 'search', element: <SearchPage /> },

      { path: 'admin', element: <AdminHub /> },
      { path: 'employees', element: <EmployeesPages.Employees /> },
      { path: 'institutes', element: <OrgPages.Institutes /> },
      { path: 'branches', element: <OrgPages.Branches /> },
      { path: 'departments', element: <OrgPages.Departments /> },
      { path: 'roles', element: <RolesPages.Roles /> },
      { path: 'reports', element: <ReportsPages.Reports /> },
      { path: 'audit-logs', element: <AuditPages.AuditLogs /> },

      { path: 'settings', element: <SettingsHub /> },
      { path: 'notifications', element: <NotificationsPages.Notifications /> },
      { path: 'devices', element: <DevicesPages.Devices /> },
      { path: 'recovery', element: <RecoveryPages.Recovery /> },
      { path: 'archive', element: <ArchivePage /> },
      { path: 'security', element: <SecurityPages.Security /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
