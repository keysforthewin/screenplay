// Auto-select reference images for a storyboard frame. Builds a candidate
// catalog from the project's library artwork plus the portraits of the
// characters tagged in the shot, asks the LLM selector to pick the most useful
// ones, and persists them onto the frame via the gateway so they show up in the
// SPA for review. Only fills frames that have no references yet; never throws.

import { logger } from '../log.js';
import { listLibraryImages, imageFileToMeta } from '../mongo/images.js';
import { getCharacter } from '../mongo/characters.js';
import { stripMarkdown } from '../util/markdown.js';
import { selectFrameReferences } from '../llm/frameReferenceSelector.js';
import { setStoryboardFrameReferenceImagesViaGateway } from './gateway.js';

export const AUTO_REFERENCE_MAX = 6;
export const CATALOG_MAX = 120;

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

// Number of candidate name/description tokens that also appear in the scene.
function overlapScore(candidate, sceneTokens) {
  const tokens = new Set([...tokenize(candidate.name), ...tokenize(candidate.description)]);
  let n = 0;
  for (const t of tokens) if (sceneTokens.has(t)) n += 1;
  return n;
}

export async function buildFrameReferenceCandidates({ projectId, sb, sceneText = '' }) {
  const candidates = [];

  // Library artwork — drop entries with no text signal for the selector.
  let files = [];
  try {
    files = await listLibraryImages(projectId);
  } catch (e) {
    logger.warn(`frameReferences: listLibraryImages failed: ${e.message}`);
  }
  for (const f of files) {
    const m = imageFileToMeta(f);
    const name = (m.name || '').trim();
    const description = (m.description || '').trim();
    if (!name && !description) continue;
    candidates.push({ id: String(m._id), kind: 'art', name, description });
  }

  // Scene characters — include each tagged character's portrait if it has one.
  const names = Array.isArray(sb?.characters_in_scene) ? sb.characters_in_scene : [];
  const seen = new Set();
  for (const raw of names) {
    const nm = stripMarkdown(String(raw || '')).trim();
    const key = nm.toLowerCase();
    if (!nm || seen.has(key)) continue;
    seen.add(key);
    let ch = null;
    try {
      ch = await getCharacter(projectId, nm);
    } catch (e) {
      logger.warn(`frameReferences: getCharacter(${nm}) failed: ${e.message}`);
    }
    if (!ch || !ch.main_image_id) continue;
    candidates.push({ id: String(ch.main_image_id), kind: 'char', name: nm, description: '' });
  }

  // Scaling guard: keep the catalog bounded, preferring scene-text matches.
  if (candidates.length > CATALOG_MAX) {
    const sceneTokens = new Set(tokenize(sceneText));
    logger.info(`frameReferences: catalog ${candidates.length} > ${CATALOG_MAX}, trimming`);
    return candidates
      .map((c, i) => ({ c, i, s: overlapScore(c, sceneTokens) }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, CATALOG_MAX)
      .map((x) => x.c);
  }
  return candidates;
}

export async function autoFillFrameReferencesIfEmpty({
  projectId,
  sb,
  frame,
  sceneText,
  autoReferences = true,
}) {
  if (!autoReferences) return [];
  if ((frame?.reference_ids || []).length > 0) return [];
  try {
    const candidates = await buildFrameReferenceCandidates({ projectId, sb, sceneText });
    if (!candidates.length) return [];
    const ids = await selectFrameReferences({ sceneText, candidates, max: AUTO_REFERENCE_MAX });
    if (!ids.length) return [];
    await setStoryboardFrameReferenceImagesViaGateway({
      projectId,
      storyboardId: sb._id,
      frameId: frame._id,
      imageIds: ids,
      mode: 'replace',
    });
    frame.reference_ids = ids; // existing load step in regen picks these up
    return ids;
  } catch (e) {
    logger.warn(`frameReferences: auto-fill failed for frame ${frame?._id}: ${e.message}`);
    return [];
  }
}
