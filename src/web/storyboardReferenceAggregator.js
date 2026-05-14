// Collects every reference image id we'd reasonably want attached to a
// storyboard frame slot given its scene context (the beat + characters_in_scene).
// Used in two places:
//   1. The AI generation pipeline, after a row is created, to pre-populate
//      BOTH per-frame reference lists (start_frame_reference_ids and
//      end_frame_reference_ids) so the freshly-rendered row's reference
//      grids in the SPA aren't empty.
//   2. The POST /storyboard/:id/frame/:role/reference/auto-populate
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

export async function collectStoryboardReferenceIds({
  beat,
  charactersInScene,
  existingIds = [],
}) {
  const seen = new Set();
  const ids = [];

  // 1. Beat images first — set/scene context. main_image_id usually appears
  //    inside images[] too; dedupe handles either order.
  if (beat) {
    for (const img of beat.images || []) {
      pushId(seen, ids, img?._id);
    }
    if (beat.main_image_id) {
      pushId(seen, ids, beat.main_image_id);
    }
  }

  // 2. Per-character images. Default sheet first (matches the single-character
  //    pin behavior at generation time), then the rest of the sheets, then the
  //    main portrait, then every other image attached to the character.
  for (const raw of charactersInScene || []) {
    const stripped = stripMarkdown(raw || '').trim();
    if (!stripped) continue;
    let c = null;
    try {
      c = await getCharacter(stripped);
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
    const defaultSheet = defaultSheetIdFor(c);
    pushId(seen, ids, defaultSheet);
    for (const sid of c.character_sheet_image_ids || []) {
      pushId(seen, ids, sid);
    }
    pushId(seen, ids, c.main_image_id);
    for (const img of c.images || []) {
      pushId(seen, ids, img?._id);
    }
  }

  // 3. Compute the `added` delta vs. existingIds. We keep the full deduped
  //    list in `ids` so callers can do either an append or a replace; the
  //    delta is just informational.
  const existing = new Set((existingIds || []).map((x) => String(x)));
  const added = ids.filter((id) => !existing.has(id));

  return { ids, added };
}
