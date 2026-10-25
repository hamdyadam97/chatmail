import { Link } from 'react-router-dom';
import { ADMIN_ITEMS, MORE_ITEMS, SETTINGS_ITEMS, type HubItem } from '../../app/nav-items';

function Hub({ title, note, items }: { title: string; note: string; items: HubItem[] }) {
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
        <p className="text-sm text-gray-500">{note}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(({ to, label, description, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm transition-colors hover:border-primary-300 hover:bg-primary-50/40"
          >
            <span className="rounded-lg bg-primary-50 p-2 text-primary-700">
              <Icon className="h-5 w-5" />
            </span>
            <span>
              <span className="block font-medium text-gray-900">{label}</span>
              <span className="block text-xs text-gray-500">{description}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

export const AdminHub = () => (
  <Hub
    title="الإدارة"
    note="إدارة الهيكل والحسابات والتقارير — لا يمنح أي منها اطلاعًا على مراسلات أحد. الصفحات تعرض ما تسمح به صلاحياتك فقط."
    items={ADMIN_ITEMS}
  />
);

export const SettingsHub = () => <Hub title="الإعدادات" note="أجهزتك ومفاتيحك وأمان حسابك." items={SETTINGS_ITEMS} />;

export const MoreHub = () => <Hub title="المزيد" note="بقية الأقسام." items={MORE_ITEMS} />;
