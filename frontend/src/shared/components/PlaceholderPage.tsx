import { Construction } from 'lucide-react';
import { EmptyState } from '../ui/empty-state';

export function PlaceholderPage({ title }: { title: string }) {
  return (
    <EmptyState
      icon={Construction}
      title={title}
      description="هذه الصفحة قيد التنفيذ"
      className="mt-8"
    />
  );
}
