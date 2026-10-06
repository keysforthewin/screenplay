// src/web/artworkCritiqueIrrelevant.js
//
// "Delete what this beat has no use for." Three kinds of artwork the critique
// set aside, listed with what each shows and why, to tick and delete:
//   flawed     — a quality check LOOKED at it and turned it down: the reviewer
//                said make it again, or scored it FLAWED_SCORE or lower
//                (artefacts, the wrong wardrobe, an impossible pose…);
//   duplicate  — the coverage check found it is the same picture as another
//                piece (`inventory.duplicates`); one of each group is kept;
//   irrelevant — its description answered NONE of the beat's requirements
//                (`inventory.irrelevant`).
// A set or a character is shared by every beat it is in, so each item also
// says what else still depends on the picture.
//
// A picture is PROTECTED (listed, never deletable here) when it is the host's
// main image or wardrobe plate, a reference of any cut frame in the project,
// or matched to another beat by that beat's own coverage check. Being on the
// roster of a beat nobody has checked yet is only a warning (`also_on_beats`).

import { stripMarkdown } from '../util/markdown.js';
import { getPlot } from '../mongo/plots.js';
import { getSet } from '../mongo/sets.js';
import { getCharacter } from '../mongo/characters.js';
import { listVideoPrompts } from '../mongo/videoPrompts.js';
import { getBeatArtworkCritique, updateArtworkCritiqueSubject, setArtworkCritiqueCoverage } from '../mongo/artworkCritiques.js';
import { deriveRequirementStatus, computeCoverage } from './artworkCritiqueRules.js';
import { resolveProjectId } from '../mongo/projects.js';
import { removeArtworkViaGateway } from './gateway.js';
import { wardrobeImageId } from './wardrobe.js';
import { artworkCritiqueBusyReason } from './artworkCritique.js';

// A reviewed piece at or under this score is offered for deletion.
export const FLAWED_SCORE = 5;

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const lower = (s) => stripMarkdown(String(s || '')).trim().toLowerCase();

async function loadState(projectId, beatId) {
  const plot = await getPlot(projectId);
  const beat = (plot.beats || []).find((b) => String(b._id) === String(beatId));
  if (!beat) throw httpError(`beat not found: ${beatId}`, 404);
  const critique = await getBeatArtworkCritique(projectId, beat._id);
  // Every image id a cut frame anywhere in the project lists as a reference.
  const cutRefs = new Map();
  for (const c of await listVideoPrompts({ projectId })) {
    for (const f of [c.start_frame, c.end_frame]) {
      for (const id of f?.reference_ids || []) cutRefs.set(String(id), (cutRefs.get(String(id)) || 0) + 1);
    }
  }
  // Artwork another beat's coverage check matched to one of ITS requirements.
  const elsewhere = new Map();
  for (const b of plot.beats || []) {
    if (String(b._id) === String(beat._id)) continue;
    for (const s of b.artwork_critique?.subjects || []) {
      for (const m of s.inventory?.matches || []) {
        const k = String(m.artwork_id);
        if (!elsewhere.has(k)) elsewhere.set(k, new Set());
        elsewhere.get(k).add(b.order);
      }
    }
  }
  return { plot, beat, critique, cutRefs, elsewhere };
}

// Why each of a subject's artworks is set aside: Map artwork id →
// { reason, detail, twin_artwork_id? }. Flawed outranks duplicate outranks
// irrelevant.
function setAside(subject) {
  const out = new Map();
  for (const id of subject.inventory?.irrelevant || []) {
    out.set(String(id), { reason: 'irrelevant', detail: 'Its description answers nothing this beat needs.' });
  }
  const matched = new Set((subject.inventory?.matches || []).map((m) => String(m.artwork_id)));
  for (const group of subject.inventory?.duplicates || []) {
    const ids = (group || []).map(String);
    // Keep the copy the beat uses; otherwise the first.
    const keep = ids.find((id) => matched.has(id)) || ids[0];
    for (const id of ids) {
      if (id !== keep) out.set(id, { reason: 'duplicate', detail: 'The same picture as another piece on file.', twin_artwork_id: keep });
    }
  }
  for (const e of subject.artworks || []) {
    if (!e?.audited_image_id) continue;
    const low = typeof e.score === 'number' && e.score <= FLAWED_SCORE;
    if (e.action !== 'regenerate' && !low) continue;
    const said = [e.regenerate_reason, ...(e.issues || []).map((i) => i?.note)].map((t) => String(t || '').trim()).filter(Boolean);
    out.set(String(e.artwork_id), {
      reason: 'flawed',
      detail: `${typeof e.score === 'number' ? `Reviewed ${e.score}/10. ` : ''}${[...new Set(said)].join(' ').slice(0, 600) || 'The reviewer turned it down.'}`,
    });
  }
  return out;
}

// → { items: [{ host_type, host_id, host_name, artwork_id, image_id, name,
//      description, prop, reason: flawed|duplicate|irrelevant, detail,
//      twin_image_id, twin_name, protected: [why], also_on_beats: [order] }] }
export async function listIrrelevantArtworks({ projectId, beatId }) {
  projectId = await resolveProjectId(projectId);
  const { plot, beat, critique, cutRefs, elsewhere } = await loadState(projectId, beatId);
  const items = [];
  for (const s of critique?.subjects || []) {
    const aside = setAside(s);
    const ids = [...aside.keys()];
    if (!ids.length) continue;
    const host = s.kind === 'set' ? await getSet(projectId, String(s.id)) : await getCharacter(projectId, String(s.id));
    if (!host) continue;
    const name = lower(host.name);
    const rosterKey = s.kind === 'set' ? 'sets' : 'characters';
    const unchecked = (plot.beats || [])
      .filter((b) => String(b._id) !== String(beat._id) && !b.artwork_critique && (b[rosterKey] || []).some((n) => lower(n) === name))
      .map((b) => b.order);
    const main = host.main_image_id ? String(host.main_image_id) : '';
    const plate = s.kind === 'character' ? wardrobeImageId(host) : '';
    for (const id of ids) {
      const live = (x) => (host.artworks || []).find((y) => String(y._id) === String(x) && y.status === 'done' && y.result_image_id);
      const a = live(id);
      if (!a) continue;
      const verdict = aside.get(id);
      const twin = verdict.twin_artwork_id ? live(verdict.twin_artwork_id) : null;
      // The copy to keep is gone: this one is no longer a duplicate.
      if (verdict.reason === 'duplicate' && !twin) continue;
      const image = String(a.result_image_id);
      const why = [];
      if (image === main) why.push(s.kind === 'set' ? 'main image of the set' : 'portrait of the character');
      if (plate && image === plate) why.push('wardrobe plate');
      if (cutRefs.has(image)) why.push(`reference of ${cutRefs.get(image)} cut frame${cutRefs.get(image) === 1 ? '' : 's'}`);
      if (elsewhere.has(id)) why.push(`matched to beat ${[...elsewhere.get(id)].sort((x, y) => x - y).join(', ')}`);
      items.push({
        host_type: s.kind,
        host_id: String(host._id),
        host_name: stripMarkdown(String(host.name || '')).trim(),
        artwork_id: id,
        image_id: image,
        name: String(a.name || '').trim(),
        description: String(a.description || a.prompt || '').trim(),
        prop: a.prop ? String(a.prop) : null,
        reason: verdict.reason,
        detail: verdict.detail,
        twin_image_id: twin ? String(twin.result_image_id) : null,
        twin_name: twin ? String(twin.name || '').trim() : null,
        protected: why,
        also_on_beats: unchecked,
      });
    }
  }
  return { items };
}

// Delete the ticked artworks. Each must still be on the beat's set-aside list
// and unprotected; anything else is skipped with the reason. Irreversible.
export async function deleteIrrelevantArtworks({ projectId, beatId, artworkIds }) {
  projectId = await resolveProjectId(projectId);
  const want = [...new Set((Array.isArray(artworkIds) ? artworkIds : []).map(String))];
  if (!want.length) throw httpError('artwork_ids must list at least one artwork', 400);
  const { beat } = await loadState(projectId, beatId);
  const busy = artworkCritiqueBusyReason(String(beat._id));
  if (busy) throw httpError(busy, 409);
  const { items } = await listIrrelevantArtworks({ projectId, beatId });
  const byId = new Map(items.map((i) => [i.artwork_id, i]));
  const deleted = [];
  const skipped = [];
  for (const id of want) {
    const item = byId.get(id);
    if (!item) { skipped.push({ artwork_id: id, reason: 'not on this beat\'s list of artwork to clear out' }); continue; }
    if (item.protected.length) { skipped.push({ artwork_id: id, reason: item.protected.join('; ') }); continue; }
    try {
      await removeArtworkViaGateway({ projectId, hostType: item.host_type, hostId: item.host_id, artworkId: id });
      deleted.push(id);
    } catch (e) {
      skipped.push({ artwork_id: id, reason: e.message });
    }
  }
  if (deleted.length) {
    // The stored critique forgets the deleted pieces: matches, reviews,
    // duplicate groups — and a requirement only they answered is missing again.
    const gone = new Set(deleted);
    const has = (x) => gone.has(String(x));
    const critique = await getBeatArtworkCritique(projectId, beat._id);
    const subjects = [];
    for (const s of critique?.subjects || []) {
      const inv = s.inventory || {};
      const touched = (s.artworks || []).some((e) => has(e.artwork_id))
        || [...(inv.irrelevant || []), ...(inv.matches || []).map((m) => m.artwork_id), ...(inv.duplicates || []).flat()].some(has);
      if (!touched) { subjects.push(s); continue; }
      const artworks = (s.artworks || []).filter((e) => !has(e.artwork_id));
      const requirements = deriveRequirementStatus(s.requirements || [], artworks);
      const inventory = {
        ...inv,
        irrelevant: (inv.irrelevant || []).filter((x) => !has(x)),
        matches: (inv.matches || []).filter((m) => !has(m.artwork_id)),
        duplicates: (inv.duplicates || []).map((g) => g.filter((x) => !has(x))).filter((g) => g.length > 1),
      };
      await updateArtworkCritiqueSubject(projectId, beat._id, s.id, { artworks, requirements, inventory });
      subjects.push({ ...s, artworks, requirements });
    }
    if (critique) await setArtworkCritiqueCoverage(projectId, beat._id, computeCoverage(subjects.map((s) => ({ requirements: s.requirements || [], artworks: s.artworks || [] }))));
  }
  return { deleted, skipped };
}
