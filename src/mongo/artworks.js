// Generalized artwork helpers — operate on either a character.artworks[]
// array or a beat.artworks[] array (the latter is nested inside the
// `plots.beats[]` array on the singleton plots doc).
//
// An "artwork" is a generated image bundled with the prompt + reference
// images that produced it. Each artwork's result image lives in GridFS
// (owner_type matches the host, owner_id = host._id) and is referenced by
// `result_image_id`. A `previous_result_image_id` is kept across the most
// recent in-line edit so the user can Undo one step.
//
// These helpers never touch GridFS — they only mutate Mongo docs and
// surface "orphaned" image ids that the caller (artwork jobs runner) is
// expected to delete from the bucket.

import { ObjectId } from 'mongodb';
import { getDb } from './client.js';
import { logger } from '../log.js';

const VALID_HOST_TYPES = new Set(['character', 'beat']);
const VALID_STATUSES = new Set(['pending', 'done', 'error']);
const HEX24 = /^[a-f0-9]{24}$/i;

function toOid(v) {
  if (v instanceof ObjectId) return v;
  if (typeof v === 'string' && HEX24.test(v)) return new ObjectId(v);
  throw new Error(`invalid id: ${v}`);
}

function maybeOid(v) {
  if (v instanceof ObjectId) return v;
  if (typeof v === 'string' && HEX24.test(v)) return new ObjectId(v);
  return null;
}

function assertHostType(hostType) {
  if (!VALID_HOST_TYPES.has(hostType)) {
    throw new Error(`invalid hostType: ${hostType}`);
  }
}

// ─── Host resolution ───────────────────────────────────────────────────────
// Both character and beat hosts can be looked up by _id; beat additionally
// by order or name. We always normalize to the canonical _id before mutating
// so further reads can use the fast path.

async function loadCharacter(hostId) {
  const c = getDb().collection('characters');
  const oid = maybeOid(hostId);
  if (oid) {
    const byId = await c.findOne({ _id: oid });
    if (byId) return byId;
  }
  // Fall back to name lookup (matches getCharacter behaviour in characters.js)
  const lc = String(hostId).toLowerCase();
  return c.findOne({ name_lower: lc });
}

async function loadPlot() {
  return getDb().collection('plots').findOne({ _id: 'main' });
}

function findBeatInPlot(plot, hostId) {
  const beats = plot?.beats || [];
  const oid = maybeOid(hostId);
  if (oid) {
    const m = beats.find((b) => b._id && oid.equals(b._id));
    if (m) return m;
  }
  if (/^\d+$/.test(String(hostId))) {
    const order = Number(hostId);
    const m = beats.find((b) => b.order === order);
    if (m) return m;
  }
  const t = String(hostId).toLowerCase();
  return beats.find((b) => (b.name || '').toLowerCase() === t) || null;
}

// Resolve { hostType, hostId } to the host doc + the canonical _id.
async function loadHost(hostType, hostId) {
  assertHostType(hostType);
  if (hostType === 'character') {
    const c = await loadCharacter(hostId);
    if (!c) throw new Error(`Character not found: ${hostId}`);
    return { kind: 'character', doc: c, _id: c._id };
  }
  const plot = await loadPlot();
  if (!plot) throw new Error('Plot doc not found');
  const beat = findBeatInPlot(plot, hostId);
  if (!beat) throw new Error(`Beat not found: ${hostId}`);
  return { kind: 'beat', plot, beat, _id: beat._id };
}

// ─── Persistence ───────────────────────────────────────────────────────────
// Persist a mutated artworks[] array back to the host doc. For characters
// this is a simple $set on the doc. For beats we must rewrite the embedded
// beats[] array on the plots doc (matches the existing replaceBeatImage /
// updateBeat pattern in plots.js).
//
// When `mainImageIdChange.changed` is true, fold the new main_image_id
// (an ObjectId or null) into the same atomic write so a regen/edit/remove
// that moved the main doesn't leave a dangling pointer to a deleted GridFS
// file.

async function persistArtworks(host, nextArtworks, mainImageIdChange = null) {
  const now = new Date();
  if (host.kind === 'character') {
    const $set = { artworks: nextArtworks, updated_at: now };
    if (mainImageIdChange?.changed) $set.main_image_id = mainImageIdChange.value;
    await getDb().collection('characters').updateOne({ _id: host._id }, { $set });
    return { ...host.doc, ...$set };
  }
  const beats = (host.plot.beats || []).map((b) => {
    if (!b._id || !b._id.equals(host._id)) return b;
    const patch = { ...b, artworks: nextArtworks, updated_at: now };
    if (mainImageIdChange?.changed) patch.main_image_id = mainImageIdChange.value;
    return patch;
  });
  await getDb().collection('plots').updateOne(
    { _id: 'main' },
    { $set: { beats, updated_at: now } },
  );
  return beats.find((b) => b._id && b._id.equals(host._id));
}

function readArtworks(host) {
  if (host.kind === 'character') return host.doc.artworks || [];
  return host.beat.artworks || [];
}

function readHostMainImageId(host) {
  if (host.kind === 'character') return host.doc.main_image_id || null;
  return host.beat.main_image_id || null;
}

function oidEquals(a, b) {
  if (!a || !b) return false;
  if (a instanceof ObjectId) return a.equals(b);
  if (b instanceof ObjectId) return b.equals(a);
  return String(a) === String(b);
}

function findArtworkIndex(artworks, artworkId) {
  const oid = toOid(artworkId);
  return artworks.findIndex((a) => a?._id && oid.equals(a._id));
}

// ─── Public API ────────────────────────────────────────────────────────────

// Create a "done" artwork in one shot — used by the import flow where the
// result image already exists in GridFS. No prompt, no refs, no job. The
// `source: 'imported'` field is set so consumers can tell this apart from
// generated artwork. `source` is set only at creation; patchArtwork's
// PATCHABLE allowlist rejects it on updates.
export async function appendDoneArtwork({
  hostType,
  hostId,
  resultImageId,
  name = '',
}) {
  const host = await loadHost(hostType, hostId);
  const now = new Date();
  const artwork = {
    _id: new ObjectId(),
    name: String(name || ''),
    prompt: '',
    model: '',
    reference_image_ids: [],
    result_image_id: toOid(resultImageId),
    previous_result_image_id: null,
    last_edit_prompt: '',
    status: 'done',
    error_message: null,
    job_id: null,
    source: 'imported',
    created_at: now,
    updated_at: now,
  };
  const next = [...readArtworks(host), artwork];
  await persistArtworks(host, next);
  logger.info(
    `mongo: ${host.kind} artwork import id=${host._id} artwork=${artwork._id} result=${artwork.result_image_id}`,
  );
  return { artwork, host_id: host._id };
}

// Create a pending artwork on the host. The caller (the jobs runner)
// kicks off the background work after this returns. The returned artwork
// has status='pending', no result_image_id, and a fresh _id.
export async function createPendingArtwork({
  hostType,
  hostId,
  prompt,
  name = '',
  model,
  referenceImageIds = [],
  jobId,
}) {
  const host = await loadHost(hostType, hostId);
  const now = new Date();
  const artwork = {
    _id: new ObjectId(),
    name: String(name || ''),
    prompt: String(prompt || ''),
    model: String(model || ''),
    reference_image_ids: (referenceImageIds || []).map(toOid),
    result_image_id: null,
    previous_result_image_id: null,
    last_edit_prompt: '',
    status: 'pending',
    error_message: null,
    job_id: jobId || null,
    created_at: now,
    updated_at: now,
  };
  const next = [...readArtworks(host), artwork];
  await persistArtworks(host, next);
  logger.info(
    `mongo: ${host.kind} artwork create id=${host._id} artwork=${artwork._id} status=pending`,
  );
  return { artwork, host_id: host._id };
}

// Update generic artwork fields. Use for renaming (name), changing
// last_edit_prompt, swapping model, etc. Unknown keys are rejected so we
// don't drift into untyped territory.
const PATCHABLE = new Set([
  'name',
  'prompt',
  'model',
  'last_edit_prompt',
  'reference_image_ids',
  'job_id',
]);

export async function patchArtwork({ hostType, hostId, artworkId, patch }) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('patchArtwork: patch must be an object');
  }
  const host = await loadHost(hostType, hostId);
  const artworks = readArtworks(host);
  const idx = findArtworkIndex(artworks, artworkId);
  if (idx < 0) throw new Error(`Artwork ${artworkId} not found on ${host.kind} ${host._id}`);
  const next = { ...artworks[idx], updated_at: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (!PATCHABLE.has(k)) {
      throw new Error(`patchArtwork: unknown field "${k}"`);
    }
    if (k === 'reference_image_ids') {
      if (!Array.isArray(v)) throw new Error('reference_image_ids must be an array');
      next[k] = v.map(toOid);
    } else if (k === 'job_id') {
      next[k] = v == null ? null : String(v);
    } else {
      next[k] = v == null ? (k === 'name' || k === 'last_edit_prompt' ? '' : null) : String(v);
    }
  }
  const newArtworks = [...artworks];
  newArtworks[idx] = next;
  await persistArtworks(host, newArtworks);
  logger.info(
    `mongo: ${host.kind} artwork patch id=${host._id} artwork=${next._id} fields=[${Object.keys(patch).join(',')}]`,
  );
  return { artwork: next, host_id: host._id };
}

// Update status (pending/done/error) and optionally error_message.
export async function setArtworkStatus({
  hostType,
  hostId,
  artworkId,
  status,
  errorMessage = null,
}) {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`setArtworkStatus: invalid status "${status}"`);
  }
  const host = await loadHost(hostType, hostId);
  const artworks = readArtworks(host);
  const idx = findArtworkIndex(artworks, artworkId);
  if (idx < 0) throw new Error(`Artwork ${artworkId} not found on ${host.kind} ${host._id}`);
  const next = {
    ...artworks[idx],
    status,
    error_message: status === 'error' ? String(errorMessage || 'Unknown error') : null,
    updated_at: new Date(),
  };
  if (status !== 'pending') next.job_id = null;
  const newArtworks = [...artworks];
  newArtworks[idx] = next;
  await persistArtworks(host, newArtworks);
  logger.info(
    `mongo: ${host.kind} artwork status id=${host._id} artwork=${next._id} status=${status}`,
  );
  return { artwork: next, host_id: host._id };
}

// Set a new result_image_id on the artwork. When `rotateToPrevious` is true
// (the in-line edit path), the current result becomes previous and any
// previously stored previous becomes an orphan returned for GridFS cleanup.
// Otherwise (regenerate or initial generate) the prior result_image_id is
// returned as an orphan if it existed.
export async function setArtworkResult({
  hostType,
  hostId,
  artworkId,
  resultImageId,
  rotateToPrevious = false,
}) {
  const host = await loadHost(hostType, hostId);
  const artworks = readArtworks(host);
  const idx = findArtworkIndex(artworks, artworkId);
  if (idx < 0) throw new Error(`Artwork ${artworkId} not found on ${host.kind} ${host._id}`);
  const current = artworks[idx];
  const newResult = toOid(resultImageId);
  let nextPrevious = current.previous_result_image_id || null;
  let orphanedImageId = null;
  if (rotateToPrevious) {
    // Edit flow: current → previous, old previous is orphaned.
    if (current.result_image_id) {
      orphanedImageId = nextPrevious || null;
      nextPrevious = current.result_image_id;
    }
  } else {
    // Generate/regenerate: any existing result is orphaned. Previous is
    // left untouched (it'll be cleared on the next edit anyway).
    orphanedImageId = current.result_image_id || null;
  }
  const next = {
    ...current,
    result_image_id: newResult,
    previous_result_image_id: nextPrevious || null,
    status: 'done',
    error_message: null,
    job_id: null,
    updated_at: new Date(),
  };
  const newArtworks = [...artworks];
  newArtworks[idx] = next;
  // If the artwork being updated was hosting the main image, follow the
  // result forward — otherwise the deleted orphan would leave main_image_id
  // pointing at a stale GridFS id. The image being replaced is either the
  // rotated-out current (rotate case) or `current.result_image_id` (regen).
  const hostMain = readHostMainImageId(host);
  const replacedId = rotateToPrevious
    ? current.result_image_id
    : current.result_image_id;
  const mainImageIdChange = oidEquals(hostMain, replacedId)
    ? { changed: true, value: newResult }
    : null;
  await persistArtworks(host, newArtworks, mainImageIdChange);
  logger.info(
    `mongo: ${host.kind} artwork result id=${host._id} artwork=${next._id} result=${newResult}${
      orphanedImageId ? ` orphan=${orphanedImageId}` : ''
    }${mainImageIdChange ? ` main->${newResult}` : ''}`,
  );
  return { artwork: next, host_id: host._id, orphanedImageId, mainImageIdChange };
}

// Swap previous_result_image_id → result_image_id. The image that was
// current is reported as orphaned for GridFS cleanup (no redo, per spec).
export async function undoArtworkEdit({ hostType, hostId, artworkId }) {
  const host = await loadHost(hostType, hostId);
  const artworks = readArtworks(host);
  const idx = findArtworkIndex(artworks, artworkId);
  if (idx < 0) throw new Error(`Artwork ${artworkId} not found on ${host.kind} ${host._id}`);
  const current = artworks[idx];
  if (!current.previous_result_image_id) {
    const err = new Error('Nothing to undo — no previous image stored.');
    err.status = 400;
    throw err;
  }
  const orphanedImageId = current.result_image_id || null;
  const next = {
    ...current,
    result_image_id: current.previous_result_image_id,
    previous_result_image_id: null,
    last_edit_prompt: '',
    updated_at: new Date(),
  };
  const newArtworks = [...artworks];
  newArtworks[idx] = next;
  // If the artwork's current result was the host's main, follow main back
  // to the restored previous image.
  const hostMain = readHostMainImageId(host);
  const mainImageIdChange = oidEquals(hostMain, current.result_image_id)
    ? { changed: true, value: current.previous_result_image_id }
    : null;
  await persistArtworks(host, newArtworks, mainImageIdChange);
  logger.info(
    `mongo: ${host.kind} artwork undo id=${host._id} artwork=${next._id} orphan=${orphanedImageId}${mainImageIdChange ? ` main->${current.previous_result_image_id}` : ''}`,
  );
  return { artwork: next, host_id: host._id, orphanedImageId, mainImageIdChange };
}

// Remove the artwork from the host. Returns the image ids that were
// attached so the caller can purge them from GridFS.
export async function removeArtwork({ hostType, hostId, artworkId }) {
  const host = await loadHost(hostType, hostId);
  const artworks = readArtworks(host);
  const idx = findArtworkIndex(artworks, artworkId);
  if (idx < 0) throw new Error(`Artwork ${artworkId} not found on ${host.kind} ${host._id}`);
  const removed = artworks[idx];
  const newArtworks = artworks.filter((_, i) => i !== idx);
  // If the removed artwork was the source of the host's main image, clear
  // it. Per spec we don't auto-fall-back to another image — the user picks
  // a new one explicitly.
  const hostMain = readHostMainImageId(host);
  const mainImageIdChange =
    oidEquals(hostMain, removed.result_image_id)
    || oidEquals(hostMain, removed.previous_result_image_id)
      ? { changed: true, value: null }
      : null;
  await persistArtworks(host, newArtworks, mainImageIdChange);
  const removed_image_ids = [removed.result_image_id, removed.previous_result_image_id].filter(Boolean);
  logger.info(
    `mongo: ${host.kind} artwork remove id=${host._id} artwork=${removed._id} images=[${removed_image_ids.join(',')}]${mainImageIdChange ? ' main->null' : ''}`,
  );
  return { host_id: host._id, removed, removed_image_ids, mainImageIdChange };
}

// Read a single artwork.
export async function getArtwork({ hostType, hostId, artworkId }) {
  const host = await loadHost(hostType, hostId);
  const artworks = readArtworks(host);
  const idx = findArtworkIndex(artworks, artworkId);
  if (idx < 0) return null;
  return { artwork: artworks[idx], host_id: host._id, host_kind: host.kind };
}

// List artworks for a host. Used by /api/beats/with-artwork and similar.
export async function listArtworks({ hostType, hostId }) {
  const host = await loadHost(hostType, hostId);
  return { artworks: readArtworks(host), host_id: host._id };
}
