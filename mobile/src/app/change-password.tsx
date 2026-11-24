/** إلزامي بعد أول دخول بكلمة مؤقتة: لا يُفتح غيره حتى تتغير. */
import { ChangePasswordForm } from '@/components/ChangePasswordForm';

export default function ForcedChangePasswordScreen() {
  return <ChangePasswordForm forced />;
}
