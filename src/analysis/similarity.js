import { tokenizeFiltered } from './tokenize.js';

export function bagOfWords(text) {
  const map = new Map();
  for (const tok of tokenizeFiltered(text)) {
    map.set(tok, (map.get(tok) || 0) + 1);
  }
  return map;
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const v of a.values()) normA += v * v;
  for (const v of b.values()) normB += v * v;
  if (normA === 0 || normB === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [k, v] of small) {
    const w = large.get(k);
    if (w) dot += v * w;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function bagFromText(text) {
  return text ? bagOfWords(text) : new Map();
}

export function rankSimilar(target, corpus, opts = {}) {
  const threshold = opts.threshold === undefined ? 0.6 : opts.threshold;
  const excludeId = opts.excludeId || null;

  const targetBag = target?.tokens
    ? target.tokens
    : bagFromText(target?.text || '');
  if (targetBag.size === 0) return [];

  const out = [];
  for (const item of corpus || []) {
    if (excludeId && item.id === excludeId) continue;
    const fieldNames = Object.keys(item.fields || {});
    const fieldScores = {};
    let bestScore = 0;
    let bestField = null;

    const concatParts = [];
    for (const fname of fieldNames) {
      const txt = item.fields[fname];
      if (!txt) {
        fieldScores[fname] = 0;
        continue;
      }
      const fbag = bagOfWords(txt);
      const s = cosineSimilarity(targetBag, fbag);
      fieldScores[fname] = s;
      if (s > bestScore) {
        bestScore = s;
        bestField = fname;
      }
      concatParts.push(txt);
    }

    if (concatParts.length > 1) {
      const concatBag = bagOfWords(concatParts.join('\n'));
      const concatScore = cosineSimilarity(targetBag, concatBag);
      if (concatScore > bestScore) {
        bestScore = concatScore;
        bestField = '_concat';
      }
    }

    if (bestScore >= threshold) {
      out.push({
        id: item.id,
        label: item.label,
        score: bestScore,
        matched_field: bestField,
        field_scores: fieldScores,
      });
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}
