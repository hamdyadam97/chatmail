import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Lock, LogOut, Search } from 'lucide-react';
import { MOBILE_TABS, RAIL_BOTTOM, RAIL_ITEMS, type RailItem } from './nav-items';
import { useEffect } from 'react';
import { useAuth } from '../features/auth/AuthContext';
import { MustChangePasswordModal } from '../features/auth/MustChangePasswordModal';
import { NotificationBell } from '../features/notifications/NotificationBell';
import { PushPrompt } from '../features/notifications/PushControls';
import { InstallPrompt } from '../features/install/InstallPrompt';
import { Avatar } from '../shared/ui';
import { InstituteLogo } from '../shared/brand';
import { cn } from '../shared/lib/cn';

/** أقسام تملأ الشاشة بلوحاتها (البريد بثلاث لوحات، المحادثات بأسلوب Slack). */
const FULL_BLEED = ['/mail', '/correspondence', '/compose', '/inbox', '/sent', '/drafts', '/chat', '/direct-messages', '/group-chats'];

function isActive(item: RailItem, pathname: string): boolean {
  return item.match.some((p) => pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(p));
}

/** شريط الموبايل السفلي (يحل محل العمود الجانبي تحت عرض md). */
function MobileTabs({ pathname }: { pathname: string }) {
  return (
    <nav
      className="flex shrink-0 border-t border-gray-200 bg-white md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      aria-label="الأقسام"
    >
      {MOBILE_TABS.map((item) => {
        const Icon = item.icon;
        const active = isActive(item, pathname);
        return (
          <NavLink
            key={item.to}
            to={item.to}
            className={cn('flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px]', active ? 'text-primary-700' : 'text-gray-500')}
          >
            <Icon className={cn('h-5 w-5', active && 'stroke-[2.5]')} />
            {item.label}
          </NavLink>
        );
      })}
    </nav>
  );
}

function RailLink({ item, pathname }: { item: RailItem; pathname: string }) {
  const active = isActive(item, pathname);
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      className={cn(
        'group flex w-full flex-col items-center gap-1 rounded-lg py-2 text-[11px] font-medium transition-colors',
        active ? 'text-white' : 'text-white/60 hover:text-white',
      )}
    >
      <span
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-lg transition-colors',
          active ? 'bg-white/20' : 'group-hover:bg-white/10',
        )}
      >
        <Icon className="h-5 w-5" />
      </span>
      {item.label}
    </NavLink>
  );
}

export function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const fullBleed = FULL_BLEED.some((p) => pathname.startsWith(p));

  // نقرة على إشعار سطح المكتب والتطبيق مفتوح: ننتقل داخليًا بلا إعادة تحميل.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; url?: unknown } | null;
      if (data?.type === 'open-url' && typeof data.url === 'string' && data.url.startsWith('/')) navigate(data.url);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-gray-50">
      {/* شريط الأقسام — يمين الشاشة في RTL (الشاشات الكبيرة) */}
      <nav className="hidden w-[76px] shrink-0 flex-col items-center gap-1 bg-primary-900 px-1.5 py-3 md:flex" aria-label="الأقسام">
        <Link to="/mail/inbox" className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 text-white" aria-label="الرئيسية">
          <Lock className="h-5 w-5" />
        </Link>
        {RAIL_ITEMS.map((item) => (
          <RailLink key={item.to} item={item} pathname={pathname} />
        ))}
        <div className="mt-auto w-full">
          {RAIL_BOTTOM.map((item) => (
            <RailLink key={item.to} item={item} pathname={pathname} />
          ))}
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-gray-200 bg-white px-3 md:gap-4 md:px-4"
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          <span className="hidden text-sm font-semibold text-gray-900 lg:block">المراسلات الداخلية</span>
          <Link to="/mail/inbox" className="flex items-center gap-2 text-sm font-semibold text-gray-900 md:hidden">
            <Lock className="h-4 w-4 text-primary-700" />
            المراسلات
          </Link>
          {/* البحث: الاستعلام يمر بحالة الموجّه لا بالعنوان (خارج سجل المتصفح). */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const q = new FormData(e.currentTarget).get('q');
              navigate('/search', { state: { q: typeof q === 'string' ? q : '' } });
              e.currentTarget.reset();
            }}
            className="relative hidden w-full max-w-xl md:block"
          >
            <Search className="pointer-events-none absolute start-3 top-2 h-4 w-4 text-gray-400" />
            <input
              name="q"
              placeholder="ابحث في بريدك ومحادثاتك…"
              autoComplete="off"
              aria-label="بحث في المحتوى"
              className="h-8 w-full rounded-md border border-gray-200 bg-gray-100 ps-9 text-sm focus:border-primary-500 focus:bg-white focus:outline-none"
            />
          </form>
          <div className="flex items-center gap-2 md:gap-3">
            <Link to="/search" className="rounded-lg p-2 text-gray-600 hover:bg-gray-100 md:hidden" aria-label="بحث">
              <Search className="h-5 w-5" />
            </Link>
            <NotificationBell />
            {user?.institute && (
              <InstituteLogo
                code={user.institute.code}
                name={user.institute.name}
                className="hidden h-8 max-w-[7rem] border-e border-gray-200 pe-3 md:block"
              />
            )}
            <span className="flex items-center gap-2">
              <Avatar name={user?.full_name || user?.username || '؟'} size="sm" />
              <span className="hidden text-sm text-gray-700 md:inline">{user?.full_name}</span>
            </span>
            <button
              type="button"
              onClick={handleLogout}
              className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-800"
              aria-label="تسجيل الخروج"
              title="تسجيل الخروج"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </header>
        {/* الموبايل: شريط تنبيه واحد في كل مرة بالأولوية (تثبيت ← الإشعارات) */}
        <div className="max-md:[&>*+*]:hidden">
          <InstallPrompt />
          <PushPrompt />
        </div>
        <main className={cn('min-h-0 flex-1', fullBleed ? 'overflow-hidden' : 'overflow-y-auto p-4 md:p-6')}>
          <Outlet />
        </main>
        <MobileTabs pathname={pathname} />
      </div>

      {user?.must_change_password && <MustChangePasswordModal />}
    </div>
  );
}
