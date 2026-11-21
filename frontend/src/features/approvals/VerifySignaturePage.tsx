import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { BadgeCheck, SearchCheck, ShieldX } from 'lucide-react';
import { Button, Card, Input, Label } from '../../shared/ui';
import { toUserMessage } from '../../shared/api';
import { approvalsApi, STATUS_LABELS } from './api';
import { formatDate } from './components';

/** «التحقق من توقيع»: رمز مطبوع في مربع التوقيع ← هل التوقيع حقيقي؟ لا يعرض محتوى الطلب. */
export function VerifySignaturePage() {
  const [code, setCode] = useState('');
  const check = useMutation({ mutationFn: () => approvalsApi.verify(code) });
  const r = check.data;
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
          <SearchCheck className="h-5 w-5 text-primary-700" />
          التحقق من توقيع
        </h2>
        <p className="text-sm text-gray-500">
          اكتب «رمز التحقق» المطبوع في مربع التوقيع على الورقة لتتأكد أن النظام هو من ختمه.
        </p>
      </div>
      <Card className="p-5">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (code.trim()) check.mutate();
          }}
        >
          <div className="flex-1">
            <Label htmlFor="verify-code">رمز التحقق</Label>
            <Input
              id="verify-code"
              dir="ltr"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="XXXX-XXXX"
              autoComplete="off"
              className="font-mono uppercase tracking-widest"
            />
          </div>
          <Button type="submit" disabled={!code.trim()} loading={check.isPending}>
            تحقق
          </Button>
        </form>
      </Card>
      {check.error && <p className="text-sm text-red-600">{toUserMessage(check.error, 'تعذر التحقق')}</p>}
      {r && !r.valid && (
        <Card className="flex items-start gap-3 border-red-200 bg-red-50 p-5" data-testid="verify-invalid">
          <ShieldX className="h-6 w-6 shrink-0 text-red-600" />
          <div>
            <p className="font-semibold text-red-800">الرمز غير صحيح</p>
            <p className="text-sm text-red-700">لا يوجد توقيع في النظام بهذا الرمز — الورقة غير موقّعة من النظام، أو الرمز مكتوب خطأ.</p>
          </div>
        </Card>
      )}
      {r?.valid && (
        <Card className="space-y-3 border-emerald-200 bg-emerald-50/60 p-5" data-testid="verify-valid">
          <p className="flex items-center gap-2 font-semibold text-emerald-800">
            <BadgeCheck className="h-6 w-6" />
            توقيع صحيح
          </p>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
            <div><dt className="inline text-gray-500">الموقّع: </dt><dd className="inline font-medium">{r.signer}</dd></div>
            {r.on_behalf_of && <div><dt className="inline text-gray-500">بالتفويض عن: </dt><dd className="inline">{r.on_behalf_of}</dd></div>}
            <div><dt className="inline text-gray-500">وقت التوقيع: </dt><dd className="inline">{formatDate(r.signed_at)}</dd></div>
            <div><dt className="inline text-gray-500">الصفحة: </dt><dd className="inline">{r.page ?? '—'}</dd></div>
            <div><dt className="inline text-gray-500">نوع الطلب: </dt><dd className="inline">{r.request_type ?? '—'}</dd></div>
            <div><dt className="inline text-gray-500">رقم الطلب: </dt><dd className="inline font-mono" dir="ltr">{r.reference_number}</dd></div>
            <div><dt className="inline text-gray-500">مقدّم الطلب: </dt><dd className="inline">{r.requested_by}</dd></div>
            <div><dt className="inline text-gray-500">حالة الطلب الآن: </dt><dd className="inline">{STATUS_LABELS[r.request_status]}</dd></div>
          </dl>
          <p className="text-xs text-gray-500">تأكد أن الاسم والتاريخ ورقم الطلب على الورقة تطابق ما يظهر هنا.</p>
        </Card>
      )}
    </div>
  );
}
