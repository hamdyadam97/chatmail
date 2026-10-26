/**
 * فهرس بحث محلي في الذاكرة فقط (§17). لا يُكتب الفهرس إلى أي تخزين: يُبنى من
 * السجلات المفكوكة المخزنة مغلّفة بالـKEK في IndexedDB، ويُرمى عند إغلاق
 * الصفحة. لا يمر أي نص أو مصطلح بحث عبر الخادم.
 *
 * وحدة نقية (بلا DOM/IndexedDB) — مختبرة بـ scripts/test-search-index.mjs.
 */

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;

/** توحيد عربي: حذف التشكيل والتطويل، توحيد الألف والياء والتاء المربوطة، وأرقام هندية → عربية. */
export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(DIACRITICS, '')
    .replace(TATWEEL, '')
    .replace(/[آأإٱ]/g, 'ا') // آ أ إ ٱ → ا
    .replace(/ى/g, 'ي') // ى → ي
    .replace(/ة/g, 'ه') // ة → ه
    .replace(/ؤ/g, 'و') // ؤ → و
    .replace(/ئ/g, 'ي') // ئ → ي
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLowerCase();
}

/** حروف/أرقام فقط؛ «ال» التعريف تُفهرس بالصيغتين (الموازنة + موازنه). */
export function tokenize(text: string): string[] {
  const words = normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (const w of words) {
    out.push(w);
    if (w.length > 4 && w.startsWith('ال')) out.push(w.slice(2));
  }
  return out;
}

export interface SearchDoc {
  id: string;
  kind: 'correspondence' | 'announcement' | 'chat' | 'external';
  title: string;
  body: string;
  /** سطر وصفي (رقم مرجعي، مرسل…) — مفهرس بوزن منخفض. */
  meta?: string;
  date?: string | null;
  link: string;
}

export interface SearchHit {
  doc: SearchDoc;
  score: number;
  snippet: string;
}

const FIELD_WEIGHT = { title: 3, body: 1, meta: 1 } as const;

export class SearchIndex {
  private docs = new Map<string, SearchDoc>();
  private postings = new Map<string, Map<string, number>>(); // token → docId → weight
  private sortedTokens: string[] | null = null;

  get size(): number {
    return this.docs.size;
  }

  add(doc: SearchDoc): void {
    if (this.docs.has(doc.id)) return;
    this.docs.set(doc.id, doc);
    for (const field of ['title', 'body', 'meta'] as const) {
      for (const token of tokenize(doc[field] ?? '')) {
        let posting = this.postings.get(token);
        if (!posting) {
          posting = new Map();
          this.postings.set(token, posting);
        }
        posting.set(doc.id, (posting.get(doc.id) ?? 0) + FIELD_WEIGHT[field]);
      }
    }
    this.sortedTokens = null;
  }

  /** الرموز التي تبدأ بالبادئة (بحث ثنائي في قائمة مرتبة). */
  private tokensWithPrefix(prefix: string): string[] {
    this.sortedTokens ??= [...this.postings.keys()].sort();
    const tokens = this.sortedTokens;
    let lo = 0;
    let hi = tokens.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tokens[mid] < prefix) lo = mid + 1;
      else hi = mid;
    }
    const out: string[] = [];
    for (let i = lo; i < tokens.length && tokens[i].startsWith(prefix); i++) out.push(tokens[i]);
    return out;
  }

  /** كل كلمات الاستعلام مطلوبة (AND)، والأخيرة كبادئة؛ الترتيب بالوزن ثم الأحدث. */
  search(query: string, limit = 50, kind?: SearchDoc['kind']): SearchHit[] {
    const terms = [...new Set(normalize(query).match(/[\p{L}\p{N}]+/gu) ?? [])];
    if (terms.length === 0) return [];
    let scores: Map<string, number> | null = null;
    terms.forEach((term, i) => {
      const isLast = i === terms.length - 1;
      const matching = isLast || term.length >= 3 ? this.tokensWithPrefix(term) : this.postings.has(term) ? [term] : [];
      const termScores = new Map<string, number>();
      for (const token of matching) {
        const exactBonus = token === term ? 1.5 : 1;
        for (const [docId, weight] of this.postings.get(token)!) {
          termScores.set(docId, Math.max(termScores.get(docId) ?? 0, weight * exactBonus));
        }
      }
      if (scores === null) {
        scores = termScores;
      } else {
        const next = new Map<string, number>();
        for (const [docId, score] of scores) {
          const s = termScores.get(docId);
          if (s !== undefined) next.set(docId, score + s);
        }
        scores = next;
      }
    });
    const hits: SearchHit[] = [];
    for (const [docId, score] of scores ?? new Map<string, number>()) {
      const doc = this.docs.get(docId)!;
      if (kind && doc.kind !== kind) continue;
      hits.push({ doc, score, snippet: snippet(doc.body || doc.title, terms) });
    }
    hits.sort((a, b) => b.score - a.score || (b.doc.date ?? '').localeCompare(a.doc.date ?? ''));
    return hits.slice(0, limit);
  }
}

/**
 * نص موحَّد مع خريطة لكل حرف إلى موضعه في الأصل — تُحذف الحركات فعلًا (فـ«مُدير»
 * تطابق «مدير»)، والخريطة تعيد مواضع التطابق إلى النص الأصلي للعرض.
 */
export function normalizedWithMap(text: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const n = normalize(text[i]);
    for (const c of n) {
      norm += c;
      map.push(i);
    }
  }
  return { norm, map };
}

function matchRanges(text: string, terms: string[]): Array<[number, number]> {
  const { norm, map } = normalizedWithMap(text);
  const ranges: Array<[number, number]> = [];
  for (const t of terms) {
    let from = 0;
    for (;;) {
      const i = norm.indexOf(t, from);
      if (i < 0) break;
      ranges.push([map[i], map[i + t.length - 1] + 1]);
      from = i + t.length;
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** مقتطف حول أول تطابق. */
export function snippet(text: string, terms: string[], radius = 70): string {
  const first = matchRanges(text, terms)[0];
  if (!first) return text.slice(0, radius * 2);
  const start = Math.max(0, first[0] - radius);
  const end = Math.min(text.length, first[1] + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** أجزاء لإبراز التطابقات دون innerHTML (حماية XSS). */
export function highlightParts(text: string, query: string): Array<{ text: string; match: boolean }> {
  const terms = [...new Set(normalize(query).match(/[\p{L}\p{N}]+/gu) ?? [])];
  const marks = new Array<boolean>(text.length).fill(false);
  for (const [a, b] of matchRanges(text, terms)) for (let k = a; k < b; k++) marks[k] = true;
  const parts: Array<{ text: string; match: boolean }> = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last.match === marks[i]) last.text += text[i];
    else parts.push({ text: text[i], match: marks[i] });
  }
  return parts;
}
