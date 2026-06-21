// Beat-critique run engine. Runs all facets in parallel as forced-tool Anthropic
// calls returning {score, comments}, persists each as it lands, and streams full
// job snapshots to SSE subscribers (registry + pub/sub replicated from
// falVideoGenerate.js). Latest-only persistence via src/mongo/critiques.js.

import { ObjectId } from 'mongodb';
import { logger } from '../log.js';
import { getAnthropic } from '../anthropic/client.js';
import { resolveProjectId } from '../mongo/projects.js';
import { getBeat } from '../mongo/plots.js';
import { FACETS, facetStubs } from './critiqueFacets.js';
import { buildCritiqueContext } from './critiqueContext.js';
import {
  setCritiquePending,
  updateCritiqueFacet,
  finalizeCritique,
} from '../mongo/critiques.js';

export const CRITIQUE_MODEL = 'claude-opus-4-8';
const TERMINAL_RETENTION_MS = 5 * 60 * 1000;

const jobs = new Map();
const listeners = new Map();
const busyBeats = new Set();

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function makeJobId() {
  return new ObjectId().toString();
}

export function getCritiqueJob(jobId) {
  return jobs.get(jobId) || null;
}

export function subscribeToCritiqueJob(jobId, cb) {
  let set = listeners.get(jobId);
  if (!set) { set = new Set(); listeners.set(jobId, set); }
  set.add(cb);
}

export function unsubscribeFromCritiqueJob(jobId, cb) {
  const set = listeners.get(jobId);
  if (!set) return;
  set.delete(cb);
  if (!set.size) listeners.delete(jobId);
}

export function serializeCritiqueJob(job) {
  if (!job) return null;
  return {
    job_id: job.job_id,
    beat_id: job.beat_id,
    status: job.status,
    overall: job.overall,
    started_at: job.started_at,
    finished_at: job.finished_at,
    error: job.error,
    facets: job.facets.map((f) => ({ ...f })),
  };
}

function publish(job) {
  const set = listeners.get(job.job_id);
  if (!set || !set.size) return;
  const snap = serializeCritiqueJob(job);
  for (const cb of set) {
    try { cb(snap); } catch (e) { logger.warn(`critique gen: listener threw: ${e.message}`); }
  }
}

export function createCritiqueJob(beatId) {
  const jobId = makeJobId();
  const job = {
    job_id: jobId,
    beat_id: String(beatId),
    status: 'queued',
    overall: null,
    error: null,
    started_at: new Date(),
    finished_at: null,
    facets: facetStubs(),
  };
  jobs.set(jobId, job);
  return job;
}

function updateJobFacet(job, key, patch) {
  const f = job.facets.find((x) => x.key === key);
  if (f) Object.assign(f, patch);
}

// The CRITIQUE_FACET tool — one score + a prose critique. Mirrors dialogCritique.
const CRITIQUE_FACET_TOOL = {
  name: 'critique_facet',
  description: 'Return a 1-10 score and a short prose critique for this one facet.',
  input_schema: {
    type: 'object',
    properties: {
      score: { type: 'integer', minimum: 1, maximum: 10, description: '10 = excellent on this facet; 1 = seriously deficient.' },
      comments: { type: 'string', description: 'A few sentences: what works, what is weak, and the single most important concrete fix.' },
    },
    required: ['score', 'comments'],
    additionalProperties: false,
  },
};

function clampScore(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return null;
  return Math.min(10, Math.max(1, v));
}

// Default per-facet generator: one forced-tool Anthropic call. Override in tests.
let facetGeneratorOverride = null;
export function _setFacetGeneratorForTests(fn) {
  facetGeneratorOverride = fn;
}

async function generateFacet(facet, ctx) {
  if (facetGeneratorOverride) return facetGeneratorOverride(facet, ctx);
  const client = getAnthropic();
  const resp = await client.messages.create({
    model: CRITIQUE_MODEL,
    max_tokens: 1024,
    system: facet.systemPrompt,
    tools: [CRITIQUE_FACET_TOOL],
    tool_choice: { type: 'tool', name: 'critique_facet' },
    messages: [{ role: 'user', content: [{ type: 'text', text: facet.buildContext(ctx) }] }],
  });
  const toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'critique_facet');
  if (!toolUse) throw new Error('model did not return a critique');
  return {
    score: clampScore(toolUse.input?.score),
    comments: typeof toolUse.input?.comments === 'string' ? toolUse.input.comments : '',
  };
}

async function runOneFacet(facet, ctx, job, projectId, beatId) {
  try {
    const { score, comments } = await generateFacet(facet, ctx);
    updateJobFacet(job, facet.key, { score, comments, status: 'done', error_message: null });
    await updateCritiqueFacet(projectId, beatId, facet.key, { score, comments, status: 'done', error_message: null });
  } catch (e) {
    updateJobFacet(job, facet.key, { score: null, comments: '', status: 'error', error_message: e.message });
    await updateCritiqueFacet(projectId, beatId, facet.key, { score: null, status: 'error', error_message: e.message })
      .catch((err) => logger.warn(`critique gen: persist facet error failed: ${err.message}`));
    logger.warn(`critique gen: facet ${facet.key} failed: ${e.message}`);
  } finally {
    publish(job);
  }
}

// The awaitable worker. Assembles context, runs facets in parallel, persists,
// streams snapshots, and finalizes with an overall score. Returns the job.
export async function runCritique({ projectId, job }) {
  projectId = await resolveProjectId(projectId);
  try {
    const beat = await getBeat(projectId, job.beat_id);
    if (!beat) throw new Error(`beat not found: ${job.beat_id}`);
    await setCritiquePending(projectId, beat._id, { model: CRITIQUE_MODEL, facets: facetStubs() });
    job.status = 'running';
    publish(job);

    const ctx = await buildCritiqueContext(projectId, beat);
    await Promise.allSettled(FACETS.map((f) => runOneFacet(f, ctx, job, projectId, beat._id)));

    const done = job.facets.filter((f) => f.status === 'done');
    const errored = job.facets.filter((f) => f.status === 'error');
    const overall = done.length
      ? Math.round(done.reduce((s, f) => s + f.score, 0) / done.length)
      : null;
    job.overall = overall;
    job.status = errored.length === 0 ? 'done' : done.length ? 'partial' : 'error';
    job.finished_at = new Date();
    await finalizeCritique(projectId, beat._id, { status: job.status, overall });
    publish(job);
    logger.info(`critique gen: beat=${beat._id} status=${job.status} overall=${overall ?? 'null'}`);
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    job.finished_at = new Date();
    publish(job);
    logger.error(`critique gen: run crashed: ${e.message}`);
  } finally {
    const id = job.job_id;
    setTimeout(() => { jobs.delete(id); listeners.delete(id); }, TERMINAL_RETENTION_MS).unref?.();
  }
  return job;
}

// Start a run in the background. Returns the job id immediately (202). Throws a
// 409 httpError if a run is already active for this beat.
export async function startCritiqueJob({ projectId, beatId }) {
  projectId = await resolveProjectId(projectId);
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw httpError(`beat not found: ${beatId}`, 404);
  const busyKey = beat._id.toString();
  if (busyBeats.has(busyKey)) {
    throw httpError('A critique is already running for this beat.', 409);
  }
  busyBeats.add(busyKey);
  const job = createCritiqueJob(busyKey);
  setImmediate(() => {
    runCritique({ projectId, job })
      .catch((e) => logger.error(`critique gen: background run failed: ${e.message}`))
      .finally(() => busyBeats.delete(busyKey));
  });
  return job.job_id;
}
