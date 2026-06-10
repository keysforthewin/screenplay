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
//
// All writes use atomic positional / arrayFilter updates so two concurrent
// callers on the same host never clobber each other (the previous whole-
// array $set pattern was a lost-update minefield — see
// plot-concurrency.test.js).

import { ObjectId } from 'mongodb';
import { getDb } from './client.js';
import { logger } from '../log.js';
import { getPlot } from './plots.js';

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
// We resolve {hostType, hostId} to the canonical host _id once up-front;
// every subsequent write is keyed off that _id with positional/arrayFilter
// operators so concurrent callers don't fight over a shared snapshot.

async function loadCharacter(hostId) {
  const c = getDb().collection('characters');
  const oid = maybeOid(hostId);
  if (oid) {
    const byId = await c.findOne({ _id: oid });
    if (byId) return byId;
  }
  const lc = String(hostId).toLowerCase();
  return c.findOne({ name_lower: lc });
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

async function loadHost(projectId, hostType, hostId) {
  assertHostType(hostType);
  if (hostType === 'character') {
    const c = await loadCharacter(hostId); // scoped in Task 4
    if (!c) throw new Error(`Character not found: ${hostId}`);
    return { kind: 'character', doc: c, _id: c._id };
  }
  const plot = await getPlot(projectId);
  if (!plot) throw new Error('Plot doc not found');
  const beat = findBeatInPlot(plot, hostId);
  if (!beat) throw new Error(`Beat not found: ${hostId}`);
  return { kind: 'beat', plot, beat, _id: beat._id };
}

// Re-read just the artwork after an atomic write, so callers can return the
// authoritative shape (with server-applied timestamps etc.).
async function fetchArtwork(host, artworkId) {
  const aid = toOid(artworkId);
  if (host.kind === 'character') {
    const fresh = await getDb().collection('characters').findOne({ _id: host._id });
    return (fresh?.artworks || []).find((a) => a?._id && aid.equals(a._id)) || null;
  }
  const plot = await getDb().collection('plots').findOne({ _id: host.plot._id });
  const beat = (plot?.beats || []).find((b) => b._id && host._id.equals(b._id));
  return (beat?.artworks || []).find((a) => a?._id && aid.equals(a._id)) || null;
}

async function fetchHostMainImageId(host) {
  if (host.kind === 'character') {
    const fresh = await getDb().collection('characters').findOne({ _id: host._id });
    return fresh?.main_image_id || null;
  }
  const plot = await getDb().collection('plots').findOne({ _id: host.plot._id });
  const beat = (plot?.beats || []).find((b) => b._id && host._id.equals(b._id));
  return beat?.main_image_id || null;
}

// ─── Atomic ops ────────────────────────────────────────────────────────────

async function pushArtwork(host, artwork) {
  const now = new Date();
  if (host.kind === 'character') {
    await getDb().collection('characters').updateOne(
      { _id: host._id },
      { $push: { artworks: artwork }, $set: { updated_at: now } },
    );
    return;
  }
  await getDb().collection('plots').updateOne(
    { _id: host.plot._id },
    {
      $push: { 'beats.$[b].artworks': artwork },
      $set: { 'beats.$[b].updated_at': now, updated_at: now },
    },
    { arrayFilters: [{ 'b._id': host._id }] },
  );
}

async function setArtworkFields(host, artworkId, fields, options = {}) {
  const aid = toOid(artworkId);
  const now = new Date();
  if (host.kind === 'character') {
    const $set = { updated_at: now };
    for (const [k, v] of Object.entries(fields)) {
      $set[`artworks.$[a].${k}`] = v;
    }
    if (options.hostMainImageId !== undefined) {
      $set.main_image_id = options.hostMainImageId;
    }
    const result = await getDb().collection('characters').updateOne(
      { _id: host._id, 'artworks._id': aid },
      { $set },
      { arrayFilters: [{ 'a._id': aid }] },
    );
    if (!result.matchedCount) {
      throw new Error(`Artwork ${artworkId} not found on character ${host._id}`);
    }
    return;
  }
  const $set = { 'beats.$[b].updated_at': now, updated_at: now };
  for (const [k, v] of Object.entries(fields)) {
    $set[`beats.$[b].artworks.$[a].${k}`] = v;
  }
  if (options.hostMainImageId !== undefined) {
    $set['beats.$[b].main_image_id'] = options.hostMainImageId;
  }
  const result = await getDb().collection('plots').updateOne(
    { _id: host.plot._id },
    { $set },
    { arrayFilters: [{ 'b._id': host._id }, { 'a._id': aid }] },
  );
  if (!result.matchedCount) {
    throw new Error(`Artwork ${artworkId} not found on beat ${host._id}`);
  }
}

async function pullArtwork(host, artworkId, options = {}) {
  const aid = toOid(artworkId);
  const now = new Date();
  if (host.kind === 'character') {
    const update = {
      $pull: { artworks: { _id: aid } },
      $set: { updated_at: now },
    };
    if (options.hostMainImageId !== undefined) {
      update.$set.main_image_id = options.hostMainImageId;
    }
    await getDb().collection('characters').updateOne({ _id: host._id }, update);
    return;
  }
  const update = {
    $pull: { 'beats.$[b].artworks': { _id: aid } },
    $set: { 'beats.$[b].updated_at': now, updated_at: now },
  };
  if (options.hostMainImageId !== undefined) {
    update.$set['beats.$[b].main_image_id'] = options.hostMainImageId;
  }
  await getDb().collection('plots').updateOne(
    { _id: host.plot._id },
    update,
    { arrayFilters: [{ 'b._id': host._id }] },
  );
}

function readArtworks(host) {
  if (host.kind === 'character') return host.doc.artworks || [];
  return host.beat.artworks || [];
}

function readHostMainImageId(host) {
  if (host.kind === 'character') return host.doc.main_image_id || null;
  return host.beat.main_image_id || null;
}

function findArtworkInList(artworks, artworkId) {
  const oid = toOid(artworkId);
  return artworks.find((a) => a?._id && oid.equals(a._id)) || null;
}

function oidEquals(a, b) {
  if (!a || !b) return false;
  if (a instanceof ObjectId) return a.equals(b);
  if (b instanceof ObjectId) return b.equals(a);
  return String(a) === String(b);
}

// ─── Public API ────────────────────────────────────────────────────────────

// Create a "done" artwork in one shot — used by the import flow where the
// result image already exists in GridFS. No prompt, no refs, no job. The
// `source: 'imported'` field is set so consumers can tell this apart from
// generated artwork. `source` is set only at creation; patchArtwork's
// PATCHABLE allowlist rejects it on updates.
export async function appendDoneArtwork({
  projectId,
  hostType,
  hostId,
  resultImageId,
  name = '',
}) {
  const host = await loadHost(projectId, hostType, hostId);
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
  await pushArtwork(host, artwork);
  logger.info(
    `mongo: ${host.kind} artwork import id=${host._id} artwork=${artwork._id} result=${artwork.result_image_id}`,
  );
  return { artwork, host_id: host._id };
}

// Create a pending artwork on the host. The caller (the jobs runner)
// kicks off the background work after this returns. The returned artwork
// has status='pending', no result_image_id, and a fresh _id.
export async function createPendingArtwork({
  projectId,
  hostType,
  hostId,
  prompt,
  name = '',
  model,
  referenceImageIds = [],
  jobId,
}) {
  const host = await loadHost(projectId, hostType, hostId);
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
  await pushArtwork(host, artwork);
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

export async function patchArtwork({ projectId, hostType, hostId, artworkId, patch }) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('patchArtwork: patch must be an object');
  }
  const host = await loadHost(projectId, hostType, hostId);
  const current = findArtworkInList(readArtworks(host), artworkId);
  if (!current) throw new Error(`Artwork ${artworkId} not found on ${host.kind} ${host._id}`);
  const fields = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!PATCHABLE.has(k)) {
      throw new Error(`patchArtwork: unknown field "${k}"`);
    }
    if (k === 'reference_image_ids') {
      if (!Array.isArray(v)) throw new Error('reference_image_ids must be an array');
      fields[k] = v.map(toOid);
    } else if (k === 'job_id') {
      fields[k] = v == null ? null : String(v);
    } else {
      fields[k] = v == null ? (k === 'name' || k === 'last_edit_prompt' ? '' : null) : String(v);
    }
  }
  await setArtworkFields(host, current._id, fields);
  const updated = await fetchArtwork(host, current._id);
  logger.info(
    `mongo: ${host.kind} artwork patch id=${host._id} artwork=${current._id} fields=[${Object.keys(patch).join(',')}]`,
  );
  return { artwork: updated, host_id: host._id };
}

// Update status (pending/done/error) and optionally error_message.
export async function setArtworkStatus({
  projectId,
  hostType,
  hostId,
  artworkId,
  status,
  errorMessage = null,
}) {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`setArtworkStatus: invalid status "${status}"`);
  }
  const host = await loadHost(projectId, hostType, hostId);
  const current = findArtworkInList(readArtworks(host), artworkId);
  if (!current) throw new Error(`Artwork ${artworkId} not found on ${host.kind} ${host._id}`);
  const fields = {
    status,
    error_message: status === 'error' ? String(errorMessage || 'Unknown error') : null,
  };
  if (status !== 'pending') fields.job_id = null;
  await setArtworkFields(host, current._id, fields);
  const updated = await fetchArtwork(host, current._id);
  logger.info(
    `mongo: ${host.kind} artwork status id=${host._id} artwork=${current._id} status=${status}`,
  );
  return { artwork: updated, host_id: host._id };
}

// Set a new result_image_id on the artwork. When `rotateToPrevious` is true
// (the in-line edit path), the current result becomes previous and any
// previously stored previous becomes an orphan returned for GridFS cleanup.
// Otherwise (regenerate or initial generate) the prior result_image_id is
// returned as an orphan if it existed.
export async function setArtworkResult({
  projectId,
  hostType,
  hostId,
  artworkId,
  resultImageId,
  rotateToPrevious = false,
}) {
  const host = await loadHost(projectId, hostType, hostId);
  const current = findArtworkInList(readArtworks(host), artworkId);
  if (!current) throw new Error(`Artwork ${artworkId} not found on ${host.kind} ${host._id}`);
  const newResult = toOid(resultImageId);
  let nextPrevious = current.previous_result_image_id || null;
  let orphanedImageId = null;
  if (rotateToPrevious) {
    if (current.result_image_id) {
      orphanedImageId = nextPrevious || null;
      nextPrevious = current.result_image_id;
    }
  } else {
    orphanedImageId = current.result_image_id || null;
  }
  // If the artwork being updated was hosting the main image, follow the
  // result forward so main_image_id doesn't point at a deleted orphan. The
  // image being replaced is the rotated-out current in both branches.
  const hostMain = readHostMainImageId(host);
  const replacedId = current.result_image_id;
  const fields = {
    result_image_id: newResult,
    previous_result_image_id: nextPrevious || null,
    status: 'done',
    error_message: null,
    job_id: null,
  };
  const opts = {};
  const mainImageIdChange = oidEquals(hostMain, replacedId)
    ? { changed: true, value: newResult }
    : null;
  if (mainImageIdChange) opts.hostMainImageId = newResult;
  await setArtworkFields(host, current._id, fields, opts);
  const updated = await fetchArtwork(host, current._id);
  logger.info(
    `mongo: ${host.kind} artwork result id=${host._id} artwork=${current._id} result=${newResult}${
      orphanedImageId ? ` orphan=${orphanedImageId}` : ''
    }${mainImageIdChange ? ` main->${newResult}` : ''}`,
  );
  return { artwork: updated, host_id: host._id, orphanedImageId, mainImageIdChange };
}

// Swap previous_result_image_id → result_image_id. The image that was
// current is reported as orphaned for GridFS cleanup (no redo, per spec).
export async function undoArtworkEdit({ projectId, hostType, hostId, artworkId }) {
  const host = await loadHost(projectId, hostType, hostId);
  const current = findArtworkInList(readArtworks(host), artworkId);
  if (!current) throw new Error(`Artwork ${artworkId} not found on ${host.kind} ${host._id}`);
  if (!current.previous_result_image_id) {
    const err = new Error('Nothing to undo — no previous image stored.');
    err.status = 400;
    throw err;
  }
  const orphanedImageId = current.result_image_id || null;
  const restored = current.previous_result_image_id;
  const fields = {
    result_image_id: restored,
    previous_result_image_id: null,
    last_edit_prompt: '',
  };
  const opts = {};
  const hostMain = readHostMainImageId(host);
  const mainImageIdChange = oidEquals(hostMain, current.result_image_id)
    ? { changed: true, value: restored }
    : null;
  if (mainImageIdChange) opts.hostMainImageId = restored;
  await setArtworkFields(host, current._id, fields, opts);
  const updated = await fetchArtwork(host, current._id);
  logger.info(
    `mongo: ${host.kind} artwork undo id=${host._id} artwork=${current._id} orphan=${orphanedImageId}${mainImageIdChange ? ` main->${restored}` : ''}`,
  );
  return { artwork: updated, host_id: host._id, orphanedImageId, mainImageIdChange };
}

// Remove the artwork from the host. Returns the image ids that were
// attached so the caller can purge them from GridFS.
export async function removeArtwork({ projectId, hostType, hostId, artworkId }) {
  const host = await loadHost(projectId, hostType, hostId);
  const removed = findArtworkInList(readArtworks(host), artworkId);
  if (!removed) throw new Error(`Artwork ${artworkId} not found on ${host.kind} ${host._id}`);
  const hostMain = readHostMainImageId(host);
  const mainImageIdChange =
    oidEquals(hostMain, removed.result_image_id) ||
    oidEquals(hostMain, removed.previous_result_image_id)
      ? { changed: true, value: null }
      : null;
  const opts = mainImageIdChange ? { hostMainImageId: null } : {};
  await pullArtwork(host, removed._id, opts);
  const removed_image_ids = [
    removed.result_image_id,
    removed.previous_result_image_id,
  ].filter(Boolean);
  logger.info(
    `mongo: ${host.kind} artwork remove id=${host._id} artwork=${removed._id} images=[${removed_image_ids.join(',')}]${mainImageIdChange ? ' main->null' : ''}`,
  );
  return { host_id: host._id, removed, removed_image_ids, mainImageIdChange };
}

// Read a single artwork.
export async function getArtwork({ projectId, hostType, hostId, artworkId }) {
  const host = await loadHost(projectId, hostType, hostId);
  const artwork = findArtworkInList(readArtworks(host), artworkId);
  if (!artwork) return null;
  return { artwork, host_id: host._id, host_kind: host.kind };
}

// List artworks for a host. Used by /api/beats/with-artwork and similar.
export async function listArtworks({ projectId, hostType, hostId }) {
  const host = await loadHost(projectId, hostType, hostId);
  return { artworks: readArtworks(host), host_id: host._id };
}

// Exported for test usage to detect when an artwork's main-image follow
// would need to update the host. Kept here so other modules don't duplicate
// the ObjectId comparison logic.
export { oidEquals, fetchHostMainImageId };
