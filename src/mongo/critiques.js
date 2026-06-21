// Per-beat critique persistence. A critique is a single overwritten object on
// the beat (latest-only, no history) plus a one-slot `previous_body` for Undo.
// All writes are atomic arrayFilter updates on plots.beats.$[b] (and the nested
// facets.$[f]) — never whole-array $set — mirroring src/mongo/artworks.js.

import { getDb } from './client.js';
import { logger } from '../log.js';
import { getBeat } from './plots.js';
import { resolveProjectId } from './projects.js';

const col = () => getDb().collection('plots');

// Resolve {projectId, beatId} to the canonical beat ObjectId (id|order|name),
// scoped to the project. Returns null if not found.
async function resolveBeatOid(projectId, beatId) {
  const beat = await getBeat(projectId, String(beatId));
  return beat?._id || null;
}

export async function getBeatCritique(projectId, beatId) {
  projectId = await resolveProjectId(projectId);
  const beat = await getBeat(projectId, String(beatId));
  return beat?.critique || null;
}

export async function setCritiquePending(projectId, beatId, { model, facets } = {}) {
  projectId = await resolveProjectId(projectId);
  const oid = await resolveBeatOid(projectId, beatId);
  if (!oid) throw new Error(`Beat not found: ${beatId}`);
  const now = new Date();
  const critique = {
    generated_at: now,
    model: String(model || ''),
    status: 'pending',
    overall: null,
    facets: (facets || []).map((f) => ({ ...f })),
  };
  const result = await col().updateOne(
    { project_id: projectId },
    { $set: { 'beats.$[b].critique': critique, 'beats.$[b].updated_at': now, updated_at: now } },
    { arrayFilters: [{ 'b._id': oid }] },
  );
  if (!result.matchedCount) throw new Error(`setCritiquePending: beat ${oid} not found`);
  logger.info(`mongo: critique pending beat=${oid} facets=${critique.facets.length}`);
}

export async function updateCritiqueFacet(projectId, beatId, facetKey, patch = {}) {
  projectId = await resolveProjectId(projectId);
  const oid = await resolveBeatOid(projectId, beatId);
  if (!oid) throw new Error(`Beat not found: ${beatId}`);
  const now = new Date();
  const $set = { 'beats.$[b].updated_at': now, updated_at: now };
  for (const k of ['score', 'comments', 'status', 'error_message']) {
    if (patch[k] !== undefined) $set[`beats.$[b].critique.facets.$[f].${k}`] = patch[k];
  }
  const result = await col().updateOne(
    { project_id: projectId },
    { $set },
    { arrayFilters: [{ 'b._id': oid }, { 'f.key': String(facetKey) }] },
  );
  if (!result.matchedCount) throw new Error(`updateCritiqueFacet: beat ${oid} facet ${facetKey} not found`);
}

export async function finalizeCritique(projectId, beatId, { status, overall } = {}) {
  projectId = await resolveProjectId(projectId);
  const oid = await resolveBeatOid(projectId, beatId);
  if (!oid) throw new Error(`Beat not found: ${beatId}`);
  const now = new Date();
  await col().updateOne(
    { project_id: projectId },
    {
      $set: {
        'beats.$[b].critique.status': status,
        'beats.$[b].critique.overall': overall ?? null,
        'beats.$[b].critique.generated_at': now,
        'beats.$[b].updated_at': now,
        updated_at: now,
      },
    },
    { arrayFilters: [{ 'b._id': oid }] },
  );
  logger.info(`mongo: critique finalize beat=${oid} status=${status} overall=${overall ?? 'null'}`);
}

export async function stashPreviousBody(projectId, beatId, body) {
  projectId = await resolveProjectId(projectId);
  const oid = await resolveBeatOid(projectId, beatId);
  if (!oid) throw new Error(`Beat not found: ${beatId}`);
  const now = new Date();
  await col().updateOne(
    { project_id: projectId },
    { $set: { 'beats.$[b].previous_body': String(body ?? ''), 'beats.$[b].updated_at': now, updated_at: now } },
    { arrayFilters: [{ 'b._id': oid }] },
  );
}

export async function getPreviousBody(projectId, beatId) {
  projectId = await resolveProjectId(projectId);
  const beat = await getBeat(projectId, String(beatId));
  const prev = beat?.previous_body;
  return prev == null || prev === '' ? null : String(prev);
}

export async function clearPreviousBody(projectId, beatId) {
  projectId = await resolveProjectId(projectId);
  const oid = await resolveBeatOid(projectId, beatId);
  if (!oid) throw new Error(`Beat not found: ${beatId}`);
  const now = new Date();
  await col().updateOne(
    { project_id: projectId },
    { $set: { 'beats.$[b].previous_body': null, 'beats.$[b].updated_at': now, updated_at: now } },
    { arrayFilters: [{ 'b._id': oid }] },
  );
}
