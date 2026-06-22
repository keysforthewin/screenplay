// Auto-select reference images for a storyboard frame. Builds a candidate
// pool from the beat's own artwork plus each scene character's full image set,
// asks the LLM selector to pick the most useful ones, and persists them onto
// the frame via the gateway so they show up in the SPA for review. Only fills
// frames that have no references yet; never throws.

import { logger } from '../log.js';
import { listImagesForBeat, imageFileToMeta } from '../mongo/images.js';
import { stripMarkdown } from '../util/markdown.js';
import { scoreFrameReferences } from '../llm/frameReferenceSelector.js';
import { setStoryboardFrameReferenceImagesViaGateway } from './gateway.js';
import { gatherCharacterReferenceCandidates } from './referenceSelector.js';
import { maxReferenceImagesFor } from './imageModelInfo.js';

export const AUTO_REFERENCE_MAX = 6;
export const PER_SOURCE_MAX = 2;
export const RELEVANCE_THRESHOLD = 0.5;
// Hard ceiling on how many reference images we attach to one generation,
// regardless of the model's own (often higher) cap. The effective send count is
// min(MAX_ATTACHED_REFERENCE_IMAGES, model cap), always the highest-scored.
export const MAX_ATTACHED_REFERENCE_IMAGES = 8;

// Map selected reference ids -> relevance score, so the generation step can
// order references best-first without re-scoring. `scores` is the 1-based index
// Map from scoreFrameReferences; a candidate id appearing in multiple sources
// keeps its highest score. Ids with no finite score are omitted.
export function referenceScoresForIds({ candidates, scores, ids }) {
  const byId = new Map();
  (candidates || []).forEach((c, i) => {
    const s = scores?.get?.(i + 1);
    if (!Number.isFinite(s)) return;
    const key = String(c.id);
    const prev = byId.get(key);
    byId.set(key, prev == null ? s : Math.max(prev, s));
  });
  const out = {};
  for (const id of ids || []) {
    const s = byId.get(String(id));
    if (Number.isFinite(s)) out[String(id)] = s;
  }
  return out;
}

// Order reference ids best-first by their persisted relevance score (descending,
// stable for ties), then cap to maxTotal. Unscored ids sort after every scored
// id (in their original order) and are the first dropped when over the cap.
// Pure; ids pass through unchanged (ObjectId or hex string).
export function orderReferenceIdsByScore({
  referenceIds,
  referenceScores = {},
  maxTotal = Infinity,
}) {
  const scoreOf = (id) => {
    const s = referenceScores?.[String(id)];
    return Number.isFinite(s) ? s : -Infinity;
  };
  const ordered = (referenceIds || [])
    .map((id, i) => ({ id, i, s: scoreOf(id) }))
    .sort((a, b) => (a.s === b.s ? a.i - b.i : b.s - a.s))
    .map((x) => x.id);
  return Number.isFinite(maxTotal) ? ordered.slice(0, maxTotal) : ordered;
}

export async function buildFrameReferenceCandidates({ projectId, sb, frameText = '' }) {
  const candidates = [];

  // Beat artwork — every GridFS image owned by this beat, including the beat's
  // main image. Tagged source 'beat' / kind 'art'.
  try {
    const beatId = sb?.beat_id ? String(sb.beat_id) : null;
    if (beatId) {
      const files = await listImagesForBeat(projectId, beatId);
      const seen = new Set();
      for (const f of files) {
        const m = imageFileToMeta(f);
        const id = String(m._id);
        if (seen.has(id)) continue;
        seen.add(id);
        candidates.push({
          id,
          kind: 'art',
          source: 'beat',
          name: (m.name || '').trim() || 'beat artwork',
          description: (m.description || '').trim(),
        });
      }
    }
  } catch (e) {
    logger.warn(`frameReferences: beat artwork load failed: ${e.message}`);
  }

  // Scene characters — full image set per character (sheets -> main -> attached),
  // each character tagged with its own source name. Reuses the referenceSelector
  // gatherer so candidate ordering matches the rest of the selection pipeline.
  try {
    const names = Array.isArray(sb?.characters_in_scene) ? sb.characters_in_scene : [];
    const perChar = await gatherCharacterReferenceCandidates(projectId, names);
    for (const entry of perChar) {
      const source = stripMarkdown(entry.name || '').trim();
      if (!source) continue;
      for (const cand of entry.candidates || []) {
        const desc = [cand.description, cand.caption].filter(Boolean).join(' — ');
        candidates.push({
          id: String(cand.id),
          kind: 'char',
          source,
          name: cand.name || source,
          description: desc,
        });
      }
    }
  } catch (e) {
    logger.warn(`frameReferences: character candidates failed: ${e.message}`);
  }

  return candidates;
}

// Pure selection: group candidates by source, keep top PER_SOURCE_MAX above
// RELEVANCE_THRESHOLD; guarantee >=1 per character source (best-scored, even
// below threshold); beat source is threshold-only. Then clamp to maxTotal,
// dropping lowest-scored first while preserving character guarantees.
export function selectScoredFrameReferences({ candidates, scores, maxTotal }) {
  const scoreOf = (i) => (scores.get(i + 1) ?? 0);
  const bySource = new Map();
  candidates.forEach((c, i) => {
    if (!bySource.has(c.source)) bySource.set(c.source, []);
    bySource.get(c.source).push({ c, score: scoreOf(i) });
  });

  const picks = []; // { id, score, guaranteed }
  for (const [source, items] of bySource) {
    items.sort((a, b) => b.score - a.score);
    const isChar = items.some((it) => it.c.kind === 'char') || source !== 'beat';
    const above = items.filter((it) => it.score >= RELEVANCE_THRESHOLD).slice(0, PER_SOURCE_MAX);
    if (above.length) {
      for (const it of above) picks.push({ id: it.c.id, score: it.score, guaranteed: false });
    } else if (isChar && items.length) {
      // character guarantee — include the single best even if below threshold
      picks.push({ id: items[0].c.id, score: items[0].score, guaranteed: true });
    }
  }

  // Dedupe by id, keeping the highest score / guaranteed flag.
  const byId = new Map();
  for (const p of picks) {
    const prev = byId.get(p.id);
    if (!prev || p.score > prev.score || (p.guaranteed && !prev.guaranteed)) {
      byId.set(p.id, {
        ...p,
        score: Math.max(p.score, prev?.score ?? 0),
        guaranteed: !!(p.guaranteed || prev?.guaranteed),
      });
    }
  }
  let kept = [...byId.values()];

  // Clamp: sort guaranteed-first then by score desc, take maxTotal.
  if (Number.isFinite(maxTotal) && kept.length > maxTotal) {
    kept.sort((a, b) =>
      (b.guaranteed - a.guaranteed) || (b.score - a.score));
    kept = kept.slice(0, maxTotal);
  }
  // Final order: guaranteed-first then by score desc.
  kept.sort((a, b) => (b.guaranteed - a.guaranteed) || (b.score - a.score));
  return kept.map((p) => p.id);
}

// Deterministic fallback when scoring yields nothing usable: first beat artwork
// + first candidate of each character source, clamped to maxTotal.
function fallbackReferenceIds({ candidates, maxTotal }) {
  const out = [];
  const seenSource = new Set();
  for (const c of candidates) {
    if (seenSource.has(c.source)) continue;
    seenSource.add(c.source);
    out.push(c.id);
  }
  const cap = Number.isFinite(maxTotal) ? maxTotal : out.length;
  return out.slice(0, cap);
}

export async function autoFillFrameReferencesIfEmpty({
  projectId,
  sb,
  frame,
  frameText,
  autoReferences = true,
  imageModel = null,
}) {
  if (!autoReferences) return [];
  if ((frame?.reference_ids || []).length > 0) return [];
  try {
    const text = String(frameText || '').trim();
    const candidates = await buildFrameReferenceCandidates({ projectId, sb, frameText: text });
    if (!candidates.length) return [];
    const scores = await scoreFrameReferences({ frameText: text, candidates });
    const maxTotal = maxReferenceImagesFor(imageModel);
    let ids = selectScoredFrameReferences({ candidates, scores, maxTotal });
    if (!ids.length) {
      // Fallback: first candidate of each source, clamped.
      ids = fallbackReferenceIds({ candidates, maxTotal });
    }
    if (!ids.length) return [];
    await setStoryboardFrameReferenceImagesViaGateway({
      projectId,
      storyboardId: sb._id,
      frameId: frame._id,
      imageIds: ids,
      mode: 'replace',
      scores: referenceScoresForIds({ candidates, scores, ids }),
    });
    frame.reference_ids = ids;
    return ids;
  } catch (e) {
    logger.warn(`frameReferences: auto-fill failed for frame ${frame?._id}: ${e.message}`);
    return [];
  }
}
