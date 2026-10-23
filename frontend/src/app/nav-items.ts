import type { LucideIcon } from 'lucide-react';
import {
  BarChart3,
  Building2,
  CheckCheck,
  Contact,
  FolderTree,
  KeyRound,
  Lock,
  Mail,
  Megaphone,
  MessagesSquare,
  MonitorSmartphone,
  Network,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  Bell,
} from 'lucide-react';

export interface RailItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** مسارات أخرى تُعدّ ضمن هذا القسم (لإبراز الأيقونة). */
  match: string[];
}

/** شريط الأقسام الرئيسية (أسلوب Teams/Slack): أيقونة + اسم قصير. */
export const RAIL_ITEMS: RailItem[] = [
  { to: '/mail/inbox', label: 'البريد', icon: Mail, match: ['/mail', '/correspondence', '/compose', '/inbox', '/sent', '/drafts'] },
  { to: '/chat', label: 'المحادثات', icon: MessagesSquare, match: ['/chat', '/direct-messages', '/group-chats', '/channels'] },
  { to: '/announcements', label: 'التعاميم', icon: Megaphone, match: ['/announcements'] },
  { to: '/approvals', label: 'الموافقات', icon: CheckCheck, match: ['/approvals'] },
  { to: '/search', label: 'البحث', icon: Search, match: ['/search'] },
  {
    to: '/admin',
    label: 'الإدارة',
    icon: Building2,
    match: ['/admin', '/employees', '/institutes', '/branches', '/departments', '/roles', '/reports', '/audit-logs'],
  },
];

export const RAIL_BOTTOM: RailItem[] = [
  { to: '/settings', label: 'الإعدادات', icon: Settings, match: ['/settings', '/devices', '/security', '/recovery', '/notifications'] },
];

export interface HubItem {
  to: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

export const ADMIN_ITEMS: HubItem[] = [
  { to: '/employees', label: 'الموظفون', description: 'الحسابات والعضويات والنقل', icon: Contact },
  { to: '/institutes', label: 'المعاهد', description: 'رموز المعاهد في الأرقام المرجعية', icon: Building2 },
  { to: '/branches', label: 'الفروع', description: 'فروع كل معهد', icon: Network },
  { to: '/departments', label: 'الأقسام', description: 'شجرة الأقسام', icon: FolderTree },
  { to: '/roles', label: 'الأدوار والصلاحيات', description: 'ما يمنحه كل دور والإسنادات', icon: Lock },
  { to: '/reports', label: 'التقارير', description: 'أعداد وأزمنة مجمّعة وحالة الخدمات', icon: BarChart3 },
  { to: '/audit-logs', label: 'سجل التدقيق', description: 'لمراقب الأمن المعلن', icon: ScrollText },
];

export const SETTINGS_ITEMS: HubItem[] = [
  { to: '/devices', label: 'أجهزتي', description: 'الأجهزة الموثّقة واعتماد جهاز جديد', icon: MonitorSmartphone },
  { to: '/security', label: 'الأمان', description: 'سلسلة الشفافية ونشاط حسابي', icon: ShieldCheck },
  { to: '/recovery', label: 'الاستعادة', description: 'مفتاح الاستعادة والنسخ المشفرة', icon: KeyRound },
  { to: '/notifications', label: 'الإشعارات', description: 'كل الإشعارات', icon: Bell },
];
