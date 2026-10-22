/**
 * المسودات — محلية على هذا الجهاز فقط ومغلّفة بالـKEK في IndexedDB (مخزن
 * `drafts`). لا تُرفع للخادم: مسودة على الخادم تحتاج مفتاحًا يقرؤه الخادم أو
 * تصميمًا آخر للمزامنة، وكلاهما خارج هذه المرحلة. المرفقات لا تُحفظ في المسودة.
 */
import { deleteRecord, getAllRecords, putRecord } from '../../crypto/keystore';
import { uuid4 } from '../../crypto/encoding';
import type { Classification, Priority } from './api';

export interface LocalDraft {
  id: string;
  to: string[];
  cc: string[];
  priority: Priority;
  classification: Classification;
  dueDate: string | null;
  subject: string;
  body: string;
  updated_at: string;
}

export function newDraftId(): string {
  return uuid4();
}

export function saveDraft(draft: Omit<LocalDraft, 'updated_at'>): Promise<void> {
  return putRecord('drafts', draft.id, { ...draft, updated_at: new Date().toISOString() });
}

export async function listDrafts(): Promise<LocalDraft[]> {
  const drafts = await getAllRecords<LocalDraft>('drafts');
  return drafts.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function getDraft(id: string): Promise<LocalDraft | undefined> {
  return (await listDrafts()).find((d) => d.id === id);
}

export function deleteDraft(id: string): Promise<void> {
  return deleteRecord('drafts', id);
}
