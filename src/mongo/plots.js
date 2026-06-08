import { ObjectId } from 'mongodb';
import { getDb } from './client.js';
import { logger } from '../log.js';
import { applyMarkdownEdits } from '../util/textWindow.js';
import { normalizeSceneBible } from './sceneBible.js';

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
      { _id: 'main' },
      { $set: { beats, updated_at: new Date() } },
    );
  }
  return { ...plot, beats };
}

export async function getPlot() {
  let existing = await col().findOne({ _id: 'main' });
  if (!existing) {
    existing = {
      _id: 'main',
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
    await col().updateOne({ _id: 'main' }, { $set: { current_beat_id: null } });
  }
  if (existing.title === undefined) {
    existing.title = '';
    await col().updateOne({ _id: 'main' }, { $set: { title: '' } });
  }
  return ensureBeatIds(existing);
}

export async function updatePlot(patch) {
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
  await getPlot();
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
  const result = await col().updateOne({ _id: 'main' }, { $set: set });
  if (!result || result.matchedCount === 0) {
    const msg = 'updatePlot: plot doc {_id: "main"} not found — write did not apply.';
    logger.error(msg);
    throw new Error(msg);
  }
  const fieldList = Object.keys(set).filter((k) => k !== 'updated_at');
  logger.info(`mongo: plot update fields=[${fieldList.join(',')}]`);
  return getPlot();
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

export async function listBeats() {
  const p = await getPlot();
  return [...(p.beats || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
}

export async function getBeat(identifier) {
  const plot = await getPlot();
  if (identifier === undefined || identifier === null || identifier === '') {
    if (!plot.current_beat_id) return null;
    return (plot.beats || []).find((b) => b._id && plot.current_beat_id.equals(b._id)) || null;
  }
  return findBeat(plot, identifier);
}

export async function searchBeats(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const plot = await getPlot();
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

async function updateBeatFields(beatOid, set = {}, opts = {}) {
  const now = new Date();
  const $set = { ...set, 'beats.$.updated_at': now, updated_at: now };
  const update = { $set };
  if (opts.$push) update.$push = opts.$push;
  if (opts.$pull) update.$pull = opts.$pull;
  const result = await col().updateOne(
    { _id: 'main', 'beats._id': beatOid },
    update,
  );
  if (!result || result.matchedCount === 0) {
    throw new Error(`updateBeatFields: beat ${beatOid} not found in plot doc`);
  }
  return result;
}

async function fetchBeat(beatOid) {
  const plot = await getPlot();
  return (plot.beats || []).find((b) => b._id && b._id.equals(beatOid)) || null;
}

async function persistBeatsFullArray(beats, extraSet = {}) {
  // Used only for plot-level operations that genuinely need to rewrite the
  // whole array: createBeat (insertion + sort), deleteBeat (removal),
  // reorder. These are rare relative to per-beat field edits and the lost-
  // update risk is bounded by their natural exclusivity (you don't delete a
  // beat while editing its body).
  const result = await col().updateOne(
    { _id: 'main' },
    { $set: { beats, updated_at: new Date(), ...extraSet } },
  );
  if (!result || result.matchedCount === 0) {
    const msg = 'persistBeatsFullArray: plot doc {_id: "main"} not found — write did not apply.';
    logger.error(msg);
    throw new Error(msg);
  }
}

export async function createBeat({ name, desc = '', body = '', characters = [], order } = {}) {
  const finalDesc = String(desc || '').trim();
  let finalName = String(name || '').trim();
  if (!finalName) finalName = deriveName(finalDesc);
  if (!finalDesc && !name) {
    throw new Error('Beat requires a `desc` or an explicit `name`.');
  }
  const plot = await getPlot();
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
  await persistBeatsFullArray(beats, extra);
  logger.info(`mongo: beat create id=${beat._id} order=${beat.order} name="${beat.name}"`);
  return beat;
}

export async function updateBeat(identifier, patch) {
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

  const plot = await getPlot();
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

  await updateBeatFields(beat._id, set);
  const patchFields = Object.keys(patch || {});
  logger.info(`mongo: beat update id=${beat._id} fields=[${patchFields.join(',')}]`);

  if (orderChanging) {
    // Re-sort the array. The atomic update can't reorder; do it as a
    // dedicated full-array write. By construction, reordering doesn't race
    // with field edits because sort is order-only.
    const fresh = await getPlot();
    const sorted = [...(fresh.beats || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
    await persistBeatsFullArray(sorted);
    return sorted.find((b) => b._id && b._id.equals(beat._id));
  }
  return fetchBeat(beat._id);
}

export async function setBeatBody(identifier, body) {
  if (typeof body !== 'string') {
    throw new Error(`set_beat_body: \`body\` must be a string, got ${typeof body}.`);
  }
  const plot = await getPlot();
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  await updateBeatFields(beat._id, { 'beats.$.body': body });
  logger.info(`mongo: beat set_body id=${beat._id} chars=${body.length}`);
  return fetchBeat(beat._id);
}

// Persist a beat's scene bible (the per-beat "look book" that all storyboard
// shots inherit). Stored as a normalized sub-doc under beats.$.scene_bible.
// Pass null/empty to clear. Uses the atomic per-beat write path.
export async function setBeatSceneBible(identifier, bible) {
  const plot = await getPlot();
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  // normalizeSceneBible returns only the text fields (it is a pure shape
  // helper); the persistence layer stamps updated_at at write time.
  const value = bible == null ? null : { ...normalizeSceneBible(bible), updated_at: new Date() };
  await updateBeatFields(beat._id, { 'beats.$.scene_bible': value });
  logger.info(`mongo: beat scene_bible set id=${beat._id} cleared=${value === null}`);
  return fetchBeat(beat._id);
}

export async function editBeatBody(identifier, edits) {
  const plot = await getPlot();
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  const { body, applied, beforeLen, afterLen } = applyMarkdownEdits(
    String(beat.body || ''),
    edits,
    'edit_beat_body',
  );
  await updateBeatFields(beat._id, { 'beats.$.body': body });
  const updated = await fetchBeat(beat._id);
  logger.info(
    `mongo: beat edit_body id=${beat._id} edits=${edits.length} before=${beforeLen} after=${afterLen}`,
  );
  return { beat: updated, edits: applied, beforeLen, afterLen };
}

export async function editPlotField(field, edits) {
  if (field !== 'synopsis' && field !== 'notes') {
    throw new Error(`edit_plot_field: \`field\` must be "synopsis" or "notes", got "${field}".`);
  }
  const plot = await getPlot();
  const current = String(plot[field] || '');
  const { body, applied, beforeLen, afterLen } = applyMarkdownEdits(
    current,
    edits,
    'edit_plot_field',
  );
  const result = await col().updateOne(
    { _id: 'main' },
    { $set: { [field]: body, updated_at: new Date() } },
  );
  if (!result || result.matchedCount === 0) {
    throw new Error('editPlotField: plot doc {_id: "main"} not found — write did not apply.');
  }
  logger.info(
    `mongo: plot edit_${field} edits=${edits.length} before=${beforeLen} after=${afterLen}`,
  );
  return { field, edits: applied, beforeLen, afterLen, value: body };
}

export async function appendBeatBody(identifier, content) {
  const plot = await getPlot();
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  const addition = String(content || '').trim();
  if (!addition) throw new Error('No content provided to append.');
  const existing = String(beat.body || '');
  const separator = existing.trim() ? '\n\n' : '';
  const newBody = `${existing}${separator}${addition}`;
  await updateBeatFields(beat._id, { 'beats.$.body': newBody });
  logger.info(
    `mongo: beat append_body id=${beat._id} added_chars=${addition.length}`,
  );
  return fetchBeat(beat._id);
}

export async function deleteBeat(identifier) {
  const plot = await getPlot();
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  const wasCurrent =
    plot.current_beat_id && plot.current_beat_id.equals(beat._id);
  const update = { $pull: { beats: { _id: beat._id } }, $set: { updated_at: new Date() } };
  if (wasCurrent) update.$set.current_beat_id = null;
  const result = await col().updateOne({ _id: 'main' }, update);
  if (!result || result.matchedCount === 0) {
    throw new Error('deleteBeat: plot doc {_id: "main"} not found — write did not apply.');
  }
  logger.info(`mongo: beat delete id=${beat._id} name="${beat.name}"`);
  return {
    _id: beat._id,
    name: beat.name,
    image_ids: (beat.images || []).map((i) => i._id),
  };
}

export async function linkCharacterToBeat(identifier, characterName) {
  const plot = await getPlot();
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  const characters = dedupeNames([...(beat.characters || []), characterName]);
  await updateBeatFields(beat._id, { 'beats.$.characters': characters });
  return fetchBeat(beat._id);
}

export async function unlinkCharacterFromBeat(identifier, characterName) {
  const plot = await getPlot();
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  const lower = String(characterName).toLowerCase();
  const characters = (beat.characters || []).filter((c) => String(c).toLowerCase() !== lower);
  await updateBeatFields(beat._id, { 'beats.$.characters': characters });
  return fetchBeat(beat._id);
}

export async function unlinkCharacterFromAllBeats(characterName) {
  const plot = await getPlot();
  const lower = String(characterName).toLowerCase();
  let touched = 0;
  for (const b of plot.beats || []) {
    const filtered = (b.characters || []).filter((c) => String(c).toLowerCase() !== lower);
    if (filtered.length === (b.characters || []).length) continue;
    touched += 1;
    await updateBeatFields(b._id, { 'beats.$.characters': filtered });
  }
  if (touched > 0) {
    logger.info(`mongo: unlink "${characterName}" from ${touched} beat(s)`);
  }
  return { unlinked_from: touched };
}

export async function pushBeatImage(beatIdentifier, imageMeta, setAsMain = false) {
  const plot = await getPlot();
  const beat = findBeat(plot, beatIdentifier);
  if (!beat) throw new Error(`Beat not found: ${beatIdentifier}`);
  const promote = !!setAsMain || !beat.main_image_id;
  const set = {};
  if (promote) set['beats.$.main_image_id'] = imageMeta._id;
  await updateBeatFields(beat._id, set, {
    $push: { 'beats.$.images': imageMeta },
  });
  const updated = await fetchBeat(beat._id);
  const isMain = !!(updated.main_image_id && updated.main_image_id.equals(imageMeta._id));
  logger.info(
    `mongo: beat image push id=${beat._id} image=${imageMeta._id}${isMain ? ' (main)' : ''}`,
  );
  return { beat: updated, is_main: isMain };
}

export async function setBeatMainImage(beatIdentifier, imageId) {
  const plot = await getPlot();
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
  await updateBeatFields(beat._id, { 'beats.$.main_image_id': oid });
  logger.info(`mongo: beat main_image set id=${beat._id} image=${oid}`);
  return fetchBeat(beat._id);
}

// Replace one image meta in the beat's images[] array, preserving slot
// position. Uses arrayFilters so the swap is one atomic write; the optional
// main_image_id pivot is included in the same update when the replaced
// image was the main image.
export async function replaceBeatImage(beatIdentifier, oldImageId, newImageMeta) {
  const plot = await getPlot();
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
    { _id: 'main' },
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
    beat: await fetchBeat(beat._id),
    replaced: oldOid,
    new_image_id: newImageMeta._id,
    was_main: !!wasMain,
  };
}

export async function pullBeatImage(beatIdentifier, imageId) {
  const plot = await getPlot();
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
  await updateBeatFields(beat._id, set, {
    $pull: { 'beats.$.images': { _id: oid } },
  });
  logger.info(`mongo: beat image pull id=${beat._id} image=${oid}`);
  return { beat: await fetchBeat(beat._id), removed: oid };
}

export async function pushBeatAttachment(beatIdentifier, attachmentMeta) {
  const plot = await getPlot();
  const beat = findBeat(plot, beatIdentifier);
  if (!beat) throw new Error(`Beat not found: ${beatIdentifier}`);
  await updateBeatFields(beat._id, {}, {
    $push: { 'beats.$.attachments': attachmentMeta },
  });
  logger.info(
    `mongo: beat attachment push id=${beat._id} attach=${attachmentMeta?._id || '-'}`,
  );
  return fetchBeat(beat._id);
}

export async function pullBeatAttachment(beatIdentifier, attachmentId) {
  const plot = await getPlot();
  const beat = findBeat(plot, beatIdentifier);
  if (!beat) throw new Error(`Beat not found: ${beatIdentifier}`);
  const oid = attachmentId instanceof ObjectId ? attachmentId : new ObjectId(String(attachmentId));
  if (!(beat.attachments || []).some((a) => a._id.equals(oid))) {
    throw new Error(`Attachment ${attachmentId} is not attached to this beat`);
  }
  await updateBeatFields(beat._id, {}, {
    $pull: { 'beats.$.attachments': { _id: oid } },
  });
  logger.info(`mongo: beat attachment pull id=${beat._id} attach=${oid}`);
  return { beat: await fetchBeat(beat._id), removed: oid };
}

export async function setCurrentBeat(identifier) {
  const plot = await getPlot();
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  await col().updateOne(
    { _id: 'main' },
    { $set: { current_beat_id: beat._id, updated_at: new Date() } },
  );
  logger.info(`mongo: current_beat set id=${beat._id} name="${beat.name}"`);
  return beat;
}

export async function getCurrentBeat() {
  const plot = await getPlot();
  if (!plot.current_beat_id) return null;
  return (plot.beats || []).find((b) => b._id && plot.current_beat_id.equals(b._id)) || null;
}

export async function clearCurrentBeat() {
  await col().updateOne(
    { _id: 'main' },
    { $set: { current_beat_id: null, updated_at: new Date() } },
  );
  logger.info('mongo: current_beat cleared');
}
