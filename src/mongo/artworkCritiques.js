// Per-beat ARTWORK critique persistence: `plots.beats[].artwork_critique`, a
// single overwritten object (latest-only, like `critique`). It holds the
// visual requirements the beat's writing imposes on its sets and characters,
// the vision audit of each subject's existing artwork, and the generation
// proposals for what is missing. All writes are atomic arrayFilter updates on
// plots.beats.$[b] (and the nested subjects.$[s] / proposals.$[p]).

import { ObjectId } from 'mongodb';
import { getDb } from './client.js';
import { logger } from '../log.js';
import { getBeat } from './plots.js';
import { resolveProjectId } from './projects.js';

const col = () => getDb().collection('plots');

async function resolveBeatOid(projectId, beatId) {
  const beat = await getBeat(projectId, String(beatId));
  if (!beat?._id) throw new Error(`Beat not found: ${beatId}`);
  return beat._id;
}

function oid(v) {
  if (v instanceof ObjectId) return v;
  const s = String(v || '');
  return /^[a-f0-9]{24}$/i.test(s) ? new ObjectId(s) : null;
}

export async function getBeatArtworkCritique(projectId, beatId) {
  projectId = await resolveProjectId(projectId);
  const beat = await getBeat(projectId, String(beatId));
  return beat?.artwork_critique || null;
}

// Remove the critique altogether ("Clear critique", and the first step of a
// re-check of everything): the page goes back to "not critiqued".
export async function clearBeatArtworkCritique(projectId, beatId) {
  projectId = await resolveProjectId(projectId);
  const beatOid = await resolveBeatOid(projectId, beatId);
  const now = new Date();
  await col().updateOne(
    { project_id: projectId },
    { $set: { 'beats.$[b].artwork_critique': null, 'beats.$[b].updated_at': now, updated_at: now } },
    { arrayFilters: [{ 'b._id': beatOid }] },
  );
  logger.info(`mongo: artwork critique cleared beat=${beatOid}`);
}

// Overwrite the whole object with a fresh pending run. `subjects` are stubs
// ({kind, id, name}); proposals start empty.
export async function setArtworkCritiquePending(projectId, beatId, { model, subjects = [] } = {}) {
  projectId = await resolveProjectId(projectId);
  const beatOid = await resolveBeatOid(projectId, beatId);
  const now = new Date();
  const doc = {
    status: 'pending',
    generated_at: now,
    model: String(model || ''),
    coverage: null,
    warnings: [],
    unlinked_mentions: [],
    subjects: subjects.map((s) => ({
      kind: s.kind,
      id: oid(s.id),
      name: String(s.name || ''),
      status: 'pending',
      error_message: null,
      accuracy_score: null,
      summary: '',
      requirements: [],
      artworks: [],
    })),
    proposals: [],
  };
  await col().updateOne(
    { project_id: projectId },
    { $set: { 'beats.$[b].artwork_critique': doc, 'beats.$[b].updated_at': now, updated_at: now } },
    { arrayFilters: [{ 'b._id': beatOid }] },
  );
  logger.info(`mongo: artwork critique pending beat=${beatOid} subjects=${doc.subjects.length}`);
  return doc;
}

// Start a run that KEEPS what the last one learned: requirements, audited
// artwork entries, the inventory, the proposals and the last run's warnings
// stay (the page keeps showing them while the run works; finalize replaces
// the warnings); only the run status resets. Subjects no longer on the beat's roster are dropped
// (with their proposals), new ones start as stubs. With no critique on file
// this is setArtworkCritiquePending.
export async function beginArtworkCritiqueRun(projectId, beatId, { model, subjects = [] } = {}) {
  projectId = await resolveProjectId(projectId);
  const prior = await getBeatArtworkCritique(projectId, beatId);
  if (!prior) return setArtworkCritiquePending(projectId, beatId, { model, subjects });
  const beatOid = await resolveBeatOid(projectId, beatId);
  const now = new Date();
  const same = (a, b) => a.kind === b.kind && String(a.id) === String(b.id);
  const doc = {
    ...prior,
    status: 'pending',
    model: String(model || ''),
    subjects: subjects.map((s) => {
      const old = (prior.subjects || []).find((p) => same(p, s));
      return {
        kind: s.kind,
        id: oid(s.id),
        name: String(s.name || ''),
        accuracy_score: null,
        summary: '',
        requirements: [],
        artworks: [],
        ...(old || {}),
        status: 'pending',
        error_message: null,
      };
    }),
    proposals: (prior.proposals || []).filter((p) => subjects.some((s) => s.kind === p.host_type && String(s.id) === String(p.host_id))),
  };
  await col().updateOne(
    { project_id: projectId },
    { $set: { 'beats.$[b].artwork_critique': doc, 'beats.$[b].updated_at': now, updated_at: now } },
    { arrayFilters: [{ 'b._id': beatOid }] },
  );
  logger.info(`mongo: artwork critique run (incremental) beat=${beatOid} subjects=${doc.subjects.length}`);
  return doc;
}

// Top-level fields a run sets besides status/coverage: the fingerprint of
// what the requirements were derived from, and the proposal list as a whole
// (pruning — appends go through appendArtworkCritiqueProposals).
const META_KEYS = ['requirements_sig', 'unlinked_mentions', 'proposals'];

export async function setArtworkCritiqueMeta(projectId, beatId, patch = {}) {
  projectId = await resolveProjectId(projectId);
  const beatOid = await resolveBeatOid(projectId, beatId);
  const $set = {};
  for (const k of META_KEYS) {
    if (patch[k] !== undefined) $set[`beats.$[b].artwork_critique.${k}`] = patch[k];
  }
  if (!Object.keys($set).length) return;
  await col().updateOne({ project_id: projectId }, { $set }, { arrayFilters: [{ 'b._id': beatOid }] });
}

const SUBJECT_KEYS = ['requirements', 'artworks', 'accuracy_score', 'summary', 'status', 'error_message', 'inventory', 'req_sig'];

export async function updateArtworkCritiqueSubject(projectId, beatId, subjectId, patch = {}) {
  projectId = await resolveProjectId(projectId);
  const beatOid = await resolveBeatOid(projectId, beatId);
  const sid = oid(subjectId);
  if (!sid) throw new Error(`invalid subject id: ${subjectId}`);
  const now = new Date();
  const $set = { 'beats.$[b].updated_at': now, updated_at: now };
  for (const k of SUBJECT_KEYS) {
    if (patch[k] !== undefined) $set[`beats.$[b].artwork_critique.subjects.$[s].${k}`] = patch[k];
  }
  const r = await col().updateOne(
    { project_id: projectId },
    { $set },
    { arrayFilters: [{ 'b._id': beatOid }, { 's.id': sid }] },
  );
  return r?.matchedCount ?? 0;
}

const ARTWORK_KEYS = ['result_image_id', 'fix'];

// Patch one audited artwork entry (subjects.$[s].artworks.$[a]) — the fix
// state and the image it now shows. Returns matchedCount (0 = unknown entry).
export async function updateArtworkCritiqueArtwork(projectId, beatId, subjectId, artworkId, patch = {}) {
  projectId = await resolveProjectId(projectId);
  const beatOid = await resolveBeatOid(projectId, beatId);
  const sid = oid(subjectId);
  const aid = oid(artworkId);
  if (!sid || !aid) throw new Error(`invalid subject/artwork id: ${subjectId}/${artworkId}`);
  const now = new Date();
  const $set = { 'beats.$[b].updated_at': now, updated_at: now };
  for (const k of ARTWORK_KEYS) {
    if (patch[k] !== undefined) $set[`beats.$[b].artwork_critique.subjects.$[s].artworks.$[a].${k}`] = patch[k];
  }
  const r = await col().updateOne(
    { project_id: projectId },
    { $set },
    { arrayFilters: [{ 'b._id': beatOid }, { 's.id': sid }, { 'a.artwork_id': aid }] },
  );
  return r?.matchedCount ?? 0;
}

// The audited entry for an artwork plus its subject, or null.
export async function findArtworkCritiqueArtwork(projectId, beatId, artworkId) {
  const critique = await getBeatArtworkCritique(projectId, beatId);
  const aid = oid(artworkId);
  if (!critique || !aid) return null;
  for (const subject of critique.subjects || []) {
    const artwork = (subject.artworks || []).find((a) => a?.artwork_id && aid.equals(a.artwork_id));
    if (artwork) return { subject, artwork };
  }
  return null;
}

export async function appendArtworkCritiqueProposals(projectId, beatId, proposals = []) {
  if (!proposals.length) return;
  projectId = await resolveProjectId(projectId);
  const beatOid = await resolveBeatOid(projectId, beatId);
  const now = new Date();
  await col().updateOne(
    { project_id: projectId },
    {
      $push: { 'beats.$[b].artwork_critique.proposals': { $each: proposals } },
      $set: { 'beats.$[b].updated_at': now, updated_at: now },
    },
    { arrayFilters: [{ 'b._id': beatOid }] },
  );
}

export async function finalizeArtworkCritique(projectId, beatId, { status, coverage = null, warnings = [], unlinked_mentions = [] } = {}) {
  projectId = await resolveProjectId(projectId);
  const beatOid = await resolveBeatOid(projectId, beatId);
  const now = new Date();
  await col().updateOne(
    { project_id: projectId },
    {
      $set: {
        'beats.$[b].artwork_critique.status': status,
        'beats.$[b].artwork_critique.coverage': coverage,
        'beats.$[b].artwork_critique.warnings': warnings,
        'beats.$[b].artwork_critique.unlinked_mentions': unlinked_mentions,
        'beats.$[b].artwork_critique.generated_at': now,
        'beats.$[b].updated_at': now,
        updated_at: now,
      },
    },
    { arrayFilters: [{ 'b._id': beatOid }] },
  );
  logger.info(`mongo: artwork critique finalize beat=${beatOid} status=${status} coverage=${coverage?.pct ?? 'null'}`);
}

// Recompute and store coverage from the subjects currently on the doc.
export async function setArtworkCritiqueCoverage(projectId, beatId, coverage) {
  projectId = await resolveProjectId(projectId);
  const beatOid = await resolveBeatOid(projectId, beatId);
  await col().updateOne(
    { project_id: projectId },
    { $set: { 'beats.$[b].artwork_critique.coverage': coverage } },
    { arrayFilters: [{ 'b._id': beatOid }] },
  );
}

const PROPOSAL_KEYS = ['status', 'model', 'artwork_id', 'result_image_id', 'error_message', 'generated_at', 'prompt', 'reference_image_ids', 'name', 'promoted_wardrobe'];

// Returns matchedCount so callers can 404 an unknown proposal. The beat
// filter always matches once the beat resolves, so a 0 here means the
// proposal id was not on the critique.
export async function updateArtworkCritiqueProposal(projectId, beatId, proposalId, patch = {}) {
  projectId = await resolveProjectId(projectId);
  const beatOid = await resolveBeatOid(projectId, beatId);
  const pid = oid(proposalId);
  if (!pid) return 0;
  const existing = await getArtworkCritiqueProposal(projectId, beatOid, pid);
  if (!existing) return 0;
  const now = new Date();
  const $set = { 'beats.$[b].updated_at': now, updated_at: now };
  for (const k of PROPOSAL_KEYS) {
    if (patch[k] !== undefined) $set[`beats.$[b].artwork_critique.proposals.$[p].${k}`] = patch[k];
  }
  await col().updateOne(
    { project_id: projectId },
    { $set },
    { arrayFilters: [{ 'b._id': beatOid }, { 'p._id': pid }] },
  );
  return 1;
}

export async function getArtworkCritiqueProposal(projectId, beatId, proposalId) {
  const critique = await getBeatArtworkCritique(projectId, beatId);
  const pid = oid(proposalId);
  if (!critique || !pid) return null;
  return (critique.proposals || []).find((p) => p?._id && pid.equals(p._id)) || null;
}
