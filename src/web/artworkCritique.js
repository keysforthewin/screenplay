// Beat ARTWORK critique: does the art library hold the pictures this beat's
// writing needs?
// A: the visual requirements the beat imposes on each linked set and
//    character (text only, one call, scene-planning slot);
// Phase 1 — COVERAGE (text only, one call per subject): the requirements
//    matched against EVERY artwork's description → which pieces answer what;
// Phase 2 — QUALITY (vision, the `artwork_review` slot): the best matches
//    are looked at and scored on the review rubric — per artwork: the
//    requirements it really fits, criterion scores, accuracy issues and
//    keep / edit / regenerate. A reviewed image is never sent again until it
//    or the requirements change;
// C: a generation proposal for every requirement nothing answers, or whose
//    best piece is to be made again (one call per subject with gaps) —
//    prompt, owning host, reference picks.
// Persisted on the beat (src/mongo/artworkCritiques.js); a re-run carries the
// previous run's requirements, audits and proposals forward. A second
// job renders the proposals the user ticks onto the OWNING set / character
// through the same pending-artwork + inline-render pair the image sheets use.
// Both registries mirror critiqueGenerate.js (jobs/listeners Maps, a busy set,
// full snapshots to SSE subscribers, five-minute retention).

import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import sharp from 'sharp';
import { logger } from '../log.js';
import { modelFor } from '../llm/modelSlots.js';
import { getAnthropic } from '../anthropic/client.js';
import { resolveProjectId } from '../mongo/projects.js';
import { getBeat } from '../mongo/plots.js';
import { findImageFile } from '../mongo/images.js';
import { computeAnthropicImageTokens } from '../agent/imageTokens.js';
import { recordAnthropicTextUsage, recordAnthropicImageInputUsage } from '../mongo/tokenUsage.js';
import {
  getBeatArtworkCritique,
  clearBeatArtworkCritique,
  setArtworkCritiquePending,
  beginArtworkCritiqueRun,
  setArtworkCritiqueMeta,
  updateArtworkCritiqueSubject,
  appendArtworkCritiqueProposals,
  finalizeArtworkCritique,
  setArtworkCritiqueCoverage,
  updateArtworkCritiqueProposal,
  updateArtworkCritiqueArtwork,
  findArtworkCritiqueArtwork,
} from '../mongo/artworkCritiques.js';
import { setBeatClimb } from '../mongo/climbs.js';
import { getArtwork } from '../mongo/artworks.js';
import { loadFullBeatContext, formatCharacterFull, formatSetFull } from './beatContext.js';
import { loadImageInput } from './beatPlanShared.js';
import { buildReferenceCatalog, formatReferenceCatalog } from './referenceCatalog.js';
import { isValidImageModel, IMAGE_MODEL_ERROR, assertImageModelConfigured, normalizeImageModel } from './imageModelValidate.js';
import { runPool, recordProgress, assertShotsSatisfyModelReferences } from './imageSheetJobs.js';
import { createPendingArtworkViaGateway, setArtworkStatusViaGateway, setCharacterWardrobeImageViaGateway } from './gateway.js';
import { wardrobeImageId, wardrobeLine } from './wardrobe.js';
import { generateArtworkImageInline, startEditArtworkJob, undoArtworkEdit } from './artworkJobs.js';
import {
  MAX_SUBJECTS,
  AUDIT_BATCH_SIZE,
  MATCH_SYSTEM_PROMPT,
  MATCH_SCHEMA,
  buildMatchText,
  normalizeMatches,
  matchedEntry,
  reviewCandidates,
  requirementNeedsRegeneration,
  regenerationBrief,
  normalizeArtworkAudit,
  requirementsSignature,
  auditEntryIsCurrent,
  deriveRequirementStatus,
  subjectAccuracy,
  summarizeSubjectAudit,
  REQUIREMENTS_SYSTEM_PROMPT,
  REQUIREMENTS_SCHEMA,
  AUDIT_SYSTEM_PROMPT,
  AUDIT_SCHEMA,
  PROPOSALS_SYSTEM_PROMPT,
  PROPOSALS_SCHEMA,
  buildSubjectRoster,
  buildAuditText,
  buildProposalsText,
  normalizeRequirements,
  normalizeProposals,
  computeCoverage,
  subjectKey,
  characterPortraitId,
  orderCharacterReferences,
  rebindCharacterPrompt,
} from './artworkCritiqueRules.js';
import { getCharacter } from '../mongo/characters.js';
import { describeArtwork } from './artworkVisionWorker.js';

const TERMINAL_RETENTION_MS = 5 * 60 * 1000;
const SUBJECT_CONCURRENCY = 2;
const DESCRIBE_CONCURRENCY = 3;
const RENDER_CONCURRENCY = 3;
const VISION_WIDTH = 1024;
const MAX_OVERRIDE_PROMPT = 2000;

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function makeJobId() {
  return new ObjectId().toString();
}

// ───────────────────────────── Model calls ─────────────────────────────

// Test seam: { requirements({text}), audit({text, subject, artworks, requirements}),
// match?({text, subject, artworks, requirements}) (also read as `shortlist`),
// proposals({text, subject}), describe?({subject, artwork}) }. A missing
// requirements / audit / proposals throws so a test can never reach the
// network by accident; with no match() every piece is a candidate for every
// requirement, and describe is skipped.
let analyzerOverride = null;
export function _setArtworkCritiqueAnalyzerForTests(fns) {
  analyzerOverride = fns || null;
}

async function recordUsage({ model, resp, imageBuffers = [] }) {
  try {
    const imageTokens = imageBuffers.length ? computeAnthropicImageTokens(imageBuffers) : { total: 0, perImageTokens: [] };
    const input = Number(resp?.usage?.input_tokens) || 0;
    await recordAnthropicTextUsage({
      discordUser: null,
      channelId: null,
      model,
      totals: { input_tokens: Math.max(0, input - imageTokens.total), output_tokens: Number(resp?.usage?.output_tokens) || 0 },
    });
    if (imageBuffers.length) {
      await recordAnthropicImageInputUsage({ discordUser: null, channelId: null, model, perImageTokens: imageTokens.perImageTokens });
    }
  } catch (e) {
    logger.warn(`artwork critique: usage record failed: ${e?.message || e}`);
  }
}

// One structured-output call. `content` is the user content array (text and
// image blocks). An empty / unparsable answer is asked once more.
async function callStructured({ system, schema, content, imageBuffers = [], label, slot = 'storyboard' }) {
  const model = modelFor(slot);
  const ask = () => getAnthropic().messages.create({
    model,
    max_tokens: 16000,
    system,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }],
  });
  const textOf = (r) => (r?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const parse = (r) => { try { return JSON.parse(textOf(r)); } catch { return null; } };
  let resp = await ask();
  let parsed = parse(resp);
  if (!parsed) {
    logger.warn(`artwork critique: ${label} returned no JSON (stop_reason ${resp?.stop_reason || '?'}); asking again`);
    resp = await ask();
    parsed = parse(resp);
  }
  await recordUsage({ model, resp, imageBuffers });
  if (!parsed) throw new Error(`${label}: model did not return JSON`);
  return parsed;
}

// An artwork as the auditor sees it: a JPEG no wider than VISION_WIDTH.
async function visionImage(imageId) {
  const ref = await loadImageInput(imageId);
  if (!ref) return null;
  try {
    const buffer = await sharp(ref.buffer).rotate().resize({ width: VISION_WIDTH, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    return { buffer, contentType: 'image/jpeg' };
  } catch (e) {
    logger.warn(`artwork critique: could not resize image ${imageId}: ${e?.message || e}`);
    return { buffer: ref.buffer, contentType: ref.contentType };
  }
}

async function deriveRequirements({ text, subjects, beat = null }) {
  const userText = `${text}\n\n${buildSubjectRoster(subjects, { beat })}`;
  if (analyzerOverride) {
    if (typeof analyzerOverride.requirements !== 'function') throw new Error('test analyzer has no requirements()');
    return analyzerOverride.requirements({ text: userText, subjects });
  }
  return callStructured({
    system: REQUIREMENTS_SYSTEM_PROMPT,
    schema: REQUIREMENTS_SCHEMA,
    content: [{ type: 'text', text: userText }],
    label: 'requirements',
  });
}

// Vision audit of ONE batch of a subject's artwork (≤ AUDIT_BATCH_SIZE).
async function auditArtworkBatch({ beat, subject, requirements, artworks, matched = null }) {
  const text = buildAuditText({ beat, subject, subjectCard: subject.card, requirements, artworks, matched });
  if (analyzerOverride) {
    if (typeof analyzerOverride.audit !== 'function') throw new Error('test analyzer has no audit()');
    return analyzerOverride.audit({ text, subject, artworks, requirements });
  }
  const images = [];
  const content = [];
  for (let i = 0; i < artworks.length; i++) {
    const img = await visionImage(artworks[i].result_image_id);
    if (!img) continue;
    images.push(img.buffer);
    content.push({ type: 'text', text: `Artwork ${i + 1} — "${artworks[i].name || 'untitled'}":` });
    content.push({ type: 'image', source: { type: 'base64', media_type: img.contentType, data: img.buffer.toString('base64') } });
  }
  content.push({ type: 'text', text });
  // The reviewer has its own model slot (Admin → Models): the API, or the
  // host's Claude Code / Codex.
  return callStructured({ system: AUDIT_SYSTEM_PROMPT, schema: AUDIT_SCHEMA, content, imageBuffers: images, label: `review ${subject.name}`, slot: 'artwork_review' });
}

// Phase 1, text only: which pieces on file answer which requirement.
async function matchArtworks({ beat, subject, requirements, artworks }) {
  const text = buildMatchText({ beat, subject, subjectCard: subject.card, requirements, artworks });
  if (analyzerOverride) {
    const fn = analyzerOverride.match || analyzerOverride.shortlist;
    if (typeof fn === 'function') return fn({ text, subject, artworks, requirements });
    return { candidates: requirements.map((r) => ({ requirement_id: r.id, artwork_indexes: artworks.map((_, i) => i + 1) })), duplicate_groups: [] };
  }
  return callStructured({ system: MATCH_SYSTEM_PROMPT, schema: MATCH_SCHEMA, content: [{ type: 'text', text }], label: `match ${subject.name}` });
}

// The match reads descriptions, so every piece needs one. An artwork with
// neither a description nor a prompt (an import the vision seed has not
// reached) is described now, once — the text lands on the host artwork.
async function ensureArtworkDescriptions({ projectId, subject, warnings }) {
  const blank = subject.artworks.filter((a) => !a.description);
  if (!blank.length) return 0;
  let failed = 0;
  await runPool(blank, DESCRIBE_CONCURRENCY, async (a) => {
    try {
      let description = '';
      if (analyzerOverride) {
        if (typeof analyzerOverride.describe === 'function') description = await analyzerOverride.describe({ subject, artwork: a });
      } else {
        const out = await describeArtwork({ projectId, hostType: subject.kind, hostId: String(subject.id), artworkId: String(a._id) });
        description = String(out?.artwork?.description || '');
      }
      a.description = String(description || '');
    } catch (e) {
      failed += 1;
      logger.warn(`artwork critique: describe ${subject.name} artwork=${a._id} failed: ${e?.message || e}`);
    }
  });
  if (failed) warnings.push(`${subject.name}: ${failed} artwork(s) could not be described and are matched by name only.`);
  return blank.length - failed;
}

async function proposeForSubject({ beat, subject, requirements, audit, catalogText, direction = '' }) {
  const text = buildProposalsText({ beat, subject, subjectCard: subject.card, requirements, audit, catalogText, direction });
  if (analyzerOverride) {
    if (typeof analyzerOverride.proposals !== 'function') throw new Error('test analyzer has no proposals()');
    return analyzerOverride.proposals({ text, subject, requirements });
  }
  return callStructured({ system: PROPOSALS_SYSTEM_PROMPT, schema: PROPOSALS_SCHEMA, content: [{ type: 'text', text }], label: `proposals ${subject.name}` });
}

// ───────────────────────────── Analysis job ─────────────────────────────

const jobs = new Map();
const listeners = new Map();
const busyBeats = new Set();
// Beats an artwork climb (artworkClimb.js) holds for its whole run: the
// manual critique and generate routes answer 409 while the climb drives the
// same two jobs itself (`climb: true`).
const climbHolds = new Set();
const CLIMB_BUSY = 'A climb is running for this beat; wait for it to finish or cancel it.';

export function getArtworkCritiqueJob(jobId) {
  return jobs.get(jobId) || null;
}

export function subscribeToArtworkCritiqueJob(jobId, cb) {
  let set = listeners.get(jobId);
  if (!set) { set = new Set(); listeners.set(jobId, set); }
  set.add(cb);
}

export function unsubscribeFromArtworkCritiqueJob(jobId, cb) {
  const set = listeners.get(jobId);
  if (!set) return;
  set.delete(cb);
  if (!set.size) listeners.delete(jobId);
}

export function serializeArtworkCritiqueJob(job) {
  if (!job) return null;
  return {
    job_id: job.job_id,
    beat_id: job.beat_id,
    status: job.status,
    phase: job.phase,
    stage: job.stage,
    review_mode: job.review_mode || null,
    started_at: job.started_at,
    finished_at: job.finished_at,
    error: job.error,
    warnings: [...job.warnings],
    subjects: job.subjects.map((s) => ({ ...s })),
  };
}

function publish(job) {
  const set = listeners.get(job.job_id);
  if (!set || !set.size) return;
  const snap = serializeArtworkCritiqueJob(job);
  for (const cb of set) {
    try { cb(snap); } catch (e) { logger.warn(`artwork critique: listener threw: ${e.message}`); }
  }
}

function retire(job) {
  const id = job.job_id;
  setTimeout(() => { jobs.delete(id); listeners.delete(id); }, TERMINAL_RETENTION_MS).unref?.();
}

export function createArtworkCritiqueJob(beatId, { direction = '', force = false, focus = null, review = 'all', stage = 'all' } = {}) {
  const job = {
    job_id: makeJobId(),
    beat_id: String(beatId),
    direction: String(direction || ''),
    // force: forget everything a previous run learned. focus: artwork ids a
    // climb round changed (reviewed whatever their descriptions matched).
    force: !!force,
    // The manual run in two steps. 'coverage': start from nothing — derive
    // the requirements, match them to the descriptions, draft what is
    // missing; no image is looked at. 'quality': look at the matched pieces
    // again (every review on file is redone) and update them in place.
    // 'all': both, reusing whatever is still current (the climb).
    stage: stage === 'coverage' || stage === 'quality' ? stage : 'all',
    focus: focus && focus.length ? focus.map(String) : null,
    // 'all': review the best matches of every requirement. 'auto' (a climb):
    // the same once nothing is missing; until then only `focus` is reviewed.
    review: review === 'auto' ? 'auto' : 'all',
    review_mode: null,
    status: 'queued',
    phase: 'queued',
    error: null,
    warnings: [],
    subjects: [],
    started_at: new Date(),
    finished_at: null,
  };
  jobs.set(job.job_id, job);
  return job;
}

// The subjects a beat audits: its linked sets first, then its characters,
// each with EVERY finished artwork on file (library order, oldest first) and
// a text card for the prompts.
function collectSubjects(ctx, warnings, beat = null) {
  const all = [
    ...(ctx.sets || []).map((doc) => ({ kind: 'set', doc })),
    ...(ctx.characters || []).map((doc) => ({ kind: 'character', doc })),
  ];
  if (all.length > MAX_SUBJECTS) {
    warnings.push(`${all.length} linked subjects; only the first ${MAX_SUBJECTS} were audited (sets first).`);
  }
  return all.slice(0, MAX_SUBJECTS).map(({ kind, doc }) => ({
    kind,
    id: doc._id,
    name: String(doc.name || ''),
    doc,
    card: kind === 'set' ? formatSetFull(doc) : formatCharacterFull(doc, { beat }),
    artworks: (doc.artworks || [])
      .filter((a) => a?.status === 'done' && a.result_image_id)
      .map((a) => ({
        _id: a._id,
        result_image_id: a.result_image_id,
        name: String(a.name || ''),
        description: String(a.description || a.prompt || ''),
      })),
  }));
}

function jobSubject(job, subject) {
  return job.subjects.find((s) => s.kind === subject.kind && s.id === String(subject.id));
}

// Fingerprint of everything pass A reads. Unchanged → the stored
// requirements (and with them every cached audit) are reused.
function requirementsRunSignature(ctx, subjects, beat) {
  return createHash('sha1').update(`${ctx.text}\n${buildSubjectRoster(subjects, { beat })}`).digest('hex');
}

function sameSubject(a, b) {
  return a.kind === b.kind && String(a.id) === String(b.id);
}

// ── Phase 1: match ──
// One text call over the whole library's descriptions (cached on the subject
// as `inventory` while the requirements and the library read the same) →
// which pieces answer which requirement. No image is looked at. Returns the
// working state phase 2 continues from.
async function matchSubject({ projectId, beat, subject, priorSubject, warnings, stats, rereview = false }) {
  const lock = subject.kind === 'character' ? wardrobeLine(subject.doc, beat) : '';
  const reqSig = requirementsSignature(subject.requirements, lock);
  const total = subject.artworks.length;
  const priorEntries = new Map((priorSubject?.artworks || []).map((e) => [String(e.artwork_id), e]));
  const state = { reqSig, priorEntries, reviewed: new Map(), stale: new Map(), matches: [], inventory: { total, matched: 0, reviewed: 0, duplicates: [] } };
  if (!total) {
    warnings.push(`${subject.name} has no artwork on file — every requirement is missing and its proposals carry no references.`);
    return state;
  }
  if (!subject.requirements.length) return state;
  stats.described += await ensureArtworkDescriptions({ projectId, subject, warnings });
  const library = subject.artworks.map((a) => `${String(a._id)}:${createHash('sha1').update(`${a.name}\n${a.description}`).digest('hex')}`).join(',');
  const librarySig = createHash('sha1').update(`${reqSig}|${library}`).digest('hex');
  const stored = priorSubject?.inventory;
  let matches;
  let duplicates;
  if (Array.isArray(stored?.matches) && stored.req_sig === reqSig && stored.sig === librarySig) {
    matches = stored.matches.map((m) => ({ ...m, artwork_id: String(m.artwork_id) }));
    duplicates = stored.duplicates || [];
  } else {
    const raw = await matchArtworks({ beat, subject, requirements: subject.requirements, artworks: subject.artworks });
    const normalized = normalizeMatches(raw, { requirements: subject.requirements, artworks: subject.artworks });
    matches = normalized.matches;
    duplicates = normalized.duplicates.map((g) => g.map((id) => new ObjectId(id)));
    stats.matches += 1;
  }
  state.matches = matches;
  state.inventory = { total, sig: librarySig, req_sig: reqSig, matches: matches.map((m) => ({ ...m, artwork_id: new ObjectId(m.artwork_id) })), duplicates };
  // Reviews on file that still describe the picture as it is now.
  for (const a of subject.artworks) {
    const e = priorEntries.get(String(a._id));
    if (!rereview && auditEntryIsCurrent(e, a, reqSig)) state.reviewed.set(String(a._id), e);
    // Same requirements, a new picture (an edit) — or a quality check, which
    // looks at everything again: the last review is shown while the run is
    // still working, until the new one replaces it.
    else if (e?.audited_image_id && e.req_sig === reqSig) state.stale.set(String(a._id), e);
  }
  return state;
}

// The stored entries for a subject: every matched piece (as reviewed, if a
// current review exists; otherwise as its description says) plus every piece
// the reviewer has looked at. What an entry carries across a re-review: the
// manual fix record and the climb's count of edits that did not help.
function subjectEntries(subject, state, { provisional = false } = {}) {
  const fitsOf = new Map();
  for (const m of state.matches) {
    if (!fitsOf.has(m.artwork_id)) fitsOf.set(m.artwork_id, []);
    fitsOf.get(m.artwork_id).push({ requirement_id: m.requirement_id, fit: m.fit, lacking: m.lacking || '' });
  }
  const entries = [];
  for (const a of subject.artworks) {
    const id = String(a._id);
    const old = state.priorEntries.get(id);
    const carried = { ...(old?.fix ? { fix: old.fix } : {}), ...(old?.edit_attempts ? { edit_attempts: old.edit_attempts } : {}) };
    const reviewed = state.reviewed.get(id) || (provisional ? state.stale.get(id) : null);
    if (reviewed) entries.push({ ...reviewed, ...carried });
    else if (fitsOf.has(id)) entries.push({ ...matchedEntry(a, fitsOf.get(id), state.reqSig), ...carried });
  }
  return entries;
}

function subjectResult(subject, state, opts) {
  const entries = subjectEntries(subject, state, opts);
  const requirements = deriveRequirementStatus(subject.requirements, entries);
  const total = subject.artworks.length;
  return {
    requirements,
    entries,
    reqSig: state.reqSig,
    inventory: { ...state.inventory, matched: entries.length, reviewed: entries.filter((e) => e.audited_image_id).length },
    accuracy_score: subjectAccuracy(entries),
    summary: !total ? '' : !subject.requirements.length ? 'The beat imposes no requirement on this subject.' : summarizeSubjectAudit({ requirements, entries, total }),
  };
}

// ── Phase 2: review ──
// The matched pieces are LOOKED at and scored on the rubric, in batches.
// `mode` 'all': per requirement the best matches (a rejected one makes room
// for the next, up to REVIEW_PASSES rounds) plus `forced`; 'touched': only
// `forced` (a climb still filling coverage reviews what it just made). A
// piece whose review is current is never sent again.
const REVIEW_PASSES = 3;
async function reviewSubject({ beat, subject, state, forced, mode, stats, onBatch }) {
  if (!subject.artworks.length || !subject.requirements.length) return;
  const live = new Map(subject.artworks.map((a) => [String(a._id), a]));
  const matched = new Map();
  for (const m of state.matches) {
    if (!matched.has(m.artwork_id)) matched.set(m.artwork_id, []);
    matched.get(m.artwork_id).push(m.requirement_id);
  }
  const asked = new Set();
  for (let pass = 0; pass < REVIEW_PASSES; pass++) {
    const wanted = new Set([...forced].filter((id) => live.has(id)));
    if (mode === 'all') for (const id of reviewCandidates(subject.requirements, state.matches, state.reviewed)) wanted.add(id);
    const todo = [...wanted].filter((id) => live.has(id) && !state.reviewed.has(id) && !asked.has(id)).map((id) => live.get(id));
    if (!todo.length) break;
    for (let i = 0; i < todo.length; i += AUDIT_BATCH_SIZE) {
      const batch = todo.slice(i, i + AUDIT_BATCH_SIZE);
      for (const a of batch) asked.add(String(a._id));
      const raw = await auditArtworkBatch({ beat, subject, requirements: subject.requirements, artworks: batch, matched });
      for (const e of normalizeArtworkAudit(raw, { requirements: subject.requirements, artworks: batch, reqSig: state.reqSig })) {
        if (e.audited_image_id) state.reviewed.set(String(e.artwork_id), e);
      }
      stats.audited += batch.length;
      await onBatch?.();
    }
  }
}

// A requirement that still needs a picture MADE: nothing on file answers it,
// or the reviewer wants its best piece regenerated.
function needsRender(requirement, entries, proposals) {
  return requirement.status === 'missing' || requirementNeedsRegeneration(requirement, entries, proposals);
}

// Proposals that no longer have a job: a `proposed` / `error` one whose
// requirements no longer need a picture made (or are gone). Rendered and dismissed ones
// stay — a dismissal is the user's decision and must survive a re-run.
function pruneProposals(proposals, subjects) {
  const open = new Set();
  for (const s of subjects) for (const r of s.requirements || []) if (needsRender(r, s.artworks_audited || [], proposals)) open.add(r.id);
  return (proposals || []).filter((p) => {
    if (p.status === 'done' || p.status === 'dismissed') return true;
    return (p.requirement_ids || []).some((id) => open.has(String(id)));
  });
}

// What the planner is told is on file: the audited pieces and what each does.
function auditForPlanner(subject, audit) {
  const byId = new Map((subject.requirements || []).map((r) => [r.id, r]));
  const lines = [audit.summary];
  for (const e of audit.entries) {
    const fits = (e.fits || []).map((f) => `${f.fit === 'covered' ? 'covers' : 'close to'} "${byId.get(f.requirement_id)?.summary || f.requirement_id}"${f.lacking ? ` (lacks: ${f.lacking})` : ''}`);
    const verdict = e.action === 'regenerate' ? ` — REVIEWER: make this again${e.regenerate_reason ? ` (${e.regenerate_reason})` : ''}` : '';
    const issues = (e.issues || []).map((x) => x.note).filter(Boolean).join('; ');
    lines.push(`- "${e.name || 'untitled'}"${Number.isFinite(e.score) ? ` [${e.score}/10]` : e.audited_image_id ? '' : ' [not looked at — description only]'}: ${fits.length ? fits.join('; ') : 'answers no requirement of this beat'}${issues ? ` — wrong in it: ${issues}` : ''}${verdict}`);
  }
  return { summary: lines.filter(Boolean).join('\n') || '' };
}

// One critique run. INCREMENTAL unless `job.force`: requirements are derived
// again only when what they are derived from changed, an artwork is sent to
// vision only when it (or the requirements) changed since it was last
// reviewed, and proposals are drafted only for gaps that have none.
// `job.focus` (a climb round) lists artwork ids to review whatever their
// descriptions matched.
export async function runArtworkCritique({ projectId, job }) {
  projectId = await resolveProjectId(projectId);
  try {
    const beat = await getBeat(projectId, job.beat_id);
    if (!beat) throw new Error(`beat not found: ${job.beat_id}`);
    const ctx = await loadFullBeatContext({ projectId, beat });
    job.warnings.push(...(ctx.warnings || []));
    const subjects = collectSubjects(ctx, job.warnings, beat);
    job.subjects = subjects.map((s) => ({ kind: s.kind, id: String(s.id), name: s.name, status: 'pending', requirement_count: 0, covered: 0, partial: 0, missing: 0, artworks_total: s.artworks.length, audited: 0, reused: 0 }));
    // `force` forgets what the last run learned: nothing is reused below and
    // the stored critique is replaced by empty stubs, so the page fills again
    // as each subject is matched and each review batch lands. An incremental
    // run keeps the stored critique on the page and updates it in place.
    const stored = await getBeatArtworkCritique(projectId, beat._id);
    const fresh = job.force || job.stage === 'coverage';
    const prior = fresh ? null : stored;
    const model = modelFor('storyboard');
    if (prior) await beginArtworkCritiqueRun(projectId, beat._id, { model, subjects });
    else await setArtworkCritiquePending(projectId, beat._id, { model, subjects });
    job.status = 'running';
    job.phase = 'requirements';
    publish(job);

    if (!subjects.length) {
      job.warnings.push('This beat has no linked sets or characters — link them on the Sets and Characters tabs, then run again.');
      job.status = 'done';
      job.phase = 'done';
      job.finished_at = new Date();
      await finalizeArtworkCritique(projectId, beat._id, { status: 'done', coverage: computeCoverage([]), warnings: job.warnings, unlinked_mentions: [] });
      publish(job);
      return job;
    }

    // Pass A — the requirements: reused while the beat and its roster read
    // the same, otherwise derived and persisted per subject.
    const runSig = requirementsRunSignature(ctx, subjects, beat);
    const reuse = !!prior && prior.requirements_sig === runSig
      && subjects.every((s) => (prior.subjects || []).some((p) => sameSubject(p, s)));
    const priorSubject = (s) => (reuse ? (prior.subjects || []).find((p) => sameSubject(p, s)) : null);
    let unlinked_mentions = prior?.unlinked_mentions || [];
    let proposals = prior?.proposals || [];
    if (reuse) {
      for (const s of subjects) s.requirements = priorSubject(s).requirements || [];
    } else {
      const reqRaw = await deriveRequirements({ text: ctx.text, subjects, beat });
      const normalized = normalizeRequirements(reqRaw, subjects);
      unlinked_mentions = normalized.unlinked_mentions;
      job.warnings.push(...normalized.warnings);
      // The stored subjects are NOT blanked here: each keeps showing its last
      // audit until its new one replaces requirements and artworks together
      // (pass B), so a re-derive never empties the page. The new signature is
      // stored only once every subject has been rewritten.
      for (const s of subjects) {
        s.requirements = normalized.requirements.filter((r) => r.subject_key === subjectKey(s.kind, s.id));
      }
      // Requirement ids are positional: every open proposal now points at
      // nothing. What was rendered stays as history.
      proposals = proposals.filter((p) => p.status === 'done');
      await setArtworkCritiqueMeta(projectId, beat._id, { unlinked_mentions, proposals });
    }
    for (const s of subjects) jobSubject(job, s).requirement_count = s.requirements.length;
    job.phase = 'matching';
    publish(job);

    const focus = job.focus ? new Set([...job.focus].map(String)) : null;
    // Pieces reviewed whatever their description says: what a climb round
    // just edited or rendered, and everything a proposal made for this beat.
    const forced = new Set([...(focus || []), ...proposals.filter((p) => p.artwork_id).map((p) => String(p.artwork_id))]);
    const states = new Map();
    const audits = new Map();
    const statsOf = new Map(subjects.map((s) => [s, { audited: 0, described: 0, matches: 0 }]));
    const failed = new Set();
    const fail = async (s, e) => {
      const js = jobSubject(job, s);
      failed.add(s);
      js.status = 'error';
      js.error_message = e.message;
      // A subject that failed before its new audit was stored must not keep
      // requirements derived from the previous text under the new signature.
      const stale = !reuse && !audits.has(s);
      await updateArtworkCritiqueSubject(projectId, beat._id, s.id, {
        status: 'error',
        error_message: e.message,
        ...(stale ? { requirements: deriveRequirementStatus(s.requirements, []), artworks: [] } : {}),
      })
        .catch((err) => logger.warn(`artwork critique: persist subject error failed: ${err.message}`));
      logger.warn(`artwork critique: subject ${s.kind} ${s.name} failed: ${e.message}`);
      publish(job);
    };
    // Write a subject as it stands (after its match, after every review
    // batch): the page follows the run instead of waiting for its end.
    const store = async (s, opts) => {
      const js = jobSubject(job, s);
      const state = states.get(s);
      const result = subjectResult(s, state, opts);
      s.requirements = result.requirements;
      s.artworks_audited = result.entries;
      audits.set(s, result);
      js.covered = result.requirements.filter((r) => r.status === 'covered').length;
      js.partial = result.requirements.filter((r) => r.status === 'partial').length;
      js.missing = result.requirements.filter((r) => r.status === 'missing').length;
      js.matched = result.entries.length;
      js.audited = statsOf.get(s).audited;
      js.reused = Math.max(0, state.reviewed.size - js.audited);
      await updateArtworkCritiqueSubject(projectId, beat._id, s.id, {
        requirements: result.requirements,
        artworks: result.entries,
        accuracy_score: result.accuracy_score,
        summary: result.summary,
        inventory: result.inventory,
        req_sig: result.reqSig,
      });
      publish(job);
    };
    const coverageNow = () => computeCoverage(subjects.map((s) => ({ requirements: s.requirements, artworks: s.artworks_audited || [] })));

    // Phase 1 — COVERAGE, from the descriptions alone.
    await runPool(subjects, SUBJECT_CONCURRENCY, async (s) => {
      jobSubject(job, s).status = 'matching';
      publish(job);
      try {
        states.set(s, await matchSubject({ projectId, beat, subject: s, priorSubject: priorSubject(s), warnings: job.warnings, stats: statsOf.get(s), rereview: job.stage === 'quality' }));
        await store(s, { provisional: true });
      } catch (e) {
        await fail(s, e);
      }
    });
    if (!reuse) await setArtworkCritiqueMeta(projectId, beat._id, { requirements_sig: runSig });
    const matched = subjects.filter((s) => states.has(s) && !failed.has(s));
    await setArtworkCritiqueCoverage(projectId, beat._id, coverageNow());

    // Phase 2 — QUALITY: the matched pieces are looked at and scored. A climb
    // (`review: 'auto'`) that still has a requirement nothing answers reviews
    // only what it just made; quality review of the library waits until
    // coverage is complete.
    // A coverage check stops before it: no image is looked at.
    const anyMissing = matched.some((s) => s.requirements.some((r) => r.status === 'missing'));
    const mode = job.stage === 'coverage' ? 'none' : job.review === 'auto' && anyMissing ? 'touched' : 'all';
    job.review_mode = mode;
    job.phase = mode === 'none' ? 'proposing' : 'auditing';
    publish(job);
    if (mode !== 'none') await runPool(matched, SUBJECT_CONCURRENCY, async (s) => {
      jobSubject(job, s).status = 'auditing';
      publish(job);
      try {
        await reviewSubject({ beat, subject: s, state: states.get(s), forced, mode, stats: statsOf.get(s), onBatch: () => store(s, { provisional: true }) });
        await store(s);
      } catch (e) {
        await fail(s, e);
      }
    });

    // Pass C — only for gaps no live proposal already answers.
    const audited = subjects.filter((s) => audits.has(s) && !failed.has(s));
    // An open proposal drafted before the reviewer turned its requirement's
    // piece down knows nothing of what was wrong: it is dropped so a new one
    // is drafted WITH the findings.
    const remake = new Set();
    for (const s of audited) for (const r of s.requirements) if (r.status !== 'missing' && needsRender(r, s.artworks_audited || [], proposals)) remake.add(r.id);
    const informed = proposals.filter((p) => !(['proposed', 'error'].includes(p.status) && !p.review_brief && (p.requirement_ids || []).some((id) => remake.has(String(id)))));
    const kept = pruneProposals(informed, [...audited, ...subjects.filter((s) => failed.has(s))]);
    if (kept.length !== proposals.length) await setArtworkCritiqueMeta(projectId, beat._id, { proposals: kept });
    const answered = new Set(kept.filter((p) => p.status !== 'done').flatMap((p) => (p.requirement_ids || []).map(String)));
    let catalog = null;
    let catalogText = '';
    await runPool(audited, SUBJECT_CONCURRENCY, async (s) => {
      const js = jobSubject(job, s);
      try {
        const gaps = s.requirements
          .filter((r) => needsRender(r, s.artworks_audited || [], kept) && !answered.has(r.id))
          .map((r) => {
            const entryOf = (id) => (s.artworks_audited || []).find((e) => String(e.artwork_id) === String(id || ''));
            if (r.status === 'missing') {
              // Renders already made for it that the reviewer turned down:
              // the next one is told what was wrong with them.
              const tried = kept
                .filter((p) => p.status === 'done' && p.artwork_id && (p.requirement_ids || []).map(String).includes(r.id))
                .map((p) => entryOf(p.artwork_id))
                .filter((e) => e?.audited_image_id);
              const review = tried.map((e) => `a previous render was turned down — ${regenerationBrief(e) || `"${e.name}" did not show it`}`).join(' | ');
              return review ? { ...r, review } : r;
            }
            // On file but to be made again: the planner is told why.
            const best = entryOf((r.covered_by || [])[0]);
            return { ...r, status: 'regenerate', review: regenerationBrief(best) || r.note || 'the piece on file cannot be edited into this', replaces_artwork_id: best?.artwork_id || null };
          });
        if (gaps.length) {
          js.status = 'proposing';
          publish(job);
          if (!catalog) {
            catalog = await buildReferenceCatalog(projectId, beat);
            catalogText = formatReferenceCatalog(catalog);
          }
          const propRaw = await proposeForSubject({ beat, subject: s, requirements: gaps, audit: auditForPlanner(s, audits.get(s)), catalogText, direction: job.direction });
          const { proposals: drafted, warnings: propWarnings } = normalizeProposals(propRaw, { subject: s, requirements: gaps, catalog, beat });
          job.warnings.push(...propWarnings);
          if (!drafted.length) job.warnings.push(`${s.name}: ${gaps.length} requirement(s) uncovered but the planner proposed nothing.`);
          // Each proposal remembers what the reviewer said it has to put
          // right (shown on the proposal, and in the climb's log).
          for (const p of drafted) {
            const mine = gaps.filter((g) => (p.requirement_ids || []).map(String).includes(g.id) && g.review);
            p.review_brief = mine.map((g) => g.review).join(' | ').slice(0, 1500);
            p.replaces_artwork_id = mine.find((g) => g.replaces_artwork_id)?.replaces_artwork_id || null;
          }
          await appendArtworkCritiqueProposals(projectId, beat._id, drafted);
        }
        js.status = 'done';
        await updateArtworkCritiqueSubject(projectId, beat._id, s.id, { status: 'done', error_message: null });
        publish(job);
      } catch (e) {
        await fail(s, e);
      }
    });

    job.status = failed.size === 0 ? 'done' : failed.size === subjects.length ? 'error' : 'partial';
    job.phase = 'done';
    job.finished_at = new Date();
    await finalizeArtworkCritique(projectId, beat._id, {
      status: job.status,
      coverage: coverageNow(),
      warnings: job.warnings,
      unlinked_mentions,
    });
    publish(job);
    logger.info(`artwork critique: beat=${beat._id} status=${job.status} subjects=${subjects.length} audited=${job.subjects.reduce((n, s) => n + s.audited, 0)} reused=${job.subjects.reduce((n, s) => n + s.reused, 0)} review=${mode}${reuse ? ' (requirements reused)' : ''}`);
  } catch (e) {
    job.status = 'error';
    job.phase = 'done';
    job.error = e.message;
    job.finished_at = new Date();
    publish(job);
    logger.error(`artwork critique: run crashed: ${e.message}`);
  } finally {
    retire(job);
  }
  return job;
}

export async function startArtworkCritiqueJob({ projectId, beatId, force = false, stage = 'all' }) {
  projectId = await resolveProjectId(projectId);
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw httpError(`beat not found: ${beatId}`, 404);
  const busyKey = beat._id.toString();
  // No await between the has-check and the add: the first caller wins.
  if (climbHolds.has(busyKey)) throw httpError(CLIMB_BUSY, 409);
  if (busyBeats.has(busyKey)) throw httpError('An artwork critique is already running for this beat.', 409);
  if (generatingBeats.has(busyKey)) throw httpError('Artwork is being generated for this beat; wait for it to finish.', 409);
  if (stage === 'quality' && !(beat.artwork_critique?.subjects || []).some((s) => (s.requirements || []).length)) {
    throw httpError('Check coverage first: there is nothing to check the quality of yet.', 409);
  }
  busyBeats.add(busyKey);
  // A manual critique replaces what the last climb left: its status goes.
  // A coverage check (or `force`) starts from nothing, and the page is
  // emptied before the 202 so no client can read the old audit back while
  // the run is starting.
  const fresh = force || stage === 'coverage';
  try {
    await setBeatClimb(projectId, busyKey, 'artwork', null);
    if (fresh) await clearBeatArtworkCritique(projectId, busyKey);
  } catch (e) {
    busyBeats.delete(busyKey);
    throw e;
  }
  const job = createArtworkCritiqueJob(busyKey, { force, stage });
  setImmediate(() => {
    runArtworkCritique({ projectId, job })
      .catch((e) => logger.error(`artwork critique: background run failed: ${e.message}`))
      .finally(() => busyBeats.delete(busyKey));
  });
  return job.job_id;
}

// "Clear critique": remove the stored critique (requirements, reviews,
// proposals) and the last climb's status. No artwork is deleted. 409 while a
// critique, a generation, a climb or a fix is running for the beat.
export async function clearArtworkCritique({ projectId, beatId }) {
  projectId = await resolveProjectId(projectId);
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw httpError(`beat not found: ${beatId}`, 404);
  const key = beat._id.toString();
  if (climbHolds.has(key)) throw httpError(CLIMB_BUSY, 409);
  if (busyBeats.has(key)) throw httpError('An artwork critique is running for this beat; wait for it to finish.', 409);
  if (generatingBeats.has(key)) throw httpError('Artwork is being generated for this beat; wait for it to finish.', 409);
  const fixing = (beat.artwork_critique?.subjects || []).some((s) => (s.artworks || []).some((a) => a?.fix?.status === 'generating'));
  if (fixing) throw httpError('An artwork fix is running for this beat; wait for it to finish.', 409);
  await clearBeatArtworkCritique(projectId, key);
  await setBeatClimb(projectId, key, 'artwork', null);
}

// Live check without saving anything (scripts/artwork-review-dry-run.js): the
// beat's subjects with their STORED requirements, phase 1 for one subject,
// and the rubric review of its first `reviewLimit` candidates.
export async function critiqueSubjectDryRun({ projectId, beatId, subjectName = '', reviewLimit = 2 }) {
  projectId = await resolveProjectId(projectId);
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw new Error(`beat not found: ${beatId}`);
  const ctx = await loadFullBeatContext({ projectId, beat });
  const warnings = [];
  const subjects = collectSubjects(ctx, warnings, beat);
  const stored = await getBeatArtworkCritique(projectId, beat._id);
  const want = String(subjectName || '').toLowerCase();
  const subject = subjects.find((s) => (want ? s.name.toLowerCase().includes(want) : s.artworks.length > 0));
  if (!subject) throw new Error(`no such subject on this beat (have: ${subjects.map((s) => s.name).join(', ')})`);
  subject.requirements = ((stored?.subjects || []).find((p) => sameSubject(p, subject))?.requirements || [])
    .map(({ status, covered_by, note, ...r }) => r);
  if (!subject.requirements.length) throw new Error(`${subject.name} has no stored requirements — run the artwork critique once first`);
  const raw = await matchArtworks({ beat, subject, requirements: subject.requirements, artworks: subject.artworks });
  const { matches, duplicates } = normalizeMatches(raw, { requirements: subject.requirements, artworks: subject.artworks });
  const ids = [...reviewCandidates(subject.requirements, matches, new Map())].slice(0, reviewLimit);
  const batch = subject.artworks.filter((a) => ids.includes(String(a._id)));
  const matched = new Map();
  for (const m of matches) matched.set(m.artwork_id, [...(matched.get(m.artwork_id) || []), m.requirement_id]);
  const reviews = batch.length
    ? normalizeArtworkAudit(await auditArtworkBatch({ beat, subject, requirements: subject.requirements, artworks: batch, matched }), { requirements: subject.requirements, artworks: batch, reqSig: 'dry-run' })
    : [];
  return { subject: { kind: subject.kind, name: subject.name, artworks: subject.artworks }, requirements: subject.requirements, matches, duplicates, reviews, warnings };
}

// ── Climb hooks (artworkClimb.js) ──

// Take the beat for a climb. False when a critique, a generation or another
// climb already has it. No await between the checks and the add.
export function holdArtworkClimb(beatId) {
  const key = String(beatId);
  if (climbHolds.has(key) || busyBeats.has(key) || generatingBeats.has(key)) return false;
  climbHolds.add(key);
  return true;
}

export function releaseArtworkClimb(beatId) {
  climbHolds.delete(String(beatId));
}

// One (incremental) critique run, awaited. `direction` reaches the proposal
// pass; `focusArtworkIds` are the pieces the round just edited or rendered.
// `onProgress(snapshot)` gets every job snapshot (phase, per-subject counts).
// `review`: 'auto' (library review waits for full coverage) or 'all'.
export async function runArtworkCritiqueForClimb({ projectId, beatId, direction = '', focusArtworkIds = [], onProgress = null, review = 'auto' }) {
  const key = String(beatId);
  busyBeats.add(key);
  const job = createArtworkCritiqueJob(key, { direction, focus: focusArtworkIds, review });
  if (onProgress) subscribeToArtworkCritiqueJob(job.job_id, onProgress);
  try {
    return await runArtworkCritique({ projectId, job });
  } finally {
    if (onProgress) unsubscribeFromArtworkCritiqueJob(job.job_id, onProgress);
    busyBeats.delete(key);
  }
}

// Replace or patch audited entries (a climb undoing an edit puts the entry it
// had before back; a kept edit clears its failure count), then re-derive the
// subjects' requirement statuses and the coverage from what is stored.
// `changes`: [{subjectId, artworkId, entry?, patch?}].
export async function applyArtworkEntryChanges({ projectId, beatId, changes = [] }) {
  if (!changes.length) return;
  projectId = await resolveProjectId(projectId);
  const critique = await getBeatArtworkCritique(projectId, beatId);
  if (!critique) return;
  for (const subject of critique.subjects || []) {
    const mine = changes.filter((c) => String(c.subjectId) === String(subject.id));
    if (!mine.length) continue;
    const artworks = (subject.artworks || []).map((e) => {
      const c = mine.find((x) => String(x.artworkId) === String(e.artwork_id));
      if (!c) return e;
      return { ...(c.entry || e), ...(c.patch || {}) };
    });
    const requirements = deriveRequirementStatus(subject.requirements || [], artworks);
    subject.artworks = artworks;
    subject.requirements = requirements;
    await updateArtworkCritiqueSubject(projectId, beatId, subject.id, {
      artworks,
      requirements,
      accuracy_score: subjectAccuracy(artworks),
      summary: summarizeSubjectAudit({ requirements, entries: artworks, total: subject.inventory?.total ?? artworks.length }),
    });
  }
  await setArtworkCritiqueCoverage(projectId, beatId, computeCoverage(critique.subjects || []));
}

// Resolves with the generation job once it has finished (null if unknown).
export async function waitForArtworkGenerateJob(jobId) {
  const job = genJobs.get(jobId);
  if (!job) return null;
  await job.done;
  return job;
}

// ───────────────────────────── Generation job ─────────────────────────────

const genJobs = new Map();
const generatingBeats = new Set();

export function getArtworkGenerateJob(jobId) {
  return genJobs.get(jobId) || null;
}

export function serializeArtworkGenerateJob(job) {
  if (!job) return null;
  return {
    job_id: job.job_id,
    beat_id: job.beat_id,
    project_id: job.project_id,
    status: job.status,
    model: job.model,
    planned: job.planned,
    completed: job.completed,
    failed: job.failed,
    progress: job.progress,
    events: [...(job.events || [])],
    items: job.items.map((i) => ({ ...i })),
    started_at: job.started_at,
    finished_at: job.finished_at,
    error: job.error,
  };
}

function isHex(s) {
  return /^[a-f0-9]{24}$/i.test(String(s || ''));
}

async function validateOverrides(overrides) {
  const out = {};
  for (const [pid, o] of Object.entries(overrides || {})) {
    if (!o || typeof o !== 'object') continue;
    const clean = {};
    if (o.prompt !== undefined) {
      const p = String(o.prompt || '').trim();
      if (!p) throw httpError('A proposal prompt cannot be blank.', 400);
      if (p.length > MAX_OVERRIDE_PROMPT) throw httpError(`A proposal prompt is limited to ${MAX_OVERRIDE_PROMPT} characters.`, 400);
      clean.prompt = p;
    }
    if (o.reference_image_ids !== undefined) {
      if (!Array.isArray(o.reference_image_ids) || o.reference_image_ids.some((id) => !isHex(id))) {
        throw httpError('reference_image_ids must be a list of image ids.', 400);
      }
      // Drop references whose files are gone (a deleted artwork).
      const kept = [];
      for (const id of [...new Set(o.reference_image_ids.map(String))]) {
        if (await findImageFile(id)) kept.push(id);
      }
      clean.reference_image_ids = kept;
    }
    out[pid] = clean;
  }
  return out;
}

// Every character render — first run, retry of a failed one, regenerate —
// leaves with the character's portrait as reference image 1, the character's
// own artwork next and set plates last, and a prompt binding that names what
// is attached. Done here, at generate time, because the job reuses the
// proposal AS STORED: one planned before the portrait rule, or whose
// references an override trimmed, must not go out with only a set plate (a
// brand-new face every time). Roles come from GridFS owner_type; a missing
// file counts as artwork and fails later in loadImageBuffers as before.
// The wardrobe lock (src/web/wardrobe.js) rides the same path: the plate at
// reference 2 and the current locked words re-quoted — so a proposal planned
// before the lock was set, or before the plate was auto-promoted by an
// earlier render of this very job, still goes out locked.
async function anchorCharacterItems({ projectId, beat = null, items }) {
  const anchors = new Map();
  for (const item of items) {
    if (item.host_type !== 'character') continue;
    if (!anchors.has(item.host_id)) {
      const character = await getCharacter(projectId, item.host_id);
      const portraitId = characterPortraitId(character);
      const plateId = wardrobeImageId(character);
      anchors.set(item.host_id, {
        portraitId: portraitId && (await findImageFile(portraitId)) ? portraitId : '',
        wardrobeId: plateId && (await findImageFile(plateId)) ? plateId : '',
        wardrobe: wardrobeLine(character, beat),
      });
    }
    const anchor = anchors.get(item.host_id);
    const picks = [];
    for (const id of item.reference_image_ids) {
      if (id === anchor.portraitId || id === anchor.wardrobeId) continue;
      const file = await findImageFile(id);
      picks.push({ image_id: id, owner_type: file?.metadata?.owner_type === 'set' ? 'set' : 'character' });
    }
    const ordered = orderCharacterReferences({ portraitId: anchor.portraitId, wardrobeId: anchor.wardrobeId, picks });
    item.reference_image_ids = ordered.map((r) => r.image_id);
    item.prompt = rebindCharacterPrompt(item.prompt, ordered, { wardrobe: anchor.wardrobe });
    item.has_wardrobe_plate = !!anchor.wardrobeId;
  }
}

// Auto-promote: the first finished costume render of a character with no
// wardrobe plate becomes the plate, so the next render (this job or the next
// run) copies its clothes. Re-reads the character so a sibling render that
// promoted first wins.
async function maybePromoteWardrobePlate({ projectId, item, fileId }) {
  if (item.host_type !== 'character' || !fileId) return false;
  if (!(item.requirement_categories || []).includes('costume')) return false;
  const character = await getCharacter(projectId, item.host_id);
  if (!character || wardrobeImageId(character)) return false;
  await setCharacterWardrobeImageViaGateway({ projectId, character: item.host_id, imageId: String(fileId) });
  return true;
}

// The categories of a proposal's requirements (costume / expression / …) —
// what decides whether a finished render may become the wardrobe plate.
function requirementCategories(critique, proposal) {
  const subject = (critique?.subjects || []).find((s) => s.kind === proposal.host_type && String(s.id) === String(proposal.host_id));
  const wanted = new Set((proposal.requirement_ids || []).map(String));
  return [...new Set((subject?.requirements || []).filter((r) => wanted.has(String(r.id))).map((r) => r.category))];
}

async function renderProposal({ projectId, beatId, job, item, discordUser }) {
  const order = job.items.indexOf(item) + 1;
  recordProgress(job, { phase: 'rendering', step: 'shot_start', frame: order, total: job.planned, message: `Rendering ${order}/${job.planned}: ${item.name}…` });
  item.status = 'generating';
  let artworkId = null;
  try {
    // Re-anchor on the character as it is NOW: an earlier render of this job
    // may have promoted a wardrobe plate this item was planned without.
    if (item.host_type === 'character') {
      await anchorCharacterItems({ projectId, beat: job.beat, items: [item] });
      await updateArtworkCritiqueProposal(projectId, beatId, item.proposal_id, {
        prompt: item.prompt,
        reference_image_ids: item.reference_image_ids.map((id) => new ObjectId(id)),
      });
    }
    const { artwork } = await createPendingArtworkViaGateway({
      projectId,
      hostType: item.host_type,
      hostId: item.host_id,
      prompt: item.prompt,
      name: item.name,
      model: job.model,
      referenceImageIds: item.reference_image_ids,
      jobId: job.job_id,
    });
    artworkId = artwork._id;
    const { fileId } = await generateArtworkImageInline({
      projectId,
      hostType: item.host_type,
      hostId: item.host_id,
      artworkId,
      prompt: item.prompt,
      model: job.model,
      referenceImageIds: item.reference_image_ids,
      discordUser,
    });
    item.status = 'done';
    item.artwork_id = String(artworkId);
    item.result_image_id = fileId ? String(fileId) : null;
    job.completed += 1;
    const promoted = await maybePromoteWardrobePlate({ projectId, item, fileId })
      .catch((err) => { logger.warn(`artwork critique: wardrobe promotion failed: ${err.message}`); return false; });
    item.promoted_wardrobe = promoted;
    await updateArtworkCritiqueProposal(projectId, beatId, item.proposal_id, {
      status: 'done', artwork_id: artworkId, result_image_id: fileId || null, generated_at: new Date(), error_message: null,
      promoted_wardrobe: promoted,
    });
    await markRequirementsCovered({ projectId, beatId, item, artworkId });
    recordProgress(job, { phase: 'rendering', step: 'shot_done', frame: order, total: job.planned, message: `Rendered ${order}/${job.planned}: ${item.name}${promoted ? ' — promoted to the wardrobe plate' : ''}` });
  } catch (e) {
    item.status = 'error';
    item.error = e.message;
    job.failed += 1;
    if (artworkId) {
      await setArtworkStatusViaGateway({ projectId, hostType: item.host_type, hostId: item.host_id, artworkId, status: 'error', errorMessage: e.message })
        .catch((err) => logger.warn(`artwork critique: persist artwork error failed: ${err.message}`));
    }
    await updateArtworkCritiqueProposal(projectId, beatId, item.proposal_id, { status: 'error', error_message: e.message })
      .catch((err) => logger.warn(`artwork critique: persist proposal error failed: ${err.message}`));
    recordProgress(job, { phase: 'rendering', step: 'shot_failed', frame: order, total: job.planned, message: `Failed ${order}/${job.planned}: ${item.name} — ${e.message}` });
    logger.warn(`artwork critique generate ${job.job_id}: ${item.name} failed: ${e.message}`);
  }
}

// A rendered proposal covers its requirements. Read-modify-write of the
// subject's requirements array — only this job writes it while it runs.
async function markRequirementsCovered({ projectId, beatId, item, artworkId }) {
  const critique = await getBeatArtworkCritique(projectId, beatId);
  const subject = (critique?.subjects || []).find((s) => s.kind === item.host_type && String(s.id) === String(item.host_id));
  if (!subject) return;
  const ids = new Set(item.requirement_ids);
  const requirements = (subject.requirements || []).map((r) => (ids.has(r.id)
    ? { ...r, status: 'covered', covered_by: [...(r.covered_by || []), artworkId], note: r.note || 'Generated from the critique proposal.' }
    : r));
  await updateArtworkCritiqueSubject(projectId, beatId, subject.id, { requirements });
  const fresh = await getBeatArtworkCritique(projectId, beatId);
  await setArtworkCritiqueCoverage(projectId, beatId, computeCoverage(fresh?.subjects || []));
}

async function runArtworkGenerateJob({ projectId, beatId, job, discordUser }) {
  try {
    job.status = 'rendering';
    await runPool(job.items, RENDER_CONCURRENCY, (item) => renderProposal({ projectId, beatId, job, item, discordUser }));
    job.status = job.failed === 0 ? 'done' : job.completed ? 'partial' : 'error';
    recordProgress(job, { phase: 'done', step: 'job_done', message: `Generated ${job.completed}/${job.planned}${job.failed ? ` (${job.failed} failed)` : ''}` });
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    logger.error(`artwork critique generate ${job.job_id} crashed: ${e.message}`);
  } finally {
    job.finished_at = new Date();
    const id = job.job_id;
    setTimeout(() => genJobs.delete(id), TERMINAL_RETENTION_MS).unref?.();
  }
}

export async function startArtworkGenerateJob({ projectId, beatId, proposalIds, model, overrides = {}, discordUser = null, climb = false }) {
  projectId = await resolveProjectId(projectId);
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw httpError(`beat not found: ${beatId}`, 404);
  const critique = beat.artwork_critique;
  if (!critique) throw httpError('Run the artwork critique first.', 404);
  const wanted = [...new Set((Array.isArray(proposalIds) ? proposalIds : []).map(String).filter(isHex))];
  if (!wanted.length) throw httpError('proposal_ids is required.', 400);
  const byId = new Map((critique.proposals || []).map((p) => [String(p._id), p]));
  const unknown = wanted.filter((id) => !byId.has(id));
  if (unknown.length) throw httpError(`Unknown proposal id: ${unknown[0]}`, 400);
  if (!(await isValidImageModel(model))) throw httpError(IMAGE_MODEL_ERROR, 400);
  assertImageModelConfigured(model);
  const cleanOverrides = await validateOverrides(overrides);

  const busyKey = beat._id.toString();
  if (climbHolds.has(busyKey) && !climb) throw httpError(CLIMB_BUSY, 409);
  if (busyBeats.has(busyKey)) throw httpError('An artwork critique is running for this beat; wait for it to finish.', 409);
  if (generatingBeats.has(busyKey)) throw httpError('Artwork is already being generated for this beat.', 409);

  // Proposals stuck in `generating` from a lost job (restart) are reset so
  // they can be picked again.
  for (const p of critique.proposals || []) {
    if (p.status === 'generating' && ![...genJobs.values()].some((j) => j.beat_id === busyKey && j.status === 'rendering')) {
      await updateArtworkCritiqueProposal(projectId, beat._id, p._id, { status: 'error', error_message: 'The previous generation did not finish.' });
      p.status = 'error';
    }
  }
  const items = [];
  for (const id of wanted) {
    const p = byId.get(id);
    if (!['proposed', 'error'].includes(p.status)) continue;
    const o = cleanOverrides[id] || {};
    items.push({
      proposal_id: id,
      host_type: p.host_type,
      host_id: String(p.host_id),
      host_name: p.host_name,
      name: p.name,
      prompt: o.prompt ?? p.prompt,
      reference_image_ids: (o.reference_image_ids ?? (p.reference_image_ids || [])).map(String),
      requirement_ids: p.requirement_ids || [],
      requirement_categories: requirementCategories(critique, p),
      status: 'queued',
      artwork_id: null,
      error: null,
    });
  }
  if (!items.length) throw httpError('None of the selected proposals can be generated (already done or dismissed).', 400);
  await anchorCharacterItems({ projectId, beat, items });
  await assertShotsSatisfyModelReferences({
    model,
    explicitShots: items.map((i) => ({ name: i.name, model, reference_image_ids: i.reference_image_ids })),
    poolIds: [],
  });

  generatingBeats.add(busyKey);
  // Persist what will run onto each proposal before rendering so the doc
  // shows the prompt and references that produced the artwork.
  for (const item of items) {
    await updateArtworkCritiqueProposal(projectId, beat._id, item.proposal_id, {
      status: 'generating',
      model,
      prompt: item.prompt,
      reference_image_ids: item.reference_image_ids.map((id) => new ObjectId(id)),
      error_message: null,
    });
  }
  const job = {
    job_id: makeJobId(),
    beat_id: busyKey,
    project_id: projectId,
    status: 'queued',
    model,
    beat,
    planned: items.length,
    completed: 0,
    failed: 0,
    progress: null,
    events: [],
    items,
    error: null,
    started_at: new Date(),
    finished_at: null,
  };
  genJobs.set(job.job_id, job);
  recordProgress(job, { phase: 'queued', step: 'job_queued', message: `Queued ${items.length} artwork render${items.length === 1 ? '' : 's'}…` });
  let finish;
  job.done = new Promise((resolve) => { finish = resolve; });
  setImmediate(() => {
    runArtworkGenerateJob({ projectId, beatId: beat._id, job, discordUser })
      .catch((e) => logger.error(`artwork critique generate: background run failed: ${e.message}`))
      .finally(() => { generatingBeats.delete(busyKey); finish(); });
  });
  return { job_id: job.job_id, planned: items.length };
}

export async function setProposalStatus({ projectId, beatId, proposalId, status }) {
  projectId = await resolveProjectId(projectId);
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw httpError(`beat not found: ${beatId}`, 404);
  const current = (beat.artwork_critique?.proposals || []).find((p) => String(p._id) === String(proposalId));
  if (!current) throw httpError('proposal not found', 404);
  if (current.status === 'generating') throw httpError('This proposal is being generated.', 409);
  if (status === 'dismissed' && current.status === 'done') throw httpError('A generated proposal cannot be dismissed.', 409);
  await updateArtworkCritiqueProposal(projectId, beat._id, proposalId, { status });
  return { ...current, status };
}

// ── Fixing an audited artwork ────────────────────────────────────────────
// The audit's `suggested_edit` is one imperative sentence an image-edit model
// can apply to THAT image alone. A fix applies it (or the user's rewrite of
// it) as an in-line EDIT of the artwork's current image on its owning set /
// character — the same job the Artwork tab's Edit dialog starts
// (startEditArtworkJob: old result → previous_result_image_id, one-step
// undo) — and records the attempt on the audited entry as
//   fix: {status: generating|done|error|undone, prompt, model, started_at,
//         source_image_id, result_image_id, error_message}
// The edit job finishes in the background and broadcasts to the host's room,
// not the beat's, so `syncArtworkFix` reads the host artwork on demand (the
// SPA polls it; the critique GET sweeps every in-flight fix) and copies the
// outcome onto the entry — `result_image_id` follows the new image so the
// strip shows what is on file now. The audit's issues are left as found:
// they describe the picture that was critiqued, and only a re-run can clear
// them.

const MAX_FIX_PROMPT = 4096;

function serializeFixEntry(subject, artwork) {
  return {
    subject_id: String(subject.id),
    host_type: subject.kind,
    artwork: { ...artwork, artwork_id: String(artwork.artwork_id), result_image_id: artwork.result_image_id ? String(artwork.result_image_id) : null },
  };
}

async function locateAuditedArtwork(projectId, beatId, artworkId) {
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw httpError(`beat not found: ${beatId}`, 404);
  if (!beat.artwork_critique) throw httpError('Run the artwork critique first.', 404);
  const found = await findArtworkCritiqueArtwork(projectId, beat._id, artworkId);
  if (!found) throw httpError('artwork not found on this critique', 404);
  return { beat, ...found };
}

export async function startArtworkFix({ projectId, beatId, artworkId, prompt, model, discordUser = null, announceUsername = null }) {
  projectId = await resolveProjectId(projectId);
  const { beat, subject, artwork: entry } = await locateAuditedArtwork(projectId, beatId, artworkId);
  if (climbHolds.has(beat._id.toString())) throw httpError(CLIMB_BUSY, 409);
  const text = String(prompt ?? entry.suggested_edit ?? '').trim();
  if (!text) throw httpError('A fix needs an edit instruction.', 400);
  if (text.length > MAX_FIX_PROMPT) throw httpError(`The edit instruction is limited to ${MAX_FIX_PROMPT} characters.`, 400);
  model = normalizeImageModel(model);
  if (!(await isValidImageModel(model))) throw httpError(IMAGE_MODEL_ERROR, 400);
  assertImageModelConfigured(model);

  const hostId = String(subject.id);
  const live = await getArtwork({ projectId, hostType: subject.kind, hostId, artworkId: String(artworkId) });
  if (!live?.artwork) throw httpError('The artwork is no longer on its set / character. Re-run the critique.', 404);
  if (live.artwork.status === 'pending') throw httpError('This artwork is already being generated or edited.', 409);
  if (!live.artwork.result_image_id) throw httpError('This artwork has no image to edit.', 409);
  if (entry.fix?.status === 'generating') throw httpError('A fix is already running for this artwork.', 409);

  await startEditArtworkJob({
    projectId,
    hostType: subject.kind,
    hostId,
    artworkId: String(artworkId),
    prompt: text,
    model,
    referenceImageIds: [],
    discordUser,
    announceUsername,
  });
  const fix = {
    status: 'generating',
    prompt: text,
    model,
    started_at: new Date(),
    source_image_id: String(live.artwork.result_image_id),
    result_image_id: null,
    error_message: null,
  };
  await updateArtworkCritiqueArtwork(projectId, beat._id, subject.id, artworkId, { fix });
  logger.info(`artwork critique: fix started beat=${beat._id} ${subject.kind}=${hostId} artwork=${artworkId} model=${model}`);
  return serializeFixEntry(subject, { ...entry, fix });
}

// Copy the outcome of a running fix from the host artwork onto the audited
// entry. Idempotent; a no-op unless the entry's fix is `generating`.
async function settleFix({ projectId, beatId, subject, entry }) {
  const fix = entry.fix;
  if (fix?.status !== 'generating') return entry;
  const live = await getArtwork({ projectId, hostType: subject.kind, hostId: String(subject.id), artworkId: String(entry.artwork_id) });
  let next = null;
  if (!live?.artwork) {
    next = { fix: { ...fix, status: 'error', error_message: 'The artwork was deleted while the fix ran.' } };
  } else if (live.artwork.status === 'error') {
    next = { fix: { ...fix, status: 'error', error_message: live.artwork.error_message || 'The edit failed.' } };
  } else if (live.artwork.status === 'done') {
    const resultId = live.artwork.result_image_id ? String(live.artwork.result_image_id) : null;
    next = resultId && resultId !== fix.source_image_id
      ? { fix: { ...fix, status: 'done', result_image_id: resultId }, result_image_id: live.artwork.result_image_id }
      : { fix: { ...fix, status: 'error', error_message: 'The edit finished without a new image.' } };
  }
  if (!next) return entry;
  await updateArtworkCritiqueArtwork(projectId, beatId, subject.id, entry.artwork_id, next);
  return { ...entry, ...next };
}

export async function syncArtworkFix({ projectId, beatId, artworkId }) {
  projectId = await resolveProjectId(projectId);
  const { beat, subject, artwork: entry } = await locateAuditedArtwork(projectId, beatId, artworkId);
  const settled = await settleFix({ projectId, beatId: beat._id, subject, entry });
  return serializeFixEntry(subject, settled);
}

// Sweep every in-flight fix on a critique (the GET route calls this so a
// reload shows finished edits). Returns the critique as stored afterwards.
export async function syncArtworkFixes({ projectId, beatId }) {
  projectId = await resolveProjectId(projectId);
  const critique = await getBeatArtworkCritique(projectId, beatId);
  if (!critique) return null;
  let touched = false;
  for (const subject of critique.subjects || []) {
    for (const entry of subject.artworks || []) {
      if (entry?.fix?.status !== 'generating') continue;
      await settleFix({ projectId, beatId, subject, entry }).catch((e) => logger.warn(`artwork critique: fix sync failed: ${e.message}`));
      touched = true;
    }
  }
  return touched ? getBeatArtworkCritique(projectId, beatId) : critique;
}

export async function undoArtworkFix({ projectId, beatId, artworkId }) {
  projectId = await resolveProjectId(projectId);
  const { beat, subject, artwork: entry } = await locateAuditedArtwork(projectId, beatId, artworkId);
  const settled = await settleFix({ projectId, beatId: beat._id, subject, entry });
  if (settled.fix?.status !== 'done') throw httpError('There is no finished fix to undo.', 409);
  const artwork = await undoArtworkEdit({ projectId, hostType: subject.kind, hostId: String(subject.id), artworkId: String(artworkId) });
  const next = {
    fix: { ...settled.fix, status: 'undone' },
    result_image_id: artwork?.result_image_id || null,
  };
  await updateArtworkCritiqueArtwork(projectId, beat._id, subject.id, artworkId, next);
  return serializeFixEntry(subject, { ...settled, ...next });
}
