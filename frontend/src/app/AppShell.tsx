import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LogOut, Search } from 'lucide-react';
import { NAV_ITEMS } from './nav-items';
import { useAuth } from '../features/auth/AuthContext';
import { MustChangePasswordModal } from '../features/auth/MustChangePasswordModal';
import { NotificationBell } from '../features/notifications/NotificationBell';
import { Button } from '../shared/ui';
import { cn } from '../shared/lib/cn';

export function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex min-h-screen bg-gray-50">
      {/* Sidebar — right side in RTL (first flex child at inline-start) */}
      <aside className="sticky top-0 flex h-screen w-64 shrink-0 flex-col border-e border-gray-200 bg-white">
        <div className="flex h-16 items-center justify-center border-b border-gray-200 px-4">
          <span className="text-lg font-bold text-primary-700">نظام المراسلات</span>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary-50 text-primary-700'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
                )
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-b border-gray-200 bg-white px-6">
          <div className="flex items-center gap-4">
            <h1 className="text-base font-semibold text-gray-900">المراسلات الداخلية المشفرة</h1>
            {/* البحث المحلي: الاستعلام يمر بحالة الموجّه لا بالعنوان (خارج سجل المتصفح). */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const q = new FormData(e.currentTarget).get('q');
                navigate('/search', { state: { q: typeof q === 'string' ? q : '' } });
                e.currentTarget.reset();
              }}
              className="relative hidden md:block"
            >
              <Search className="pointer-events-none absolute start-2.5 top-2.5 h-4 w-4 text-gray-400" />
              <input
                name="q"
                placeholder="بحث محلي في المحتوى…"
                autoComplete="off"
                aria-label="بحث محلي في المحتوى"
                className="h-9 w-64 rounded-lg border border-gray-200 bg-gray-50 ps-8 text-sm focus:border-primary-500 focus:bg-white focus:outline-none"
              />
            </form>
          </div>
          <div className="flex items-center gap-4">
            <NotificationBell />
            <span className="text-sm text-gray-600">{user?.full_name}</span>
            <Button variant="outline" size="sm" onClick={handleLogout}>
              <LogOut className="h-4 w-4" />
              تسجيل الخروج
            </Button>
          </div>
        </header>
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>

      {user?.must_change_password && <MustChangePasswordModal />}
    </div>
  );
}
