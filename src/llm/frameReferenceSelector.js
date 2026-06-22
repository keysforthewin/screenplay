// Score storyboard frame reference images with a cheap text-only Anthropic
// call. Given a frame description and a numbered CATALOG of candidate images
// (the beat's artwork plus the scene's characters), the model returns a
// per-candidate relevance score; src/web/frameReferences.js turns those scores
// into the actual per-source picks. Failures (missing key, bad JSON, network)
// collapse to an empty Map so generation is never blocked.

import { config } from '../config.js';
import { getAnthropic } from '../anthropic/client.js';
import { logger } from '../log.js';

const SELECTOR_MODEL = config.anthropic.enhancerModel || 'claude-haiku-4-5-20251001';

function buildCatalogText(candidates) {
  return candidates
    .map((c, i) => {
      const kind = c.kind === 'char' ? 'CHARACTER' : 'ARTWORK';
      const desc = c.description ? ` — ${c.description}` : '';
      return `${i + 1}. [${kind}] ${c.name}${desc}`;
    })
    .join('\n');
}


// ---------------------------------------------------------------------------
// Relevance scorer — scores each candidate 0..1 for usefulness as a reference
// for a specific frame. Used by the new beat+character selection in
// src/web/frameReferences.js. Same graceful-failure contract as the picker:
// any problem yields an empty Map so generation is never blocked.
// ---------------------------------------------------------------------------

const SCORE_SYSTEM = [
  'You score reference images for usefulness in constructing ONE storyboard frame.',
  'You are given the FRAME description and a numbered CATALOG of available images',
  '(the scene/beat artwork plus characters who may appear).',
  'For EACH catalog number, output a relevance score from 0.0 to 1.0:',
  'high for locations, sets, props, mood, and characters that clearly match THIS frame;',
  'low for images that are unrelated. Be discriminating — do not give everything a high score.',
  'Respond with EXACTLY one line of compact JSON: {"scores":[{"n":<number>,"score":<0..1>}]}.',
  'Include every catalog number exactly once. No markdown, no commentary.',
].join(' ');

// Parse {"scores":[{"n":N,"score":S}]} into a Map<number, number> with N in
// [1,count] and S clamped to [0,1]. Returns null on any structural problem.
function safeParseScores(text, count) {
  if (typeof text !== 'string') return null;
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const obj = JSON.parse(stripped);
    if (!obj || !Array.isArray(obj.scores)) return null;
    const out = new Map();
    for (const row of obj.scores) {
      const n = Number(row?.n);
      let s = Number(row?.score);
      if (!Number.isInteger(n) || n < 1 || n > count) continue;
      if (!Number.isFinite(s)) continue;
      if (s < 0) s = 0;
      if (s > 1) s = 1;
      out.set(n, s);
    }
    return out;
  } catch {
    return null;
  }
}

let scorerOverride = null;
export function _setFrameReferenceScorerForTests(fn) {
  scorerOverride = fn;
}

export async function scoreFrameReferences({ frameText, candidates }) {
  if (!Array.isArray(candidates) || candidates.length === 0) return new Map();
  const frame = String(frameText || '').trim();
  if (!frame) return new Map();
  if (scorerOverride) {
    try {
      const m = await scorerOverride({ frameText: frame, candidates });
      return m instanceof Map ? m : new Map();
    } catch {
      return new Map();
    }
  }
  if (!config.anthropic?.apiKey) return new Map();

  const userText = [
    `FRAME:\n${frame}`,
    '',
    `CATALOG:\n${buildCatalogText(candidates)}`,
    '',
    'Score every catalog number as {"scores":[{"n":N,"score":S}]}.',
  ].join('\n');

  const t0 = Date.now();
  try {
    const client = getAnthropic();
    const resp = await client.messages.create({
      model: SELECTOR_MODEL,
      max_tokens: 600,
      system: SCORE_SYSTEM,
      messages: [{ role: 'user', content: userText }],
    });
    const text = (resp.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const scores = safeParseScores(text, candidates.length);
    if (!scores) {
      logger.warn(`scoreFrameReferences: parse failed (${Date.now() - t0}ms)`);
      return new Map();
    }
    return scores;
  } catch (e) {
    logger.warn(`scoreFrameReferences: ${e.message} (${Date.now() - t0}ms)`);
    return new Map();
  }
}
