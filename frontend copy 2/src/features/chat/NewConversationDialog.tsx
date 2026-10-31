import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Button, Input, Label, Spinner } from '../../shared/ui';
import { toUserMessage } from '../../shared/api';
import { useAuth } from '../auth/AuthContext';
import { createConversation } from '../../crypto/mls';
import { chatApi, type Conversation } from './api';

interface NewConversationDialogProps {
  type: 'dm' | 'group';
  onClose: () => void;
  onCreated: (conversation: Conversation) => void;
}

/** حوار محادثة جديدة: اختيار مستخدمين من دليل /users/ (+عنوان للجماعية). */
export function NewConversationDialog({ type, onClose, onCreated }: NewConversationDialogProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: users, isLoading } = useQuery({
    queryKey: ['directory-users'],
    queryFn: chatApi.listUsers,
    staleTime: 60_000,
  });

  const candidates = useMemo(
    () => (users ?? []).filter((u) => String(u.id) !== String(user!.id)),
    [users, user],
  );

  const mutation = useMutation({
    mutationFn: () => {
      if (type === 'dm' && selected.size !== 1) {
        return Promise.reject(new Error('المحادثة المباشرة تتطلب مستخدمًا واحدًا بالضبط'));
      }
      if (type === 'group' && selected.size < 1) {
        return Promise.reject(new Error('اختر عضوًا واحدًا على الأقل'));
      }
      const memberIds = [...selected] as Array<number | string>;
      const numeric = memberIds.map((id) => (/^\d+$/.test(String(id)) ? Number(id) : id));
      return createConversation({
        type,
        memberUserIds: numeric,
        title: type === 'group' ? title.trim() || undefined : undefined,
      });
    },
    onSuccess: async (conversation) => {
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
      onCreated(conversation);
    },
    onError: (err) => setError(toUserMessage(err, 'تعذر إنشاء المحادثة')),
  });

  const toggle = (id: number | string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = String(id);
      if (type === 'dm') {
        return next.has(key) ? new Set() : new Set([key]);
      }
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900">
            {type === 'dm' ? 'محادثة مباشرة جديدة' : 'محادثة جماعية جديدة'}
          </h3>
          <button type="button" onClick={onClose} aria-label="إغلاق" className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        {type === 'group' && (
          <div className="mb-3">
            <Label htmlFor="group-title">عنوان المحادثة (يُخزن مشفّرًا)</Label>
            <Input
              id="group-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="مثلًا: فريق المشروع"
              autoComplete="off"
            />
          </div>
        )}

        <Label>الأعضاء</Label>
        <div className="mt-1 max-h-64 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-2">
          {isLoading && (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          )}
          {!isLoading && candidates.length === 0 && (
            <p className="py-4 text-center text-sm text-gray-400">لا مستخدمون متاحون في الدليل</p>
          )}
          {candidates.map((candidate) => (
            <label
              key={String(candidate.id)}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              <input
                type={type === 'dm' ? 'radio' : 'checkbox'}
                name="member"
                checked={selected.has(String(candidate.id))}
                onChange={() => toggle(candidate.id)}
                className="h-4 w-4 accent-primary-600"
              />
              <span>{candidate.full_name ?? candidate.username ?? `مستخدم ${candidate.id}`}</span>
              {candidate.full_name && candidate.username && (
                <span className="text-xs text-gray-400">({candidate.username})</span>
              )}
            </label>
          ))}
        </div>

        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button onClick={() => mutation.mutate()} loading={mutation.isPending}>
            إنشاء المحادثة
          </Button>
        </div>
      </div>
    </div>
  );
}
