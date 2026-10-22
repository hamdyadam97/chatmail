import { ShieldAlert } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../shared/ui';
import { useAuth } from '../auth/AuthContext';

export default function DashboardPage() {
  const { user } = useAuth();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {user?.must_change_password && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <ShieldAlert className="h-5 w-5 shrink-0" />
          يجب تغيير كلمة المرور الخاصة بك قبل استخدام النظام.
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>مرحبًا، {user?.full_name}</CardTitle>
          <CardDescription>هذه هي لوحة التحكم الرئيسية لنظام المراسلات الداخلية.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600">
            يتم تطوير المزيد من الميزات (المراسلات، المحادثات، الموافقات، التقارير) في المراحل القادمة.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
