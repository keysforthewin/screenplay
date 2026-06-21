// Picks reference images for a storyboard shot. The selection logic (gather
// candidates -> present name/description/caption -> pick best per character ->
// canonical fallback) is shared two ways: folded into the planner's expandShots
// call (no extra API call), and as a standalone LLM call for the SPA's
// "auto-suggest references" button. See referenceSelector LLM helper below.
import { getCharacter } from '../mongo/characters.js';
import { findImageFile, imageFileToMeta } from '../mongo/images.js';
import { stripMarkdown } from '../util/markdown.js';
import { logger } from '../log.js';

// Candidate ids for a character, ordered to match canonicalImageIdFor priority
// (sheets -> main -> attached images), deduped. candidates[0] is the canonical
// fallback used when the LLM has no usable pick.
function orderedCandidateIds(c) {
  const ids = [];
  const seen = new Set();
  const push = (raw) => {
    if (!raw) return;
    const k = String(raw);
    if (seen.has(k)) return;
    seen.add(k);
    ids.push(k);
  };
  for (const sid of c?.character_sheet_image_ids || []) push(sid);
  if (!ids.length && c?.character_sheet_image_id) push(c.character_sheet_image_id);
  push(c?.main_image_id);
  for (const img of c?.images || []) push(img?._id);
  return ids;
}

export async function gatherCandidatesFromDocs(characterDocs) {
  const out = [];
  for (const c of characterDocs || []) {
    if (!c) continue;
    const captionById = new Map();
    for (const img of c.images || []) {
      if (img?._id) captionById.set(String(img._id), String(img.caption || '').trim());
    }
    const candidates = [];
    for (const id of orderedCandidateIds(c)) {
      let name = '';
      let description = '';
      try {
        const file = await findImageFile(id);
        if (file) {
          const meta = imageFileToMeta(file);
          name = String(meta.name || '').trim();
          description = String(meta.description || '').trim();
        }
      } catch (e) {
        logger.warn(`reference selector: meta read ${id} failed: ${e.message}`);
      }
      candidates.push({ id: String(id), name, description, caption: captionById.get(String(id)) || '' });
    }
    const nm = stripMarkdown(c.name || '').trim();
    out.push({ name: nm, candidates });
  }
  return out;
}

export async function gatherCharacterReferenceCandidates(projectId, characterNames) {
  const docs = [];
  for (const raw of characterNames || []) {
    const nm = stripMarkdown(String(raw ?? '')).trim();
    if (!nm) continue;
    try {
      const c = await getCharacter(projectId, nm);
      if (c) docs.push(c);
    } catch (e) {
      logger.warn(`reference selector: lookup "${nm}" failed: ${e.message}`);
    }
  }
  return gatherCandidatesFromDocs(docs);
}

export function formatCandidateManifest(perCharacter) {
  const blocks = [];
  for (const entry of perCharacter || []) {
    if (!entry?.candidates?.length) continue;
    const lines = [`${entry.name}:`];
    entry.candidates.forEach((cand, i) => {
      const bits = [];
      if (cand.name) bits.push(cand.name);
      if (cand.description) bits.push(cand.description);
      if (cand.caption) bits.push(`caption: ${cand.caption}`);
      lines.push(`  ${i + 1}. ${bits.length ? bits.join(' — ') : '(no description)'}`);
    });
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n');
}

export function resolveReferencePicks({ picks, perCharacter, beatMainImageId = null, max = 12 }) {
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    if (!raw) return;
    const k = String(raw);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };
  add(beatMainImageId);
  const pickByChar = new Map();
  for (const p of picks || []) {
    const nm = stripMarkdown(String(p?.character ?? '')).trim().toLowerCase();
    if (nm) pickByChar.set(nm, Number(p?.image_index));
  }
  for (const entry of perCharacter || []) {
    const cands = entry?.candidates || [];
    if (!cands.length) continue;
    const idx = pickByChar.get(String(entry.name).toLowerCase());
    let chosen = cands[0];
    if (Number.isInteger(idx) && idx >= 1 && idx <= cands.length) chosen = cands[idx - 1];
    add(chosen.id);
  }
  return out.slice(0, max);
}
