import { ObjectId } from 'mongodb';
import { getDb } from './client.js';
import { logger } from '../log.js';
import { applyMarkdownEdits } from '../util/textWindow.js';
import { normalizeSceneBible } from './sceneBible.js';
import { resolveProjectId, getDefaultProject } from './projects.js';

const col = () => getDb().collection('plots');

function maybeOid(s) {
  return /^[a-f0-9]{24}$/i.test(s) ? new ObjectId(s) : null;
}

function dedupeNames(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr || []) {
    if (x === null || x === undefined) continue;
    const k = String(x).toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(String(x));
    }
  }
  return out;
}

function deriveName(desc) {
  const t = String(desc || '').trim();
  if (!t) return 'Untitled Beat';
  const firstClause = t.split(/[.!?\n]/)[0].trim();
  const words = firstClause.split(/\s+/).slice(0, 6).join(' ');
  const trimmed = words.replace(/[,;:—-]+$/u, '').trim();
  return trimmed || 'Untitled Beat';
}

async function ensureBeatIds(plot) {
  let changed = false;
  const fallbackTs = plot.updated_at instanceof Date ? plot.updated_at : new Date();
  const beats = (plot.beats || []).map((b) => {
    const next = { ...b };
    if (!next._id) {
      next._id = new ObjectId();
      changed = true;
    }
    if (!Array.isArray(next.images)) {
      next.images = [];
      changed = true;
    }
    if (next.main_image_id === undefined) {
      next.main_image_id = null;
      changed = true;
    }
    if (!Array.isArray(next.attachments)) {
      next.attachments = [];
      changed = true;
    }
    if (!Array.isArray(next.artworks)) {
      next.artworks = [];
      changed = true;
    }
    if (!Array.isArray(next.characters)) {
      next.characters = [];
      changed = true;
    }
    if (next.scene_bible === undefined) {
      next.scene_bible = null;
      changed = true;
    }
    if (next.critique === undefined) {
      next.critique = null;
      changed = true;
    }
    if (next.previous_body === undefined) {
      next.previous_body = null;
      changed = true;
    }
    if (next.name === undefined) {
      next.name = next.title ? String(next.title) : '';
      changed = true;
    }
    if (next.title !== undefined) {
      delete next.title;
      changed = true;
    }
    if (next.body === undefined) {
      next.body = next.description !== undefined ? String(next.description) : '';
      changed = true;
    }
    if (next.description !== undefined) {
      delete next.description;
      changed = true;
    }
    if (next.desc === undefined) {
      next.desc = '';
      changed = true;
    }
    if (!(next.created_at instanceof Date)) {
      next.created_at = fallbackTs;
      changed = true;
    }
    if (!(next.updated_at instanceof Date)) {
      next.updated_at = fallbackTs;
      changed = true;
    }
    return next;
  });
  if (changed) {
    await col().updateOne(
      { _id: plot._id },
      { $set: { beats, updated_at: new Date() } },
    );
  }
  return { ...plot, beats };
}

export async function getPlot(projectId) {
  projectId = await resolveProjectId(projectId);
  let existing = await col().findOne({ project_id: projectId });
  if (!existing) {
    // Lazy-claim: adopt the pre-multi-project singleton {_id:'main'} for the
    // default project the first time it is read post-upgrade.
    const defaultId = (await getDefaultProject())._id.toString();
    if (projectId === defaultId) {
      const legacy = await col().findOne({ _id: 'main', project_id: { $exists: false } });
      if (legacy) {
        const claim = await col().updateOne(
          { _id: 'main', project_id: { $exists: false } },
          { $set: { project_id: projectId } },
        );
        if (claim.matchedCount === 0) {
          existing = await col().findOne({ project_id: projectId });
        } else {
          existing = { ...legacy, project_id: projectId };
          logger.info('mongo: plot lazy-claimed legacy {_id:"main"} doc for default project');
        }
      }
    }
  }
  if (!existing) {
    existing = {
      _id: new ObjectId(),
      project_id: projectId,
      title: '',
      synopsis: '',
      beats: [],
      notes: '',
      current_beat_id: null,
      updated_at: new Date(),
    };
    await col().insertOne(existing);
    return existing;
  }
  if (existing.current_beat_id === undefined) {
    existing.current_beat_id = null;
    await col().updateOne({ _id: existing._id }, { $set: { current_beat_id: null } });
  }
  if (existing.title === undefined) {
    existing.title = '';
    await col().updateOne({ _id: existing._id }, { $set: { title: '' } });
  }
  return ensureBeatIds(existing);
}

export async function updatePlot(projectId, patch) {
  projectId = await resolveProjectId(projectId);
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error(
      `update_plot: \`patch\` must be an object like {synopsis: "..."}, got ${
        Array.isArray(patch) ? 'array' : typeof patch
      }.`,
    );
  }
  const recognized = ['title', 'synopsis', 'notes', 'dialogue_style'];
  if (!recognized.some((k) => patch[k] !== undefined)) {
    throw new Error(
      `update_plot: \`patch\` has no recognized fields. Expected one of: ${recognized.join(', ')}. Got keys: [${Object.keys(patch).join(', ')}].`,
    );
  }
  await getPlot(projectId);
  const set = { updated_at: new Date() };
  if (patch.title !== undefined) {
    if (typeof patch.title !== 'string') {
      throw new Error(`update_plot: \`title\` must be a string, got ${typeof patch.title}.`);
    }
    set.title = patch.title.trim();
  }
  if (patch.synopsis !== undefined) set.synopsis = patch.synopsis;
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (patch.dialogue_style !== undefined) set.dialogue_style = patch.dialogue_style;
  const result = await col().updateOne({ project_id: projectId }, { $set: set });
  if (!result || result.matchedCount === 0) {
    const msg = `updatePlot: plot doc {project_id: "${projectId}"} not found — write did not apply.`;
    logger.error(msg);
    throw new Error(msg);
  }
  const fieldList = Object.keys(set).filter((k) => k !== 'updated_at');
  logger.info(`mongo: plot update fields=[${fieldList.join(',')}]`);
  return getPlot(projectId);
}

function findBeat(plot, identifier) {
  if (identifier === undefined || identifier === null || identifier === '') return null;
  const beats = plot.beats || [];
  const oid = maybeOid(identifier);
  if (oid) {
    const m = beats.find((b) => b._id && oid.equals(b._id));
    if (m) return m;
  }
  if (/^\d+$/.test(String(identifier))) {
    const order = Number(identifier);
    const m = beats.find((b) => b.order === order);
    if (m) return m;
  }
  const t = String(identifier).toLowerCase();
  return beats.find((b) => (b.name || '').toLowerCase() === t) || null;
}

export async function listBeats(projectId) {
  projectId = await resolveProjectId(projectId);
  const p = await getPlot(projectId);
  return [...(p.beats || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
}

export async function getBeat(projectId, identifier) {
  projectId = await resolveProjectId(projectId);
  const plot = await getPlot(projectId);
  if (identifier === undefined || identifier === null || identifier === '') {
    if (!plot.current_beat_id) return null;
    return (plot.beats || []).find((b) => b._id && plot.current_beat_id.equals(b._id)) || null;
  }
  return findBeat(plot, identifier);
}

export async function searchBeats(projectId, query) {
  projectId = await resolveProjectId(projectId);
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const plot = await getPlot(projectId);
  const beats = [...(plot.beats || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  const matches = [];
  for (const b of beats) {
    const name = (b.name || '').toLowerCase();
    const desc = (b.desc || '').toLowerCase();
    const body = (b.body || '').toLowerCase();
    let score = 0;
    let matched_field = null;
    if (name === q) {
      score = 100;
      matched_field = 'name';
    } else if (name.includes(q)) {
      score = 50;
      matched_field = 'name';
    } else if (desc.includes(q)) {
      score = 30;
      matched_field = 'desc';
    } else if (body.includes(q)) {
      score = 10;
      matched_field = 'body';
    }
    if (score > 0) matches.push({ beat: b, score, matched_field });
  }
  matches.sort((a, b) => b.score - a.score || (a.beat.order || 0) - (b.beat.order || 0));
  return matches;
}

// ── Atomic update helpers ──────────────────────────────────────────────────
// Every beat-targeted write goes through these so two concurrent operations
// on the same plots doc can't trample each other (the old whole-array $set
// pattern was a lost-update minefield — see plot-concurrency.test.js).

async function updateBeatFields(projectId, beatOid, set = {}, opts = {}) {
  const now = new Date();
  const $set = { ...set, 'beats.$.updated_at': now, updated_at: now };
  const update = { $set };
  if (opts.$push) update.$push = opts.$push;
  if (opts.$pull) update.$pull = opts.$pull;
  const result = await col().updateOne(
    { project_id: projectId, 'beats._id': beatOid },
    update,
  );
  if (!result || result.matchedCount === 0) {
    throw new Error(`updateBeatFields: beat ${beatOid} not found in plot doc`);
  }
  return result;
}

async function fetchBeat(projectId, beatOid) {
  const plot = await getPlot(projectId);
  return (plot.beats || []).find((b) => b._id && b._id.equals(beatOid)) || null;
}

async function persistBeatsFullArray(projectId, beats, extraSet = {}) {
  // Used only for plot-level operations that genuinely need to rewrite the
  // whole array: createBeat (insertion + sort), deleteBeat (removal),
  // reorder. These are rare relative to per-beat field edits and the lost-
  // update risk is bounded by their natural exclusivity (you don't delete a
  // beat while editing its body).
  const result = await col().updateOne(
    { project_id: projectId },
    { $set: { beats, updated_at: new Date(), ...extraSet } },
  );
  if (!result || result.matchedCount === 0) {
    const msg = `persistBeatsFullArray: plot doc {project_id: "${projectId}"} not found — write did not apply.`;
    logger.error(msg);
    throw new Error(msg);
  }
}

export async function createBeat({ projectId, name, desc = '', body = '', characters = [], order } = {}) {
  projectId = await resolveProjectId(projectId);
  const finalDesc = String(desc || '').trim();
  let finalName = String(name || '').trim();
  if (!finalName) finalName = deriveName(finalDesc);
  if (!finalDesc && !name) {
    throw new Error('Beat requires a `desc` or an explicit `name`.');
  }
  const plot = await getPlot(projectId);
  const existing = plot.beats || [];
  let nextOrder = order;
  if (nextOrder === undefined || nextOrder === null) {
    nextOrder = existing.length ? Math.max(...existing.map((b) => b.order || 0)) + 1 : 1;
  }
  const now = new Date();
  const beat = {
    _id: new ObjectId(),
    order: Number(nextOrder),
    name: finalName,
    desc: finalDesc,
    body: String(body || ''),
    characters: dedupeNames(characters),
    dialog_notes: '',
    images: [],
    main_image_id: null,
    scene_bible: null,
    attachments: [],
    artworks: [],
    created_at: now,
    updated_at: now,
  };
  const beats = [...existing, beat].sort((a, b) => (a.order || 0) - (b.order || 0));
  const extra = plot.current_beat_id ? {} : { current_beat_id: beat._id };
  await persistBeatsFullArray(projectId, beats, extra);
  logger.info(`mongo: beat create id=${beat._id} order=${beat.order} name="${beat.name}"`);
  return beat;
}

export async function updateBeat(projectId, identifier, patch) {
  projectId = await resolveProjectId(projectId);
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error(
      `update_beat: \`patch\` must be an object like {body: "..."}, got ${
        Array.isArray(patch) ? 'array' : typeof patch
      }. Wrap your fields in {patch: {body: "..."}} (or name/desc/order/characters).`,
    );
  }
  const isRecognizedKey = (k) =>
    k === 'name' ||
    k === 'desc' ||
    k === 'body' ||
    k === 'order' ||
    k === 'characters' ||
    k === 'dialog_notes' ||
    k === 'scene_sheet_image_id';
  if (!Object.keys(patch).some((k) => isRecognizedKey(k) && patch[k] !== undefined)) {
    throw new Error(
      `update_beat: \`patch\` has no recognized fields. Expected one of: name, desc, body, order, characters, dialog_notes, scene_sheet_image_id. Got keys: [${Object.keys(patch).join(', ')}].`,
    );
  }

  let sheetImageId;
  let sheetImageIdProvided = false;
  if (Object.prototype.hasOwnProperty.call(patch, 'scene_sheet_image_id')) {
    sheetImageIdProvided = true;
    const v = patch.scene_sheet_image_id;
    if (v === null) {
      sheetImageId = null;
    } else if (v instanceof ObjectId) {
      sheetImageId = v;
    } else if (typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v)) {
      sheetImageId = new ObjectId(v);
    } else {
      throw new Error(
        `update_beat: scene_sheet_image_id must be null or a 24-hex string, got ${typeof v}.`,
      );
    }
  }

  const plot = await getPlot(projectId);
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);

  const set = {};
  if (patch.name !== undefined) set['beats.$.name'] = String(patch.name);
  if (patch.desc !== undefined) set['beats.$.desc'] = String(patch.desc);
  if (patch.body !== undefined) set['beats.$.body'] = String(patch.body);
  if (patch.dialog_notes !== undefined) {
    set['beats.$.dialog_notes'] = String(patch.dialog_notes);
  }
  if (patch.characters !== undefined && Array.isArray(patch.characters)) {
    set['beats.$.characters'] = dedupeNames(patch.characters);
  }
  if (sheetImageIdProvided) set['beats.$.scene_sheet_image_id'] = sheetImageId;

  const orderChanging = patch.order !== undefined && patch.order !== null;
  if (orderChanging) set['beats.$.order'] = Number(patch.order);

  await updateBeatFields(projectId, beat._id, set);
  const patchFields = Object.keys(patch || {});
  logger.info(`mongo: beat update id=${beat._id} fields=[${patchFields.join(',')}]`);

  if (orderChanging) {
    // Re-sort the array. The atomic update can't reorder; do it as a
    // dedicated full-array write. By construction, reordering doesn't race
    // with field edits because sort is order-only.
    const fresh = await getPlot(projectId);
    const sorted = [...(fresh.beats || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
    await persistBeatsFullArray(projectId, sorted);
    return sorted.find((b) => b._id && b._id.equals(beat._id));
  }
  return fetchBeat(projectId, beat._id);
}

export async function setBeatBody(projectId, identifier, body) {
  projectId = await resolveProjectId(projectId);
  if (typeof body !== 'string') {
    throw new Error(`set_beat_body: \`body\` must be a string, got ${typeof body}.`);
  }
  const plot = await getPlot(projectId);
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  await updateBeatFields(projectId, beat._id, { 'beats.$.body': body });
  logger.info(`mongo: beat set_body id=${beat._id} chars=${body.length}`);
  return fetchBeat(projectId, beat._id);
}

// Persist a beat's scene bible (the per-beat "look book" that all storyboard
// shots inherit). Stored as a normalized sub-doc under beats.$.scene_bible.
// Pass null/empty to clear. Uses the atomic per-beat write path.
export async function setBeatSceneBible(projectId, identifier, bible) {
  projectId = await resolveProjectId(projectId);
  const plot = await getPlot(projectId);
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  // normalizeSceneBible returns only the text fields (it is a pure shape
  // helper); the persistence layer stamps updated_at at write time.
  const value = bible == null ? null : { ...normalizeSceneBible(bible), updated_at: new Date() };
  await updateBeatFields(projectId, beat._id, { 'beats.$.scene_bible': value });
  logger.info(`mongo: beat scene_bible set id=${beat._id} cleared=${value === null}`);
  return fetchBeat(projectId, beat._id);
}

export async function editBeatBody(projectId, identifier, edits) {
  projectId = await resolveProjectId(projectId);
  const plot = await getPlot(projectId);
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  const { body, applied, beforeLen, afterLen } = applyMarkdownEdits(
    String(beat.body || ''),
    edits,
    'edit_beat_body',
  );
  await updateBeatFields(projectId, beat._id, { 'beats.$.body': body });
  const updated = await fetchBeat(projectId, beat._id);
  logger.info(
    `mongo: beat edit_body id=${beat._id} edits=${edits.length} before=${beforeLen} after=${afterLen}`,
  );
  return { beat: updated, edits: applied, beforeLen, afterLen };
}

export async function editPlotField(projectId, field, edits) {
  projectId = await resolveProjectId(projectId);
  if (field !== 'synopsis' && field !== 'notes') {
    throw new Error(`edit_plot_field: \`field\` must be "synopsis" or "notes", got "${field}".`);
  }
  const plot = await getPlot(projectId);
  const current = String(plot[field] || '');
  const { body, applied, beforeLen, afterLen } = applyMarkdownEdits(
    current,
    edits,
    'edit_plot_field',
  );
  const result = await col().updateOne(
    { project_id: projectId },
    { $set: { [field]: body, updated_at: new Date() } },
  );
  if (!result || result.matchedCount === 0) {
    throw new Error(`editPlotField: plot doc {project_id: "${projectId}"} not found — write did not apply.`);
  }
  logger.info(
    `mongo: plot edit_${field} edits=${edits.length} before=${beforeLen} after=${afterLen}`,
  );
  return { field, edits: applied, beforeLen, afterLen, value: body };
}

export async function appendBeatBody(projectId, identifier, content) {
  projectId = await resolveProjectId(projectId);
  const plot = await getPlot(projectId);
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  const addition = String(content || '').trim();
  if (!addition) throw new Error('No content provided to append.');
  const existing = String(beat.body || '');
  const separator = existing.trim() ? '\n\n' : '';
  const newBody = `${existing}${separator}${addition}`;
  await updateBeatFields(projectId, beat._id, { 'beats.$.body': newBody });
  logger.info(
    `mongo: beat append_body id=${beat._id} added_chars=${addition.length}`,
  );
  return fetchBeat(projectId, beat._id);
}

export async function deleteBeat(projectId, identifier) {
  projectId = await resolveProjectId(projectId);
  const plot = await getPlot(projectId);
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  const wasCurrent =
    plot.current_beat_id && plot.current_beat_id.equals(beat._id);
  const update = { $pull: { beats: { _id: beat._id } }, $set: { updated_at: new Date() } };
  if (wasCurrent) update.$set.current_beat_id = null;
  const result = await col().updateOne({ project_id: projectId }, update);
  if (!result || result.matchedCount === 0) {
    throw new Error(`deleteBeat: plot doc {project_id: "${projectId}"} not found — write did not apply.`);
  }
  logger.info(`mongo: beat delete id=${beat._id} name="${beat.name}"`);
  return {
    _id: beat._id,
    name: beat.name,
    image_ids: (beat.images || []).map((i) => i._id),
  };
}

export async function linkCharacterToBeat(projectId, identifier, characterName) {
  projectId = await resolveProjectId(projectId);
  const plot = await getPlot(projectId);
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  const characters = dedupeNames([...(beat.characters || []), characterName]);
  await updateBeatFields(projectId, beat._id, { 'beats.$.characters': characters });
  return fetchBeat(projectId, beat._id);
}

export async function unlinkCharacterFromBeat(projectId, identifier, characterName) {
  projectId = await resolveProjectId(projectId);
  const plot = await getPlot(projectId);
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  const lower = String(characterName).toLowerCase();
  const characters = (beat.characters || []).filter((c) => String(c).toLowerCase() !== lower);
  await updateBeatFields(projectId, beat._id, { 'beats.$.characters': characters });
  return fetchBeat(projectId, beat._id);
}

export async function unlinkCharacterFromAllBeats(projectId, characterName) {
  projectId = await resolveProjectId(projectId);
  const plot = await getPlot(projectId);
  const lower = String(characterName).toLowerCase();
  let touched = 0;
  for (const b of plot.beats || []) {
    const filtered = (b.characters || []).filter((c) => String(c).toLowerCase() !== lower);
    if (filtered.length === (b.characters || []).length) continue;
    touched += 1;
    await updateBeatFields(projectId, b._id, { 'beats.$.characters': filtered });
  }
  if (touched > 0) {
    logger.info(`mongo: unlink "${characterName}" from ${touched} beat(s)`);
  }
  return { unlinked_from: touched };
}

export async function pushBeatImage(projectId, beatIdentifier, imageMeta, setAsMain = false) {
  projectId = await resolveProjectId(projectId);
  const plot = await getPlot(projectId);
  const beat = findBeat(plot, beatIdentifier);
  if (!beat) throw new Error(`Beat not found: ${beatIdentifier}`);
  const promote = !!setAsMain || !beat.main_image_id;
  const set = {};
  if (promote) set['beats.$.main_image_id'] = imageMeta._id;
  await updateBeatFields(projectId, beat._id, set, {
    $push: { 'beats.$.images': imageMeta },
  });
  const updated = await fetchBeat(projectId, beat._id);
  const isMain = !!(updated.main_image_id && updated.main_image_id.equals(imageMeta._id));
  logger.info(
    `mongo: beat image push id=${beat._id} image=${imageMeta._id}${isMain ? ' (main)' : ''}`,
  );
  return { beat: updated, is_main: isMain };
}

export async function setBeatMainImage(projectId, beatIdentifier, imageId) {
  projectId = await resolveProjectId(projectId);
  const plot = await getPlot(projectId);
  const beat = findBeat(plot, beatIdentifier);
  if (!beat) throw new Error(`Beat not found: ${beatIdentifier}`);
  const oid = imageId instanceof ObjectId ? imageId : new ObjectId(String(imageId));
  const inImages = (beat.images || []).some((i) => i._id.equals(oid));
  const inArtworks = (beat.artworks || []).some(
    (a) => a?.status === 'done' && a?.result_image_id && oid.equals(a.result_image_id),
  );
  if (!inImages && !inArtworks) {
    throw new Error(`Image ${imageId} is not attached to this beat`);
  }
  await updateBeatFields(projectId, beat._id, { 'beats.$.main_image_id': oid });
  logger.info(`mongo: beat main_image set id=${beat._id} image=${oid}`);
  return fetchBeat(projectId, beat._id);
}

// Persist the reference-image set chosen for this beat's image sheet, so the
// "Tune image sheet" flow can pre-fill the picker with the same references.
export async function setBeatImageSheetReferences(projectId, beatIdentifier, imageIds) {
  projectId = await resolveProjectId(projectId);
  const plot = await getPlot(projectId);
  const beat = findBeat(plot, beatIdentifier);
  if (!beat) throw new Error(`Beat not found: ${beatIdentifier}`);
  const ids = (Array.isArray(imageIds) ? imageIds : [])
    .map((x) => {
      try { return x instanceof ObjectId ? x : new ObjectId(String(x)); }
      catch { return null; }
    })
    .filter(Boolean);
  await updateBeatFields(projectId, beat._id, { 'beats.$.image_sheet_reference_ids': ids });
  logger.info(`mongo: beat image_sheet_reference_ids set id=${beat._id} count=${ids.length}`);
  return fetchBeat(projectId, beat._id);
}

// Pure: the reference ids used to pre-fill the Tune dialog. Prefers the saved
// image_sheet_reference_ids; falls back to the union of reference_image_ids on
// the beat's artworks (for sheets created before the field existed). Returns
// hex strings.
export function computeImageSheetPrefillIds(beat) {
  const saved = (beat?.image_sheet_reference_ids || []).map((x) => String(x));
  if (saved.length) return saved;
  const seen = new Set();
  const out = [];
  for (const a of beat?.artworks || []) {
    for (const r of a?.reference_image_ids || []) {
      const id = String(r);
      if (!seen.has(id)) { seen.add(id); out.push(id); }
    }
  }
  return out;
}

// Replace one image meta in the beat's images[] array, preserving slot
// position. Uses arrayFilters so the swap is one atomic write; the optional
// main_image_id pivot is included in the same update when the replaced
// image was the main image.
export async function replaceBeatImage(projectId, beatIdentifier, oldImageId, newImageMeta) {
  projectId = await resolveProjectId(projectId);
  const plot = await getPlot(projectId);
  const beat = findBeat(plot, beatIdentifier);
  if (!beat) throw new Error(`Beat not found: ${beatIdentifier}`);
  const oldOid = oldImageId instanceof ObjectId ? oldImageId : new ObjectId(String(oldImageId));
  if (!(beat.images || []).some((i) => i._id.equals(oldOid))) {
    throw new Error(`Image ${oldImageId} is not attached to this beat`);
  }
  const wasMain = beat.main_image_id && beat.main_image_id.equals(oldOid);
  const now = new Date();
  const $set = {
    'beats.$[b].images.$[i]': newImageMeta,
    'beats.$[b].updated_at': now,
    updated_at: now,
  };
  if (wasMain) $set['beats.$[b].main_image_id'] = newImageMeta._id;
  const result = await col().updateOne(
    { project_id: projectId },
    { $set },
    { arrayFilters: [{ 'b._id': beat._id }, { 'i._id': oldOid }] },
  );
  if (!result || result.matchedCount === 0) {
    throw new Error(`replaceBeatImage: write did not match beat ${beat._id}`);
  }
  logger.info(
    `mongo: beat image replace id=${beat._id} old=${oldOid} new=${newImageMeta._id}${wasMain ? ' (main)' : ''}`,
  );
  return {
    beat: await fetchBeat(projectId, beat._id),
    replaced: oldOid,
    new_image_id: newImageMeta._id,
    was_main: !!wasMain,
  };
}

export async function pullBeatImage(projectId, beatIdentifier, imageId) {
  projectId = await resolveProjectId(projectId);
  const plot = await getPlot(projectId);
  const beat = findBeat(plot, beatIdentifier);
  if (!beat) throw new Error(`Beat not found: ${beatIdentifier}`);
  const oid = imageId instanceof ObjectId ? imageId : new ObjectId(String(imageId));
  if (!(beat.images || []).some((i) => i._id.equals(oid))) {
    throw new Error(`Image ${imageId} is not attached to this beat`);
  }
  const wasMain = beat.main_image_id && beat.main_image_id.equals(oid);
  const set = {};
  if (wasMain) {
    const fallback = (beat.images || []).find((i) => !i._id.equals(oid));
    set['beats.$.main_image_id'] = fallback?._id || null;
  }
  await updateBeatFields(projectId, beat._id, set, {
    $pull: { 'beats.$.images': { _id: oid } },
  });
  logger.info(`mongo: beat image pull id=${beat._id} image=${oid}`);
  return { beat: await fetchBeat(projectId, beat._id), removed: oid };
}

export async function pushBeatAttachment(projectId, beatIdentifier, attachmentMeta) {
  projectId = await resolveProjectId(projectId);
  const plot = await getPlot(projectId);
  const beat = findBeat(plot, beatIdentifier);
  if (!beat) throw new Error(`Beat not found: ${beatIdentifier}`);
  await updateBeatFields(projectId, beat._id, {}, {
    $push: { 'beats.$.attachments': attachmentMeta },
  });
  logger.info(
    `mongo: beat attachment push id=${beat._id} attach=${attachmentMeta?._id || '-'}`,
  );
  return fetchBeat(projectId, beat._id);
}

export async function pullBeatAttachment(projectId, beatIdentifier, attachmentId) {
  projectId = await resolveProjectId(projectId);
  const plot = await getPlot(projectId);
  const beat = findBeat(plot, beatIdentifier);
  if (!beat) throw new Error(`Beat not found: ${beatIdentifier}`);
  const oid = attachmentId instanceof ObjectId ? attachmentId : new ObjectId(String(attachmentId));
  if (!(beat.attachments || []).some((a) => a._id.equals(oid))) {
    throw new Error(`Attachment ${attachmentId} is not attached to this beat`);
  }
  await updateBeatFields(projectId, beat._id, {}, {
    $pull: { 'beats.$.attachments': { _id: oid } },
  });
  logger.info(`mongo: beat attachment pull id=${beat._id} attach=${oid}`);
  return { beat: await fetchBeat(projectId, beat._id), removed: oid };
}

export async function setCurrentBeat(projectId, identifier) {
  projectId = await resolveProjectId(projectId);
  const plot = await getPlot(projectId);
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  await col().updateOne(
    { project_id: projectId },
    { $set: { current_beat_id: beat._id, updated_at: new Date() } },
  );
  logger.info(`mongo: current_beat set id=${beat._id} name="${beat.name}"`);
  return beat;
}

export async function getCurrentBeat(projectId) {
  projectId = await resolveProjectId(projectId);
  const plot = await getPlot(projectId);
  if (!plot.current_beat_id) return null;
  return (plot.beats || []).find((b) => b._id && plot.current_beat_id.equals(b._id)) || null;
}

export async function clearCurrentBeat(projectId) {
  projectId = await resolveProjectId(projectId);
  const plot = await getPlot(projectId);
  await col().updateOne(
    { _id: plot._id },
    { $set: { current_beat_id: null, updated_at: new Date() } },
  );
  logger.info('mongo: current_beat cleared');
}

// Locate the plot containing a beat — ANY project. Beat ObjectIds are
// globally unique, so this is the verify-after-locate hook for callers that
// know a beat id but not its project (GridFS detach paths, RAG indexer).
export async function findPlotByBeatId(beatId) {
  const oid = beatId instanceof ObjectId ? beatId : maybeOid(String(beatId));
  if (!oid) return null;
  return col().findOne({ 'beats._id': oid });
}
