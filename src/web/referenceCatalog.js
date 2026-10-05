// The numbered reference-image CATALOG for a beat: the ARTWORK of the beat's
// characters and sets (done artworks only — uploaded portraits, character
// sheets and gallery images are deliberately excluded; the Artwork section is
// the curated look), numbered 1..N with a description. The artwork critique
// offers it to its proposal planner, the cut-frame renderer
// (src/web/cutFrames.js) reads who each reference shows from it, and
// GET /cuts/candidates hands it to the SPA's "+ Add reference" picker.

import { logger } from '../log.js';
import { findImageFile, imageFileToMeta } from '../mongo/images.js';
import { stripMarkdown } from '../util/markdown.js';
import { wardrobeImageId } from './wardrobe.js';
import { findCharactersInBeat, findSetsInBeat } from './beatPlanShared.js';
import { clipBlock } from './setDescriptionGenerate.js';

// Catalog cap: every done artwork of a beat's cast and sets should fit — one
// beat is dozens of cuts, two stills each, each picking from this pool (40
// was a fraction of one lead's artwork). Only a guard against a runaway
// library; past it the hosts share the cap evenly.
export const MAX_CATALOG_ENTRIES = 200;

// ─── Reference image catalog ────────────────────────────────────────────────

async function imageMeta(id) {
  try {
    const file = await findImageFile(id);
    if (!file) return null;
    const meta = imageFileToMeta(file);
    return {
      name: String(meta.name || '').trim(),
      description: String(meta.description || '').trim(),
    };
  } catch (e) {
    logger.warn(`reference catalog: image meta ${id} failed: ${e.message}`);
    return null;
  }
}

// The artwork a host (character or set doc) carries — its "Artwork" section,
// done artworks with a result image only. Uploaded portraits, character
// sheets and gallery images are NOT offered: the Artwork section is the
// curated look, and the user asked for prompts to draw from it alone. Each
// entry carries a human label ("Sarah — artwork: Rain plate") and the best
// description we have (GridFS metadata description, then the artwork's own
// description or prompt).
// One exception: a character's WARDROBE PLATE (src/web/wardrobe.js) is
// always offered, even when it is a gallery upload rather than artwork —
// it is the picture every still copies the clothes from.
function hostImageSlots(host, ownerType = 'set') {
  const slots = [];
  for (const a of host?.artworks || []) {
    if (a?.status !== 'done' || !a.result_image_id) continue;
    slots.push({
      id: String(a.result_image_id),
      kind: `artwork${a.name ? `: ${String(a.name).trim()}` : ''}`,
      caption: (String(a.description || '').trim() || String(a.prompt || '').trim()),
    });
  }
  const plate = ownerType === 'character' ? wardrobeImageId(host) : '';
  if (plate) {
    const existing = slots.find((s) => s.id === plate);
    if (existing) {
      existing.kind = `wardrobe plate (${existing.kind})`;
      existing.wardrobe = true;
    } else {
      const img = (host.images || []).find((i) => String(i?._id ?? i) === plate);
      slots.push({ id: plate, kind: 'wardrobe plate', caption: String(img?.caption || '').trim(), wardrobe: true });
    }
  }
  return slots;
}

// Build the numbered reference catalog for a beat — artwork only. Returns
// [{ index (1-based), image_id (string), owner_type, owner_id, owner_name,
//    label, description, wardrobe? }] deduped by image id and capped at
//    MAX_CATALOG_ENTRIES.
// Exported for the /cuts/candidates route (the SPA's picker), the cut-frame
// renderer and the artwork critique.
export async function buildReferenceCatalog(projectId, beat) {
  const [characters, sets] = await Promise.all([
    findCharactersInBeat(projectId, beat),
    findSetsInBeat(projectId, beat),
  ]);
  const hosts = [
    ...characters.map((c) => ({ doc: c, ownerType: 'character' })),
    ...sets.map((s) => ({ doc: s, ownerType: 'set' })),
  ];
  // Every host gets a fair share of the cap, handed out one slot at a time
  // in turn: filling it host by host let one character with 58 artworks take
  // all 40 entries, so no set artwork (and not his own wardrobe plate, which
  // sat last) was ever offered to a cut. A wardrobe plate goes first.
  const seen = new Set();
  const queues = hosts.map(({ doc, ownerType }) => {
    const slots = hostImageSlots(doc, ownerType).filter((slot) => !seen.has(slot.id) && seen.add(slot.id));
    return { doc, ownerType, slots: [...slots.filter((x) => x.wardrobe), ...slots.filter((x) => !x.wardrobe)], take: 0 };
  });
  for (let left = MAX_CATALOG_ENTRIES, gave = true; left > 0 && gave;) {
    gave = false;
    for (const q of queues) {
      if (left > 0 && q.take < q.slots.length) { q.take += 1; left -= 1; gave = true; }
    }
  }
  const out = [];
  for (const { doc, ownerType, slots, take } of queues) {
    const ownerName = stripMarkdown(doc?.name || '').trim() || (ownerType === 'set' ? 'Set' : 'Character');
    for (const slot of slots.slice(0, take)) {
      const meta = await imageMeta(slot.id);
      const description = meta?.description || slot.caption || '';
      const nameBit = meta?.name ? ` (${meta.name})` : '';
      out.push({
        index: out.length + 1,
        image_id: slot.id,
        owner_type: ownerType,
        owner_id: doc?._id ? String(doc._id) : '',
        owner_name: ownerName,
        label: `${ownerName} — ${slot.kind}${nameBit}`,
        description,
        ...(slot.wardrobe ? { wardrobe: true } : {}),
      });
    }
  }
  return out;
}

export function formatReferenceCatalog(catalog) {
  if (!catalog?.length) return '(no artwork available for this beat\'s characters and sets — write the prompts without @Image handles)';
  return catalog
    .map((e) => {
      const tag = e.owner_type === 'set' ? 'SET' : 'CHARACTER';
      const desc = e.description ? ` — ${clipBlock(e.description, 240)}` : '';
      return `${e.index}. [${tag} ${e.owner_name}] ${e.label}${desc}`;
    })
    .join('\n');
}
