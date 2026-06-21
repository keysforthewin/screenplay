// Pick storyboard frame reference images by ranking a numbered catalog with a
// cheap text-only Anthropic call. The catalog mixes library artwork and the
// scene's characters; the model returns the catalog NUMBERS most useful for
// constructing the frame, which we map back to candidate ids. Failures (missing
// key, bad JSON, network) collapse to [] so generation is never blocked.

import { config } from '../config.js';
import { getAnthropic } from '../anthropic/client.js';
import { logger } from '../log.js';

const SELECTOR_MODEL = config.anthropic.enhancerModel || 'claude-haiku-4-5-20251001';

const SYSTEM = [
  'You select reference images that help an image model construct a storyboard frame.',
  'You are given a SCENE description and a numbered CATALOG of available images',
  '(library artwork plus characters who may appear).',
  'Return the catalog NUMBERS of the images most useful as visual references —',
  'locations, sets, props, and mood that match the scene, plus characters who appear in it.',
  'Prefer precision over recall. Omit images that are not clearly relevant.',
  'Respond with EXACTLY one line of compact JSON: {"ids": [<numbers>]}.',
  'Use only numbers that appear in the catalog. No markdown, no commentary.',
].join(' ');

function buildCatalogText(candidates) {
  return candidates
    .map((c, i) => {
      const kind = c.kind === 'char' ? 'CHARACTER' : 'ARTWORK';
      const desc = c.description ? ` — ${c.description}` : '';
      return `${i + 1}. [${kind}] ${c.name}${desc}`;
    })
    .join('\n');
}

// Parse {"ids":[...]} into validated, deduped, in-range 1-based indices.
function safeParseIndices(text, count) {
  if (typeof text !== 'string') return null;
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const obj = JSON.parse(stripped);
    if (!obj || !Array.isArray(obj.ids)) return null;
    const seen = new Set();
    const out = [];
    for (const raw of obj.ids) {
      const idx = Number(raw);
      if (!Number.isInteger(idx) || idx < 1 || idx > count) continue;
      if (seen.has(idx)) continue;
      seen.add(idx);
      out.push(idx);
    }
    return out;
  } catch {
    return null;
  }
}

export async function selectFrameReferences({ sceneText, candidates, max = 6 }) {
  if (!config.anthropic?.apiKey) return [];
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const scene = String(sceneText || '').trim();
  if (!scene) return [];

  const userText = [
    `SCENE:\n${scene}`,
    '',
    `CATALOG:\n${buildCatalogText(candidates)}`,
    '',
    `Return at most ${max} item numbers as {"ids": [...]}.`,
  ].join('\n');

  const t0 = Date.now();
  try {
    const client = getAnthropic();
    const resp = await client.messages.create({
      model: SELECTOR_MODEL,
      max_tokens: 300,
      system: SYSTEM,
      messages: [{ role: 'user', content: userText }],
    });
    const text = (resp.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const indices = safeParseIndices(text, candidates.length);
    if (!indices) {
      logger.warn(`selectFrameReferences: parse failed (${Date.now() - t0}ms)`);
      return [];
    }
    return indices.slice(0, max).map((i) => candidates[i - 1].id);
  } catch (e) {
    logger.warn(`selectFrameReferences: ${e.message} (${Date.now() - t0}ms)`);
    return [];
  }
}
