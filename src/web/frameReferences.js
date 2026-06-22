// Auto-select reference images for a storyboard frame. Builds a candidate
// pool from the beat's own artwork plus each scene character's artwork (the
// "Artwork" sections — NOT every reference image owned by the beat/character),
// asks the LLM selector to pick the most useful ones, and persists them onto
// the frame via the gateway so they show up in the SPA for review. Only fills
// frames that have no references yet; never throws.

import { logger } from '../log.js';
import { getBeat } from '../mongo/plots.js';
import { getCharacter } from '../mongo/characters.js';
import { stripMarkdown } from '../util/markdown.js';
import { scoreFrameReferences } from '../llm/frameReferenceSelector.js';
import { setStoryboardFrameReferenceImagesViaGateway } from './gateway.js';
import { maxReferenceImagesFor } from './imageModelInfo.js';

export const AUTO_REFERENCE_MAX = 6;
// Per-source floor: always keep the top-N scored candidates from each source
// (the beat, and each in-scene character), even when they fall below
// RELEVANCE_THRESHOLD. With one character that floor is 2 beat + 2 character = 4.
export const PER_SOURCE_MIN = 2;
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

// Pull the candidate metas from a host's `artworks[]` array — the "Artwork"
// section shown in the SPA. Only `done` artworks with a result image count;
// pending/error artworks and the host's plain reference images are excluded on
// purpose (those can still be added manually via the picker). Deduped by
// result_image_id. `prompt` becomes the candidate description for scoring.
function artworkCandidates(host, { kind, source }) {
  const out = [];
  const seen = new Set();
  for (const a of host?.artworks || []) {
    if (a?.status !== 'done' || !a.result_image_id) continue;
    const id = String(a.result_image_id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      kind,
      source,
      name: (a.name || '').trim() || (kind === 'char' ? source : 'beat artwork'),
      description: (a.prompt || '').trim(),
    });
  }
  return out;
}

export async function buildFrameReferenceCandidates({ projectId, sb, frameText = '' }) {
  const candidates = [];

  // Beat artwork — the beat's "Artwork" section (done artworks only), tagged
  // source 'beat' / kind 'art'. NOT every GridFS image owned by the beat:
  // storyboard frames and uploaded references are excluded so auto-suggest
  // scores only curated artwork.
  try {
    const beatId = sb?.beat_id ? String(sb.beat_id) : null;
    if (beatId) {
      const beat = await getBeat(projectId, beatId);
      candidates.push(...artworkCandidates(beat, { kind: 'art', source: 'beat' }));
    }
  } catch (e) {
    logger.warn(`frameReferences: beat artwork load failed: ${e.message}`);
  }

  // Scene characters — each in-scene character's own "Artwork" section (done
  // artworks only), tagged with the character's name as its source. Same
  // artwork-only rule as the beat: sheets/portraits/gallery are not auto-
  // suggested, only generated artworks.
  try {
    const names = Array.isArray(sb?.characters_in_scene) ? sb.characters_in_scene : [];
    for (const raw of names) {
      const nm = stripMarkdown(String(raw ?? '')).trim();
      if (!nm) continue;
      let c = null;
      try {
        c = await getCharacter(projectId, nm);
      } catch (e) {
        logger.warn(`frameReferences: character lookup "${nm}" failed: ${e.message}`);
        continue;
      }
      if (!c) continue;
      const source = stripMarkdown(c.name || nm).trim() || nm;
      candidates.push(...artworkCandidates(c, { kind: 'char', source }));
    }
  } catch (e) {
    logger.warn(`frameReferences: character candidates failed: ${e.message}`);
  }

  return candidates;
}

// Pure selection. For every source (the beat, and each in-scene character),
// guarantee the top PER_SOURCE_MIN scored candidates as a floor (kept even when
// below RELEVANCE_THRESHOLD), then add any further candidates from that source
// that clear RELEVANCE_THRESHOLD. So a one-character shot floors at 2 beat + 2
// character = 4, and high-scoring extras push above that. Finally dedupe by id
// and clamp to maxTotal, dropping the lowest-scored non-floor picks first.
export function selectScoredFrameReferences({ candidates, scores, maxTotal }) {
  const scoreOf = (i) => (scores.get(i + 1) ?? 0);
  const bySource = new Map();
  candidates.forEach((c, i) => {
    if (!bySource.has(c.source)) bySource.set(c.source, []);
    bySource.get(c.source).push({ c, score: scoreOf(i) });
  });

  const picks = []; // { id, score, guaranteed }
  for (const [, items] of bySource) {
    items.sort((a, b) => b.score - a.score);
    items.forEach((it, rank) => {
      const isFloor = rank < PER_SOURCE_MIN; // top-N from this source, always kept
      if (isFloor || it.score >= RELEVANCE_THRESHOLD) {
        picks.push({ id: it.c.id, score: it.score, guaranteed: isFloor });
      }
    });
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

// Shared shot-reference selection: build the artwork candidate pool, score it,
// and run the floored selection. Returns the chosen ids plus the candidates,
// raw scores, and the id->score map so callers can persist relevance and log
// diagnostics. Used by both the SPA auto-suggest endpoint and storyboard
// generation so the two paths produce identical results.
export async function selectFrameReferencesForShot({
  projectId,
  sb,
  frameText,
  imageModel = null,
  maxTotal = null,
}) {
  const text = String(frameText || '').trim();
  const candidates = await buildFrameReferenceCandidates({ projectId, sb, frameText: text });
  if (!candidates.length) {
    return { ids: [], candidates, scores: new Map(), referenceScores: {} };
  }
  const scores = await scoreFrameReferences({ frameText: text, candidates });
  // An explicit maxTotal lets the caller seed a generous list (e.g. storyboard
  // generation, which keeps the per-character floor for big ensembles and lets
  // render-time clamping trim best-first). Defaults to the model's edit cap.
  const cap = Number.isFinite(maxTotal) ? maxTotal : maxReferenceImagesFor(imageModel);
  let ids = selectScoredFrameReferences({ candidates, scores, maxTotal: cap });
  if (!ids.length && candidates.length) {
    // Defensive fallback: first candidate of each source, clamped. With the
    // per-source floor this only triggers in degenerate cases.
    ids = fallbackReferenceIds({ candidates, maxTotal: cap });
  }
  return {
    ids,
    candidates,
    scores,
    referenceScores: referenceScoresForIds({ candidates, scores, ids }),
  };
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
    const { ids, referenceScores } = await selectFrameReferencesForShot({
      projectId,
      sb,
      frameText,
      imageModel,
    });
    if (!ids.length) return [];
    await setStoryboardFrameReferenceImagesViaGateway({
      projectId,
      storyboardId: sb._id,
      frameId: frame._id,
      imageIds: ids,
      mode: 'replace',
      scores: referenceScores,
    });
    frame.reference_ids = ids;
    return ids;
  } catch (e) {
    logger.warn(`frameReferences: auto-fill failed for frame ${frame?._id}: ${e.message}`);
    return [];
  }
}
