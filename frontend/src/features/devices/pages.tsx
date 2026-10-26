import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MonitorSmartphone, RefreshCw, ShieldCheck, ShieldOff } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, Spinner } from '../../shared/ui';
import { toUserMessage } from '../../shared/api';
import { useAuth } from '../auth/AuthContext';
import { devicesApi, deviceStatusLabel, type ApiDevice } from '../../crypto/devices';
import { loadCurrentDevice, refreshDeviceStatus } from '../../crypto/identity';
import { syncNewDeviceToGroups, type DeviceSyncSummary } from '../../crypto/mls';
import '../../features/chat/api'; // تهيئة نقل MLS (setMlsTransport) كأثر جانبي
import { cn } from '../../shared/lib/cn';

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800',
  active: 'bg-emerald-100 text-emerald-800',
  revoked: 'bg-red-100 text-red-800',
  retired: 'bg-gray-100 text-gray-600',
};

function syncLineFor(summary: DeviceSyncSummary): string {
  if (summary.synced.length > 0) {
    return `تمت مزامنة الجهاز مع ${summary.synced.length} محادثة`;
  }
  const reasons = new Set(summary.skipped.map((s) => s.reason));
  if (reasons.size === 1 && reasons.has('already-member')) return 'الجهاز عضو مسبقًا في كل المحادثات';
  if (reasons.has('no-keypackage')) return 'تعذرت المزامنة — رفع الجهاز الجديد لحزم مفاتيح غير كافية؛ افتحه ليرفع مجموعة جديدة ثم أعد المحاولة';
  if (reasons.has('epoch-conflict')) return 'تعذرت المزامنة — تعارض جيل؛ افتح المحادثة المتأثرة لإعادة المزامنة ثم أعد المحاولة';
  return 'لا محادثات تحتاج مزامنة';
}

function DeviceRow({
  device,
  currentDeviceId,
  onSynced,
}: {
  device: ApiDevice;
  currentDeviceId: number | string | null;
  onSynced: (line: string) => void;
}) {
  const queryClient = useQueryClient();
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const { user } = useAuth();

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['devices'] });
    await refreshDeviceStatus(user!.id).catch(() => undefined);
  };

  const approveMutation = useMutation({
    mutationFn: async () => {
      await devicesApi.approve(user!.id, device.id);
      // مزامنة الجهاز الجديد مع مجموعات MLS الخاصة بنا (§3.3) — تتطلب
      // أن يكون لدى هذا الجهاز (الموثّق) مفاتيح محلية؛ وإلا نكتفي بالاعتماد.
      const local = await loadCurrentDevice(user!.id).catch(() => undefined);
      if (!local || local.status !== 'active') {
        return { line: 'اكتمل الاعتماد — افتح تطبيقك من هذا الجهاز الموثّق لمزامنة المحادثات مع الجهاز الجديد' };
      }
      const summary = await syncNewDeviceToGroups(device.id);
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
      return { line: syncLineFor(summary) };
    },
    onSuccess: async (result) => {
      await invalidate();
      onSynced(result.line);
    },
  });
  const revokeMutation = useMutation({
    mutationFn: () => devicesApi.revoke(device.id),
    onSuccess: () => {
      setConfirmRevoke(false);
      void invalidate();
    },
  });

  const isCurrent = currentDeviceId !== null && String(device.id) === String(currentDeviceId);
  const error = approveMutation.error ?? revokeMutation.error;

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 px-4 py-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-medium text-gray-900">
          <MonitorSmartphone className="h-4 w-4 shrink-0 text-gray-400" />
          <span className="truncate">{device.label}</span>
          {isCurrent && (
            <span className="rounded-full bg-primary-50 px-2 py-0.5 text-xs text-primary-700">هذا الجهاز</span>
          )}
        </p>
        <p className="mt-1 text-xs text-gray-400">
          {device.platform} · سُجّل {new Date(device.created_at).toLocaleDateString('ar')}
          {device.last_seen_at && ` · آخر ظهور ${new Date(device.last_seen_at).toLocaleDateString('ar')}`}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <span className={cn('rounded-full px-2.5 py-1 text-xs font-medium', STATUS_COLORS[device.status] ?? 'bg-gray-100 text-gray-600')}>
          {deviceStatusLabel(device.status)}
        </span>
        {device.status === 'pending' && !isCurrent && (
          <Button size="sm" onClick={() => approveMutation.mutate()} loading={approveMutation.isPending}>
            <ShieldCheck className="h-4 w-4" />
            اعتماد
          </Button>
        )}
        {device.status === 'pending' && isCurrent && (
          // الجهاز لا يعتمد نفسه (حماية من إضافة جهاز بصمت): الاعتماد من جهاز موثّق آخر.
          <span className="max-w-xs text-xs text-gray-500">
            اعتمده من أحد أجهزتك الموثّقة، أو{' '}
            <Link to="/recovery" className="text-primary-700 underline">
              استعد حسابك بمفتاح الاستعادة
            </Link>
          </span>
        )}
        {(device.status === 'active' || device.status === 'pending') && !isCurrent && (
          <>
            {confirmRevoke ? (
              <>
                <span className="text-xs text-red-600">إبطال هذا الجهاز؟</span>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => revokeMutation.mutate()}
                  loading={revokeMutation.isPending}
                >
                  تأكيد الإبطال
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmRevoke(false)}>
                  تراجع
                </Button>
              </>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setConfirmRevoke(true)}>
                <ShieldOff className="h-4 w-4" />
                إبطال
              </Button>
            )}
          </>
        )}
      </div>
      {error && <p className="w-full text-xs text-red-600">{toUserMessage(error, 'تعذر تنفيذ العملية')}</p>}
    </li>
  );
}

export const Devices = () => {
  const { user } = useAuth();
  const [localDeviceId, setLocalDeviceId] = useState<number | string | null>(null);
  const [syncLine, setSyncLine] = useState<string | null>(null);
  const { data: devices, isLoading } = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const list = await devicesApi.list();
      const local = await refreshDeviceStatus(user!.id).catch(() => undefined);
      setLocalDeviceId(local?.deviceId ?? null);
      return list;
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>أجهزتي</CardTitle>
          {syncLine && (
            <Button variant="ghost" size="sm" onClick={() => setSyncLine(null)} aria-label="إخفاء التنبيه">
              <RefreshCw className="h-4 w-4" />
            </Button>
          )}
        </div>
        <p className="text-sm text-gray-500">
          كل جهاز هوية تشفيرية مستقلة. الجهاز الجديد يبقى معطّلًا حتى تعتمده من جهاز موثّق، ثم تتم مزامنته مع محادثاتك تلقائيًا.
        </p>
      </CardHeader>
      <CardContent>
        {syncLine && (
          <div className="mb-3 flex items-center gap-2 rounded-lg bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
            <ShieldCheck className="h-4 w-4 shrink-0" />
            {syncLine}
          </div>
        )}
        {isLoading && (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        )}
        {!isLoading && (
          <ul className="space-y-2">
            {(devices ?? []).map((device) => (
              <DeviceRow
                key={String(device.id)}
                device={device}
                currentDeviceId={localDeviceId}
                onSynced={setSyncLine}
              />
            ))}
            {(devices ?? []).length === 0 && (
              <li className="py-6 text-center text-sm text-gray-400">لا أجهزة مسجلة بعد — ستُسجَّل تلقائيًا عند تفعيل التشفير</li>
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  );
};

export const DevicesPages = { Devices };
