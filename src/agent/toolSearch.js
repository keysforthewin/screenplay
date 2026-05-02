import { TOOLS } from './tools.js';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'to', 'of', 'in', 'on',
  'at', 'for', 'with', 'about', 'and', 'or', 'but', 'if', 'this',
  'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you', 'your',
  'it', 'its', 'as', 'by', 'from', 'so', 'just', 'too', 'very',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might',
]);

export function tokenize(text) {
  if (text === null || text === undefined) return [];
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOPWORDS.has(t));
}

function termHit(qterm, tokens) {
  let best = 0;
  for (const t of tokens) {
    if (t === qterm) return 1.0;
    if (qterm.length >= 4 && t.startsWith(qterm)) best = Math.max(best, 0.8);
    else if (t.length >= 4 && qterm.startsWith(t)) best = Math.max(best, 0.6);
  }
  return best;
}

export function scoreTool(qTerms, tool) {
  if (!qTerms.length) return 0;
  const nameTokens = tokenize(tool.name);
  const descTokens = tokenize(tool.description);
  const kwTokens = tokenize(Array.isArray(tool.keywords) ? tool.keywords.join(' ') : '');
  let score = 0;
  for (const q of qTerms) {
    score += 3 * termHit(q, nameTokens);
    score += 2 * termHit(q, kwTokens);
    score += 1 * termHit(q, descTokens);
  }
  return score / Math.sqrt(qTerms.length);
}

export function searchTools(query, opts = {}) {
  const limit = Math.max(1, Math.min(25, opts.limit ?? 8));
  const minScore = opts.minScore ?? 0.5;
  const tools = opts.tools || TOOLS;
  const exclude = opts.exclude instanceof Set ? opts.exclude : new Set(opts.exclude || []);
  const qTerms = tokenize(query);
  if (!qTerms.length) return [];
  const scored = [];
  for (const tool of tools) {
    if (exclude.has(tool.name)) continue;
    const score = scoreTool(qTerms, tool);
    if (score >= minScore) scored.push({ name: tool.name, score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((s) => s.name);
}
