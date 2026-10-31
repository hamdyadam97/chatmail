import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserMinus, UserPlus } from 'lucide-react';
import { Button, Label, Spinner } from '../../shared/ui';
import { toUserMessage } from '../../shared/api';
import { useAuth } from '../auth/AuthContext';
import { addMembers, removeMembers, rosterUserIds } from '../../crypto/mls';
import { chatApi, type Conversation } from './api';

interface MemberManagerProps {
  conversation: Conversation;
}

/**
 * إدارة الأعضاء (للمسؤول في المحادثات الجماعية). قائمة الأعضاء الحاليين
 * تُشتق من roster المجموعة محليًا (`userId|deviceId`) لأن العقد لا يوفّر
 * GET للأعضاء — افتراض موثق لتنسيقه مع الـbackend.
 */
export function MemberManager({ conversation }: MemberManagerProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<number | string | null>(null);

  const { data: roster, isLoading } = useQuery({
    queryKey: ['roster', String(conversation.id)],
    queryFn: () => rosterUserIds(conversation),
  });

  const { data: directory } = useQuery({
    queryKey: ['directory-users'],
    queryFn: chatApi.listUsers,
    staleTime: 60_000,
  });

  const me = String(user!.id);
  const others = (roster ?? []).filter((id) => String(id) !== me);
  const candidates = (directory ?? []).filter(
    (u) => String(u.id) !== me && !others.map(String).includes(String(u.id)),
  );

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['roster', String(conversation.id)] });
    await queryClient.invalidateQueries({ queryKey: ['conversations'] });
  };

  const addMutation = useMutation({
    mutationFn: (userIds: Array<number | string>) => addMembers(conversation, userIds),
    onSuccess: () => {
      setPicking(false);
      setError(null);
      void invalidate();
    },
    onError: (err) => setError(toUserMessage(err, 'تعذر إضافة الأعضاء')),
  });

  const removeMutation = useMutation({
    mutationFn: (userIds: Array<number | string>) => removeMembers(conversation, userIds),
    onSuccess: () => {
      setConfirmRemove(null);
      setError(null);
      void invalidate();
    },
    onError: (err) => setError(toUserMessage(err, 'تعذر إزالة العضو')),
  });

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-gray-900">إدارة الأعضاء</h4>
        <Button variant="outline" size="sm" onClick={() => setPicking((v) => !v)}>
          <UserPlus className="h-4 w-4" />
          إضافة أعضاء
        </Button>
      </div>

      {isLoading && (
        <div className="flex justify-center py-3">
          <Spinner />
        </div>
      )}

      {!isLoading && (
        <ul className="space-y-1">
          {others.map((id) => {
            const known = directory?.find((u) => String(u.id) === String(id));
            return (
              <li key={String(id)} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm">
                <span>{known?.full_name ?? known?.username ?? `مستخدم ${id}`}</span>
                {confirmRemove === id ? (
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-red-600">تأكيد الإبطال من المحادثة؟</span>
                    <Button
                      variant="danger"
                      size="sm"
                      loading={removeMutation.isPending}
                      onClick={() => removeMutation.mutate([id])}
                    >
                      تأكيد
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(null)}>
                      تراجع
                    </Button>
                  </span>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(id)}>
                    <UserMinus className="h-4 w-4" />
                    إزالة
                  </Button>
                )}
              </li>
            );
          })}
          {others.length === 0 && <li className="text-sm text-gray-400">لا أعضاء آخرون بعد</li>}
        </ul>
      )}

      {picking && (
        <div className="mt-3 rounded-lg border border-gray-200 p-2">
          <Label>اختر من الدليل</Label>
          <div className="mt-1 max-h-40 space-y-1 overflow-y-auto">
            {candidates.length === 0 && <p className="text-sm text-gray-400">لا يوجد مستخدمون إضافيون</p>}
            {candidates.map((candidate) => (
              <button
                key={String(candidate.id)}
                type="button"
                className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-sm text-gray-700 hover:bg-gray-50"
                onClick={() => addMutation.mutate([/^\d+$/.test(String(candidate.id)) ? Number(candidate.id) : candidate.id])}
              >
                <span>{candidate.full_name ?? candidate.username ?? `مستخدم ${candidate.id}`}</span>
                <UserPlus className="h-4 w-4 text-primary-600" />
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
