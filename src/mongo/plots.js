import { ObjectId } from 'mongodb';
import { getDb } from './client.js';

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
    if (!Array.isArray(next.characters)) {
      next.characters = [];
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
  return ensureBeatIds(existing);
}

export async function updatePlot(patch) {
  await getPlot();
  const set = { updated_at: new Date() };
  if (patch.synopsis !== undefined) set.synopsis = patch.synopsis;
  if (patch.notes !== undefined) set.notes = patch.notes;
  await col().updateOne({ _id: 'main' }, { $set: set });
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

async function persistBeats(beats, extraSet = {}) {
  await col().updateOne(
    { _id: 'main' },
    { $set: { beats, updated_at: new Date(), ...extraSet } },
  );
}

export async function createBeat({ name, desc = '', body = '', characters = [], order } = {}) {
  const finalDesc = String(desc || '').trim();
  let finalName = String(name || '').trim();
  if (!finalName) finalName = deriveName(finalDesc);
  if (!finalDesc && !name) {
    throw new Error('Beat requires a `desc` or an explicit `name`.');
  }
  const plot = await getPlot();
  const beats = [...(plot.beats || [])];
  let nextOrder = order;
  if (nextOrder === undefined || nextOrder === null) {
    nextOrder = beats.length ? Math.max(...beats.map((b) => b.order || 0)) + 1 : 1;
  }
  const beat = {
    _id: new ObjectId(),
    order: Number(nextOrder),
    name: finalName,
    desc: finalDesc,
    body: String(body || ''),
    characters: dedupeNames(characters),
    images: [],
    main_image_id: null,
  };
  beats.push(beat);
  beats.sort((a, b) => (a.order || 0) - (b.order || 0));
  const extra = plot.current_beat_id ? {} : { current_beat_id: beat._id };
  await persistBeats(beats, extra);
  return beat;
}

export async function updateBeat(identifier, patch) {
  const plot = await getPlot();
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  const beats = (plot.beats || []).map((b) => {
    if (!b._id || !b._id.equals(beat._id)) return b;
    const next = { ...b };
    if (patch.name !== undefined) next.name = String(patch.name);
    if (patch.desc !== undefined) next.desc = String(patch.desc);
    if (patch.body !== undefined) next.body = String(patch.body);
    if (patch.order !== undefined && patch.order !== null) next.order = Number(patch.order);
    if (Array.isArray(patch.characters)) next.characters = dedupeNames(patch.characters);
    return next;
  });
  beats.sort((a, b) => (a.order || 0) - (b.order || 0));
  await persistBeats(beats);
  return beats.find((b) => b._id && b._id.equals(beat._id));
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
  const beats = (plot.beats || []).map((b) =>
    b._id && b._id.equals(beat._id) ? { ...b, body: newBody } : b,
  );
  await persistBeats(beats);
  return beats.find((b) => b._id && b._id.equals(beat._id));
}

export async function deleteBeat(identifier) {
  const plot = await getPlot();
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  const beats = (plot.beats || []).filter((b) => !(b._id && b._id.equals(beat._id)));
  const extra =
    plot.current_beat_id && plot.current_beat_id.equals(beat._id)
      ? { current_beat_id: null }
      : {};
  await persistBeats(beats, extra);
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
  return updateBeat(beat._id.toString(), { characters });
}

export async function unlinkCharacterFromBeat(identifier, characterName) {
  const plot = await getPlot();
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  const lower = String(characterName).toLowerCase();
  const characters = (beat.characters || []).filter((c) => String(c).toLowerCase() !== lower);
  return updateBeat(beat._id.toString(), { characters });
}

export async function pushBeatImage(beatIdentifier, imageMeta, setAsMain = false) {
  const plot = await getPlot();
  const beat = findBeat(plot, beatIdentifier);
  if (!beat) throw new Error(`Beat not found: ${beatIdentifier}`);
  const beats = (plot.beats || []).map((b) => {
    if (!b._id || !b._id.equals(beat._id)) return b;
    const images = [...(b.images || []), imageMeta];
    const promote = !!setAsMain || !b.main_image_id;
    return {
      ...b,
      images,
      main_image_id: promote ? imageMeta._id : b.main_image_id,
    };
  });
  await persistBeats(beats);
  const updated = beats.find((b) => b._id && b._id.equals(beat._id));
  return { beat: updated, is_main: !!(updated.main_image_id && updated.main_image_id.equals(imageMeta._id)) };
}

export async function setBeatMainImage(beatIdentifier, imageId) {
  const plot = await getPlot();
  const beat = findBeat(plot, beatIdentifier);
  if (!beat) throw new Error(`Beat not found: ${beatIdentifier}`);
  const oid = imageId instanceof ObjectId ? imageId : new ObjectId(String(imageId));
  if (!(beat.images || []).some((i) => i._id.equals(oid))) {
    throw new Error(`Image ${imageId} is not attached to this beat`);
  }
  const beats = (plot.beats || []).map((b) =>
    b._id && b._id.equals(beat._id) ? { ...b, main_image_id: oid } : b,
  );
  await persistBeats(beats);
  return beats.find((b) => b._id && b._id.equals(beat._id));
}

export async function pullBeatImage(beatIdentifier, imageId) {
  const plot = await getPlot();
  const beat = findBeat(plot, beatIdentifier);
  if (!beat) throw new Error(`Beat not found: ${beatIdentifier}`);
  const oid = imageId instanceof ObjectId ? imageId : new ObjectId(String(imageId));
  const images = (beat.images || []).filter((i) => !i._id.equals(oid));
  if (images.length === (beat.images || []).length) {
    throw new Error(`Image ${imageId} is not attached to this beat`);
  }
  const wasMain = beat.main_image_id && beat.main_image_id.equals(oid);
  const newMain = wasMain ? images[0]?._id || null : beat.main_image_id || null;
  const beats = (plot.beats || []).map((b) =>
    b._id && b._id.equals(beat._id) ? { ...b, images, main_image_id: newMain } : b,
  );
  await persistBeats(beats);
  return { beat: beats.find((b) => b._id && b._id.equals(beat._id)), removed: oid };
}

export async function setCurrentBeat(identifier) {
  const plot = await getPlot();
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  await col().updateOne(
    { _id: 'main' },
    { $set: { current_beat_id: beat._id, updated_at: new Date() } },
  );
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
}
