// Collects every reference image id we'd reasonably want attached to a
// storyboard frame slot given its scene context (the beat + characters_in_scene).
// Used in two places:
//   1. The AI generation pipeline, after a row is created, to pre-populate
//      BOTH per-frame reference lists (start_frame_reference_ids and
//      end_frame_reference_ids) so the freshly-rendered row's reference
//      grids in the SPA aren't empty.
//   2. The POST /storyboard/:id/frame/:frameId/reference/auto-populate
//      endpoint, which the SPA's per-frame "Auto-suggest" button calls when
//      the user wants to re-pull references after editing the row's
//      characters_in_scene.
//
// Both paths use the same helper to keep the aggregation logic in one place.
// Returns the deduped final list plus the `added` delta (what would be added
// on top of `existingIds`), so callers can report "N references added".

import { logger } from '../log.js';
import { getCharacter } from '../mongo/characters.js';
import { stripMarkdown } from '../util/markdown.js';

function pushId(seen, out, raw) {
  if (!raw) return;
  const key = String(raw);
  if (seen.has(key)) return;
  seen.add(key);
  out.push(key);
}

function defaultSheetIdFor(c) {
  if (Array.isArray(c?.character_sheet_image_ids) && c.character_sheet_image_ids.length) {
    return c.character_sheet_image_ids[0];
  }
  return c?.character_sheet_image_id || null;
}

// The single signature image we'd lead with for a character: default sheet,
// else main portrait, else their first attached image.
function canonicalImageIdFor(c) {
  return defaultSheetIdFor(c) || c?.main_image_id || c?.images?.[0]?._id || null;
}

export async function collectStoryboardReferenceIds({
  projectId,
  beat,
  charactersInScene,
  existingIds = [],
}) {
  const seen = new Set();
  const ids = [];

  // Resolve the in-scene characters once, preserving order and skipping
  // unknowns, so both seeding rounds below work off the same resolved list.
  const chars = [];
  for (const raw of charactersInScene || []) {
    const stripped = stripMarkdown(raw || '').trim();
    if (!stripped) continue;
    let c = null;
    try {
      c = await getCharacter(projectId, stripped);
    } catch (e) {
      logger.warn(
        `storyboard refs: character lookup "${stripped}" failed: ${e.message}`,
      );
      continue;
    }
    if (!c) {
      logger.warn(`storyboard refs: unknown character "${stripped}" — skipped`);
      continue;
    }
    chars.push(c);
  }

  // Round 1 — canonical: the beat set image, then one signature image per
  // character. Frame generation only consumes the first N references, so this
  // guarantees every linked character is represented even before the user
  // prunes the list down.
  if (beat?.main_image_id) {
    pushId(seen, ids, beat.main_image_id);
  }
  for (const c of chars) {
    pushId(seen, ids, canonicalImageIdFor(c));
  }

  // Round 2 — remainder: the rest of the beat images, then each character's
  // full set (default sheet, all sheets, main portrait, every image) for the
  // user to prune down. Dedupe via `seen` drops anything already added above.
  if (beat) {
    for (const img of beat.images || []) {
      pushId(seen, ids, img?._id);
    }
  }
  for (const c of chars) {
    pushId(seen, ids, defaultSheetIdFor(c));
    for (const sid of c.character_sheet_image_ids || []) {
      pushId(seen, ids, sid);
    }
    pushId(seen, ids, c.main_image_id);
    for (const img of c.images || []) {
      pushId(seen, ids, img?._id);
    }
  }

  // Compute the `added` delta vs. existingIds. We keep the full deduped list in
  // `ids` so callers can do either an append or a replace; the delta is just
  // informational.
  const existing = new Set((existingIds || []).map((x) => String(x)));
  const added = ids.filter((id) => !existing.has(id));

  return { ids, added };
}
