import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppShell } from './AppShell';
import { RequireAuth } from '../features/auth/RequireAuth';
import LoginPage from '../features/auth/LoginPage';
import DashboardPage from '../features/dashboard/DashboardPage';
import { CorrespondencePages } from '../features/correspondence/pages';
import { ChatPages } from '../features/chat/pages';
import { ApprovalsPages } from '../features/approvals/pages';
import { AnnouncementsPages } from '../features/announcements/pages';
import { EmployeesPages } from '../features/employees/pages';
import { OrgPages } from '../features/org/pages';
import { RolesPages } from '../features/roles/pages';
import { ReportsPages } from '../features/reports/pages';
import { NotificationsPages } from '../features/notifications/pages';
import { DevicesPages } from '../features/devices/pages';
import { RecoveryPages } from '../features/recovery/pages';
import { SecurityPages } from '../features/security/pages';
import { AuditPages } from '../features/audit/pages';
import { SearchPage } from '../features/search/pages';

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
      { index: true, element: <DashboardPage /> },
      { path: 'inbox', element: <CorrespondencePages.Inbox /> },
      { path: 'sent', element: <CorrespondencePages.Sent /> },
      { path: 'drafts', element: <CorrespondencePages.Drafts /> },
      { path: 'archived', element: <CorrespondencePages.Archived /> },
      { path: 'important', element: <CorrespondencePages.Important /> },
      { path: 'pending-replies', element: <CorrespondencePages.PendingReplies /> },
      { path: 'compose', element: <CorrespondencePages.Compose /> },
      { path: 'correspondence/:id', element: <CorrespondencePages.Details /> },
      { path: 'approvals', element: <ApprovalsPages.Approvals /> },
      { path: 'approvals/:id', element: <ApprovalsPages.Detail /> },
      { path: 'announcements', element: <AnnouncementsPages.Announcements /> },
      { path: 'announcements/new', element: <AnnouncementsPages.Compose /> },
      { path: 'announcements/:id', element: <AnnouncementsPages.Detail /> },
      { path: 'direct-messages', element: <ChatPages.DirectMessages /> },
      { path: 'group-chats', element: <ChatPages.GroupChats /> },
      { path: 'channels', element: <ChatPages.Channels /> },
      { path: 'employees', element: <EmployeesPages.Employees /> },
      { path: 'institutes', element: <OrgPages.Institutes /> },
      { path: 'branches', element: <OrgPages.Branches /> },
      { path: 'departments', element: <OrgPages.Departments /> },
      { path: 'roles', element: <RolesPages.Roles /> },
      { path: 'reports', element: <ReportsPages.Reports /> },
      { path: 'notifications', element: <NotificationsPages.Notifications /> },
      { path: 'devices', element: <DevicesPages.Devices /> },
      { path: 'recovery', element: <RecoveryPages.Recovery /> },
      { path: 'security', element: <SecurityPages.Security /> },
      { path: 'audit-logs', element: <AuditPages.AuditLogs /> },
      { path: 'search', element: <SearchPage /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
