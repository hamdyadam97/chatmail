/**
 * اختبارات وحدة لفهرس البحث المحلي (src/features/search/searchIndex.ts).
 * التشغيل: node scripts/test-search-index.mjs   (Node ≥ 22.18 يجرّد أنواع TS)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SearchIndex, highlightParts, normalize, snippet, tokenize } from '../src/features/search/searchIndex.ts';

test('توحيد عربي: تشكيل، همزات، تاء مربوطة، ألف مقصورة، أرقام هندية', () => {
  assert.equal(normalize('مُدِيرُ الإدارةِ'), 'مدير الاداره');
  assert.equal(normalize('أإآ مستشفى'), 'ااا مستشفي');
  assert.equal(normalize('رقم ١٢٣ و ۴۵'), 'رقم 123 و 45');
  assert.equal(normalize('مـــرحبا'), 'مرحبا');
});

test('«ال» التعريف تُفهرس بالصيغتين', () => {
  assert.deepEqual(tokenize('الموازنة'), ['الموازنه', 'موازنه']);
});

function sample() {
  const idx = new SearchIndex();
  idx.add({ id: 'c1', kind: 'correspondence', title: 'طلب صرف مستلزمات', body: 'نرجو اعتماد صرف المبلغ للمختبر', date: '2026-10-01', link: '/correspondence/c1' });
  idx.add({ id: 'c2', kind: 'correspondence', title: 'الموازنة السنوية', body: 'مسودة الموازنة مرفقة للمراجعة', date: '2026-10-05', link: '/correspondence/c2' });
  idx.add({ id: 'a1', kind: 'announcement', title: 'تعميم الدوام', body: 'يبدأ الدوامُ الرسميُّ الساعة ٧:٣٠ صباحًا', date: '2026-09-20', link: '/announcements/a1' });
  idx.add({ id: 'm1', kind: 'chat', title: '', body: 'هل وصلك طلب الصرف؟', date: '2026-10-06', link: '/direct-messages' });
  return idx;
}

test('AND بين الكلمات، والأخيرة بادئة', () => {
  const idx = sample();
  assert.deepEqual(idx.search('طلب صرف').map((h) => h.doc.id).sort(), ['c1', 'm1']);
  assert.deepEqual(idx.search('طلب مستل').map((h) => h.doc.id), ['c1']);
  assert.deepEqual(idx.search('صرف موازنة'), []);
});

test('مطابقة دون تشكيل/همزات/«ال»', () => {
  const idx = sample();
  assert.deepEqual(idx.search('موازنه').map((h) => h.doc.id), ['c2']);
  assert.deepEqual(idx.search('الدوام الرسمي').map((h) => h.doc.id), ['a1']);
  assert.deepEqual(idx.search('7').map((h) => h.doc.id), ['a1']); // أرقام هندية في النص
});

test('العنوان يرجح على النص، والتصفية بالنوع', () => {
  const idx = sample();
  const hits = idx.search('صرف');
  assert.equal(hits[0].doc.id, 'c1');
  assert.deepEqual(idx.search('صرف', 50, 'chat').map((h) => h.doc.id), ['m1']);
});

test('المقتطف والإبراز يعملان على النص الأصلي المشكول', () => {
  const text = 'يبدأ الدوامُ الرسميُّ الساعة ٧:٣٠';
  assert.ok(snippet(text, ['الرسمي']).includes('الرسميُّ'));
  const parts = highlightParts(text, 'الرسمي');
  const marked = parts.filter((p) => p.match).map((p) => p.text).join('');
  assert.ok(marked.startsWith('الرسمي'), marked);
  assert.equal(parts.map((p) => p.text).join(''), text); // لا يضيع حرف
});

test('لا نتائج لاستعلام فارغ أو رموز فقط', () => {
  const idx = sample();
  assert.deepEqual(idx.search(''), []);
  assert.deepEqual(idx.search('؟!'), []);
});
