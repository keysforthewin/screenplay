// Auto-select reference images for a storyboard frame. Builds a candidate
// pool from the beat's own artwork plus each scene character's full image set,
// asks the LLM selector to pick the most useful ones, and persists them onto
// the frame via the gateway so they show up in the SPA for review. Only fills
// frames that have no references yet; never throws.

import { logger } from '../log.js';
import { listImagesForBeat, imageFileToMeta } from '../mongo/images.js';
import { stripMarkdown } from '../util/markdown.js';
import { selectFrameReferences } from '../llm/frameReferenceSelector.js';
import { setStoryboardFrameReferenceImagesViaGateway } from './gateway.js';
import { gatherCharacterReferenceCandidates } from './referenceSelector.js';

export const AUTO_REFERENCE_MAX = 6;
export const PER_SOURCE_MAX = 2;
export const RELEVANCE_THRESHOLD = 0.5;

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
    const candidates = await buildFrameReferenceCandidates({ projectId, sb, frameText: sceneText });
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
