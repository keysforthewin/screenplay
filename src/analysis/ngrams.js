import { tokenize, isAllStopwords } from './tokenize.js';

export function ngrams(tokens, n) {
  if (!Array.isArray(tokens) || tokens.length < n || n < 1) return [];
  const out = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    out.push(tokens.slice(i, i + n).join(' '));
  }
  return out;
}

export function countNgrams(docs, ns = [2, 3, 4], opts = {}) {
  const minCount = opts.minCount === undefined ? 2 : opts.minCount;
  const sizes = (Array.isArray(ns) ? ns : [ns]).filter((n) => Number.isInteger(n) && n >= 1);

  const map = new Map();

  for (const doc of docs || []) {
    const tokens = tokenize(doc?.text || '');
    if (tokens.length === 0) continue;
    for (const n of sizes) {
      if (tokens.length < n) continue;
      const seenInDoc = new Set();
      for (let i = 0; i <= tokens.length - n; i++) {
        const slice = tokens.slice(i, i + n);
        if (isAllStopwords(slice)) continue;
        const gram = slice.join(' ');
        let entry = map.get(gram);
        if (!entry) {
          entry = { gram, n, count: 0, sources: [], _sourceIds: new Set() };
          map.set(gram, entry);
        }
        entry.count += 1;
        if (!seenInDoc.has(gram) && !entry._sourceIds.has(doc.id)) {
          entry._sourceIds.add(doc.id);
          entry.sources.push({ id: doc.id, label: doc.label });
          seenInDoc.add(gram);
        }
      }
    }
  }

  const out = [];
  for (const entry of map.values()) {
    if (entry.count < minCount) continue;
    out.push({
      gram: entry.gram,
      n: entry.n,
      count: entry.count,
      sources: entry.sources,
    });
  }
  out.sort((a, b) => b.count - a.count || b.n - a.n || a.gram.localeCompare(b.gram));
  return out;
}

export function topNgrams(counts, k = 30) {
  return (counts || []).slice(0, Math.max(0, k));
}
