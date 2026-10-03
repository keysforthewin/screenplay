// Beat-critique run engine. Runs all facets in parallel as structured-output
// Anthropic calls (criteria scored against anchors + ranked issues; the facet
// score is derived in critiqueScoring.js), persists each as it lands, and
// streams full job snapshots to SSE subscribers (registry + pub/sub replicated
// from falVideoGenerate.js). Latest-only persistence via src/mongo/critiques.js.

import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { modelFor } from '../llm/modelSlots.js';
import { logger } from '../log.js';
import { getAnthropic } from '../anthropic/client.js';
import { resolveProjectId } from '../mongo/projects.js';
import { getBeat } from '../mongo/plots.js';
import { FACETS, facetStubs, criteriaKeys } from './critiqueFacets.js';
import { buildCritiqueContext } from './critiqueContext.js';
import { normalizeFacetResult, deriveOverall } from './critiqueScoring.js';
import {
  setCritiquePending,
  updateCritiqueFacet,
  finalizeCritique,
} from '../mongo/critiques.js';

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

// The structured answer for one facet. Per facet because the criterion keys
// are an enum. Structured outputs strip minimum/maximum, so scores are
// clamped in critiqueScoring.js instead.
export function facetOutputSchema(facet) {
  const keys = criteriaKeys(facet);
  return {
    type: 'object',
    additionalProperties: false,
    required: ['criteria', 'issues', 'strengths', 'summary'],
    properties: {
      criteria: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'applicable', 'score', 'evidence', 'rationale'],
          properties: {
            key: { type: 'string', enum: keys },
            applicable: { type: 'boolean', description: 'false only when the context this criterion needs is absent' },
            score: { type: 'integer', description: 'Integer 1-10 against the anchors; ignored when not applicable' },
            evidence: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['quote', 'note'],
                properties: {
                  quote: { type: 'string', description: 'Verbatim from the beat, at most 200 characters' },
                  note: { type: 'string', description: 'What this quote shows about the criterion' },
                },
              },
            },
            rationale: { type: 'string', description: 'One or two sentences: why this anchor' },
          },
        },
      },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['severity', 'criterion', 'quote', 'problem', 'fix'],
          properties: {
            severity: { type: 'string', enum: ['must_fix', 'should_fix', 'nit'] },
            criterion: { type: 'string', enum: keys },
            quote: { type: 'string', description: 'The offending line(s), verbatim' },
            problem: { type: 'string', description: 'One sentence' },
            fix: { type: 'string', description: 'The concrete change: the rewritten line, the slug to add, the line to cut' },
          },
        },
      },
      strengths: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string', description: 'A few sentences a screenwriter can act on' },
    },
  };
}

// Default per-facet generator: one structured-output Anthropic call. Override
// in tests — the override may return the rich shape or the legacy
// {score, comments}; both go through normalizeFacetResult.
let facetGeneratorOverride = null;
export function _setFacetGeneratorForTests(fn) {
  facetGeneratorOverride = fn;
}

async function generateFacet(facet, ctx) {
  if (facetGeneratorOverride) return facetGeneratorOverride(facet, ctx);
  const client = getAnthropic();
  const ask = () => client.messages.create({
    model: modelFor('critique'),
    max_tokens: 8000,
    system: facet.systemPrompt,
    output_config: { format: { type: 'json_schema', schema: facetOutputSchema(facet) } },
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: `${facet.buildContext(ctx)}\n\nScore every criterion against its anchors and return the JSON object.` }],
      },
    ],
  });
  const textOf = (r) => (r?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const parse = (r) => { try { return JSON.parse(textOf(r)); } catch { return null; } };
  let resp = await ask();
  if (resp?.stop_reason === 'max_tokens') throw new Error('critique answer was cut off (max_tokens)');
  let parsed = parse(resp);
  // An empty or unparsable answer (seen from the coding-agent providers) is
  // asked once more rather than failing the facet outright.
  if (!parsed) {
    logger.warn(`critique gen: facet ${facet.key} returned no JSON (stop_reason ${resp?.stop_reason || '?'}); asking again`);
    resp = await ask();
    parsed = parse(resp);
  }
  if (!parsed) throw new Error('model did not return a critique');
  return parsed;
}

async function runOneFacet(facet, ctx, job, projectId, beatId) {
  try {
    const raw = await generateFacet(facet, ctx);
    const result = normalizeFacetResult(raw, facet);
    if (result.score == null) throw new Error('model scored no applicable criterion');
    const patch = { ...result, status: 'done', error_message: null };
    updateJobFacet(job, facet.key, patch);
    await updateCritiqueFacet(projectId, beatId, facet.key, patch);
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
    await setCritiquePending(projectId, beat._id, { model: modelFor('critique'), facets: facetStubs() });
    job.status = 'running';
    publish(job);

    const ctx = await buildCritiqueContext(projectId, beat);
    await Promise.allSettled(FACETS.map((f) => runOneFacet(f, ctx, job, projectId, beat._id)));

    const done = job.facets.filter((f) => f.status === 'done');
    const errored = job.facets.filter((f) => f.status === 'error');
    const overall = deriveOverall(job.facets, FACETS);
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
  // Concurrency-safe under Node's single-threaded event loop: there is no
  // await between this has-check and the add below, so once the first caller
  // adds busyKey, every later caller sees it and gets 409 — even though
  // resolveProjectId/getBeat awaited earlier in this function.
  if (busyBeats.has(busyKey)) {
    throw httpError('A critique is already running for this beat.', 409);
  }
  busyBeats.add(busyKey);
  const job = createCritiqueJob(busyKey);
  setImmediate(() => {
    runCritique({ projectId, job })
      // runCritique catches its own errors, but keep this defensive .catch so a
      // future change can never turn this fire-and-forget into an unhandledRejection.
      .catch((e) => logger.error(`critique gen: background run failed: ${e.message}`))
      .finally(() => busyBeats.delete(busyKey));
  });
  return job.job_id;
}
