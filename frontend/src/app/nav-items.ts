import type { LucideIcon } from 'lucide-react';
import {
  Archive,
  BarChart3,
  Bell,
  Building2,
  CheckCheck,
  Clock,
  Contact,
  FileText,
  FolderTree,
  Hash,
  Inbox,
  KeyRound,
  LayoutDashboard,
  Lock,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  MonitorSmartphone,
  Network,
  ScrollText,
  Search,
  Send,
  ShieldCheck,
  SquarePen,
  Star,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'الرئيسية', icon: LayoutDashboard },
  { to: '/inbox', label: 'الوارد', icon: Inbox },
  { to: '/sent', label: 'الصادر', icon: Send },
  { to: '/drafts', label: 'المسودات', icon: FileText },
  { to: '/important', label: 'المهمة', icon: Star },
  { to: '/pending-replies', label: 'بانتظار ردي', icon: Clock },
  { to: '/archived', label: 'المؤرشفة', icon: Archive },
  { to: '/compose', label: 'إنشاء مراسلة', icon: SquarePen },
  { to: '/search', label: 'البحث', icon: Search },
  { to: '/approvals', label: 'الموافقات', icon: CheckCheck },
  { to: '/announcements', label: 'التعاميم', icon: Megaphone },
  { to: '/direct-messages', label: 'الرسائل المباشرة', icon: MessageCircle },
  { to: '/group-chats', label: 'المحادثات الجماعية', icon: MessagesSquare },
  { to: '/channels', label: 'القنوات', icon: Hash },
  { to: '/employees', label: 'الموظفون', icon: Contact },
  { to: '/institutes', label: 'المعاهد', icon: Building2 },
  { to: '/branches', label: 'الفروع', icon: Network },
  { to: '/departments', label: 'الأقسام', icon: FolderTree },
  { to: '/roles', label: 'الأدوار والصلاحيات', icon: Lock },
  { to: '/reports', label: 'التقارير', icon: BarChart3 },
  { to: '/notifications', label: 'الإشعارات', icon: Bell },
  { to: '/devices', label: 'الأجهزة', icon: MonitorSmartphone },
  { to: '/recovery', label: 'الاستعادة', icon: KeyRound },
  { to: '/security', label: 'الأمان', icon: ShieldCheck },
  { to: '/audit-logs', label: 'سجل التدقيق', icon: ScrollText },
];
