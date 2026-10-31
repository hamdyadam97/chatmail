import { Card, CardContent, CardHeader, CardTitle } from '../../shared/ui';
import { APP_VERSION } from '../../shared/lib/appInfo';
import { MySecurityEvents } from '../audit/pages';

/** الأمان: نشاط حسابي (الدخول، كلمة المرور، MFA…) وإصدار التطبيق. */
export const Security = () => (
  <div className="mx-auto max-w-2xl space-y-4">
    <Card>
      <CardHeader>
        <CardTitle>الأمان</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-gray-600">
          بريدك ومحادثاتك محفوظة مشفّرة على الخادم، وتظهر لك من أي جهاز تدخل منه بحسابك. احمِ حسابك بكلمة مرور قوية
          وفعّل التحقق بخطوتين، وسجّل الخروج من الأجهزة المشتركة.
        </p>
        <div className="flex items-center justify-between border-t border-gray-100 pt-3">
          <span className="text-gray-600">إصدار التطبيق</span>
          <span dir="ltr" className="font-mono text-gray-800">
            v{APP_VERSION}
          </span>
        </div>
      </CardContent>
    </Card>
    <MySecurityEvents />
  </div>
);

export const SecurityPages = { Security };
