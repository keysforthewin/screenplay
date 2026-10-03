// Top-level `video_prompts` collection — the Prompts tab's rows, now CUTS.
// Each row is one camera setup: a shot-table row (camera, who is in frame,
// the one action, idle business, light, last frame, sound), the compiled
// prose block (`prompt`) ending in its lock line, the start frame rendered
// for it, and the rendered clip. Cuts are grouped under SCENES
// (src/mongo/videoScenes.js) via `scene_id`; a row with `scene_id: null` is a
// legacy flat prompt ("Unsorted") and keeps working unchanged. The
// collection name is kept for that reason — no migration.
//
// Schema:
//   _id: ObjectId
//   project_id: string (24-hex)
//   beat_id: ObjectId (indexed)
//   order: number (1..N within a beat — global order: scene by scene, then
//                  unsorted rows; see recomputeCutOrderForBeat)
//   scene_id: ObjectId | null
//   cut_index: number | null (1..N within the scene)
//   title: string (markdown — short label, e.g. "Sarah enters the diner")
//   prompt: string (markdown — the compiled prose block; y-doc fragment
//                   `item:<id>:prompt`)
//   duration_seconds: number | null (the length the cut has in the assembled
//                                    film, half-second steps; a render snaps
//                                    it up to the model and the assembly
//                                    trims the surplus — src/web/cutTiming.js)
//   trim_head_seconds, trim_tail_seconds: number | null (hand-set trims the
//                                    assembly cuts off each end of the clip;
//                                    null = automatic)
//   camera: { size, angle, height, lens_mm, side, movement, motivation,
//             travel (from → to in landmarks), travel_widths (frame-widths
//             the frame moves; 0 when it holds), depth_of_field, lighting }
//   in_frame: [{ character, position, facing, acts }]
//   action_by, eyeline, action, others, last_frame, sound: string
//   reaction, crossing, contact, sound_on_action: boolean
//   characters_in_scene: [string], sets_in_scene: [string]
//   primary_spend: 'identity' | 'motion' | 'world' | null
//   felt_intent: string
//   hook: string (what the eye goes to in this cut — the reason the shot is
//                 in the film; never blank in a montage)
//   continues_previous: boolean (the same camera setup as the cut before it,
//                 continuous in time — a deliberate jump cut; its start frame
//                 is the previous cut's end frame, see cutStartFrames.js)
//   dialog_ids: [ObjectId]          (the dialogue lines this cut covers)
//   lock_line, reference_binding: string; exclusions: [string]
//   lint: [{ code, severity, message }]
//   start_frame: { image_id, prompt (y-doc fragment `item:<id>:start_frame_prompt`),
//                  reference_ids, reference_scores, model, generated_at,
//                  previous_image_id,
//                  reference_uses: { imageId: 'framing' } (set refs; default 'look'),
//                  references_planned: bool (the planner/user chose the list —
//                  an empty one is NOT auto-filled),
//                  derive: bool (END frame of a held camera: rendered by
//                  editing the start frame; its prompt is a change list),
//                  continuity_image_id (the start-frame image this end frame
//                  was built against — differs from start_frame.image_id
//                  once the start frame is re-rendered) } | null
//   end_frame: the same shape for the cut's LAST frame (y-doc fragment
//              `item:<id>:end_frame_prompt`) — what a first-last-frame video
//              model lands on | null
//   frame_check: { status: 'pass'|'fail'|'unchecked', issues: [{ kind,
//                  severity: 'blocking'|'minor', frame_to_fix: 'start'|'end',
//                  note, fix_instruction }], blocking (how many issues are
//                  blocking), rounds (repair rounds run), checked_at, start_image_id,
//                  end_image_id } | null — the vision check of the two
//                  rendered stills (src/web/cutFrameCheck.js); it describes
//                  exactly those two images and is stale for any others
//   reference_images: [{ image_id: ObjectId, owner_type: 'character'|'set',
//                        owner_name: string, label: string }]
//                     ordered — index i is @Image(i+1) in the prompt and the
//                     i-th image_urls entry sent to a reference-to-video model
//   audio_file_id: ObjectId | null   (the joined recording of the covered lines a
//   audio_duration_seconds: number|null   lip-sync render used; attachments bucket,
//                                    regenerated on every lip-sync render)
//   video_* fields: (video_file_id,
//                   video_duration_seconds, video_generated_at, video_model_id,
//                   video_model_label, video_fal_model, video_model_lab,
//                   video_model_family, video_model_added_at, video_parameters,
//                   video_cost_usd) so the SPA's ClipVideoPanel renders a
//                   cut row unchanged; plus video_provider ('fal'|'comfy'|null)
//                   and video_comfy ({ template, model_id, params, prompt_id }
//                   | null) for the ComfyUI provider
//   created_at, updated_at: Date

import { ObjectId } from 'mongodb';
import { getDb } from './client.js';
import { logger } from '../log.js';
import { resolveProjectId } from './projects.js';

const col = () => getDb().collection('video_prompts');
const scenesCol = () => getDb().collection('video_scenes');

const HEX24 = /^[a-f0-9]{24}$/i;

export const MAX_REFERENCE_IMAGES = 9;
export const MIN_PROMPT_DURATION = 4;
export const MAX_PROMPT_DURATION = 30;

export const CUT_SIZES = Object.freeze([
  'extreme_wide',
  'wide',
  'medium_wide',
  'medium',
  'medium_close_up',
  'close_up',
  'extreme_close_up',
  'insert',
  'over_the_shoulder',
  'two_shot',
]);
export const CUT_ANGLES = Object.freeze(['eye_level', 'low', 'high', 'dutch', 'top_down']);
export const CUT_MOVEMENTS = Object.freeze([
  'static',
  'push_in',
  'pull_out',
  'pan',
  'tilt',
  'truck',
  'track',
  'handheld',
  'crane',
]);
export const DEPTHS_OF_FIELD = Object.freeze(['deep', 'shallow']);
export const PRIMARY_SPENDS = Object.freeze(['identity', 'motion', 'world']);
export const VIDEO_PROVIDERS = Object.freeze(['fal', 'comfy']);

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && HEX24.test(id)) return new ObjectId(id);
  throw new Error(`invalid id: ${id}`);
}

function maybeOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && HEX24.test(id)) return new ObjectId(id);
  return null;
}

function normalizeFileId(v) {
  if (v == null) return null;
  if (v instanceof ObjectId) return v;
  if (typeof v === 'string' && HEX24.test(v)) return new ObjectId(v);
  throw new Error(`invalid file id: ${v}`);
}

function str(v) {
  if (v == null) return '';
  return typeof v === 'string' ? v.trim() : String(v).trim();
}

function bool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return ['true', 'yes', '1'].includes(v.trim().toLowerCase());
  return Boolean(v);
}

// "Close-up" / "close up" / "CLOSE_UP" → "close_up"; unknown → null.
function enumOrNull(v, list) {
  const s = str(v).toLowerCase().replace(/[\s-]+/g, '_');
  return list.includes(s) ? s : null;
}

export function normalizeStringList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(str).filter(Boolean);
}

const OWNER_TYPES = new Set(['character', 'set']);

// Normalize a reference_images list: valid image ids only, deduped by id,
// capped at MAX_REFERENCE_IMAGES, owner_type constrained. Throws on a
// malformed entry so a bad PATCH can't silently drop a reference.
export function normalizeReferenceImages(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error('reference_images must be an array');
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') throw new Error('reference_images entry must be an object');
    const oid = maybeOid(raw.image_id);
    if (!oid) throw new Error(`reference_images entry has invalid image_id: ${raw.image_id}`);
    const key = oid.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const ownerType = OWNER_TYPES.has(raw.owner_type) ? raw.owner_type : null;
    out.push({
      image_id: oid,
      owner_type: ownerType,
      owner_name: typeof raw.owner_name === 'string' ? raw.owner_name : '',
      label: typeof raw.label === 'string' ? raw.label : '',
    });
    if (out.length >= MAX_REFERENCE_IMAGES) break;
  }
  return out;
}

export const TRAVEL_DIRECTIONS = Object.freeze(['left', 'right', 'up', 'down']);

// The planner's output is best-effort: unknown enum values become null,
// never a throw. Always returns the full camera shape.
export function normalizeCamera(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const lensNum = Number(src.lens_mm);
  const lens = Number.isFinite(lensNum) && lensNum > 0 ? Math.round(lensNum) : null;
  const widthsNum = Number(src.travel_widths);
  const widths = src.travel_widths != null && src.travel_widths !== '' && Number.isFinite(widthsNum) && widthsNum >= 0
    ? Math.round(widthsNum * 100) / 100
    : null;
  return {
    size: enumOrNull(src.size, CUT_SIZES),
    angle: enumOrNull(src.angle, CUT_ANGLES),
    height: str(src.height),
    lens_mm: lens,
    side: str(src.side),
    movement: enumOrNull(src.movement, CUT_MOVEMENTS),
    motivation: str(src.motivation),
    travel: str(src.travel),
    travel_widths: widths,
    // The way the camera goes when its move slides the picture; null = none / unknown.
    travel_direction: enumOrNull(src.travel_direction, TRAVEL_DIRECTIONS),
    depth_of_field: enumOrNull(src.depth_of_field, DEPTHS_OF_FIELD),
    lighting: str(src.lighting),
  };
}

// [{ character, position, facing, acts }] — entries without a character
// name are dropped.
export function normalizeInFrame(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const character = str(e.character);
    if (!character) continue;
    out.push({
      character,
      position: str(e.position),
      facing: str(e.facing),
      acts: bool(e.acts),
    });
  }
  return out;
}

// Valid 24-hex / ObjectId entries only, deduped, order kept. Invalid entries
// are skipped (never throw — planner output).
export function normalizeDialogIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const v of raw) {
    const oid = maybeOid(v);
    if (!oid) continue;
    const k = oid.toString();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(oid);
  }
  return out;
}

export function normalizeLint(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const code = str(e.code);
    const message = str(e.message);
    if (!code && !message) continue;
    const sev = str(e.severity).toLowerCase();
    out.push({
      code: code || 'lint',
      severity: sev === 'error' || sev === 'info' ? sev : 'warn',
      message,
    });
  }
  return out;
}

export const FRAME_CHECK_STATUSES = Object.freeze(['pass', 'fail', 'unchecked']);

// null stays null; anything else becomes the full frame_check shape.
export function normalizeFrameCheck(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const issues = [];
  for (const e of Array.isArray(raw.issues) ? raw.issues : []) {
    if (!e || typeof e !== 'object') continue;
    const note = str(e.note);
    if (!note) continue;
    issues.push({
      kind: str(e.kind) || 'other',
      severity: e.severity === 'blocking' ? 'blocking' : 'minor',
      frame_to_fix: e.frame_to_fix === 'start' ? 'start' : 'end',
      note,
      fix_instruction: str(e.fix_instruction),
    });
  }
  const rounds = Number(raw.rounds);
  return {
    status: FRAME_CHECK_STATUSES.includes(raw.status) ? raw.status : 'unchecked',
    issues,
    blocking: issues.filter((i) => i.severity === 'blocking').length,
    rounds: Number.isFinite(rounds) && rounds > 0 ? Math.round(rounds) : 0,
    checked_at: dateOrNull(raw.checked_at),
    start_image_id: maybeOid(raw.start_image_id),
    end_image_id: maybeOid(raw.end_image_id),
  };
}

function normalizeScores(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (!HEX24.test(String(k))) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    out[String(k).toLowerCase()] = n;
  }
  return out;
}

// { imageId: 'framing' } — how the start-frame render uses a set reference.
// Only the non-default use is stored; a missing key means 'look'.
const REFERENCE_USES = new Set(['look', 'framing']);
function normalizeUses(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (!HEX24.test(String(k)) || !REFERENCE_USES.has(v)) continue;
    out[String(k).toLowerCase()] = v;
  }
  return out;
}

function dateOrNull(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// null stays null; anything else becomes the full frame shape (start_frame
// and end_frame share it).
export function normalizeStartFrame(raw) {
  if (raw == null) return null;
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    image_id: maybeOid(src.image_id),
    prompt: typeof src.prompt === 'string' ? src.prompt : '',
    reference_ids: normalizeDialogIds(src.reference_ids),
    reference_scores: normalizeScores(src.reference_scores),
    reference_uses: normalizeUses(src.reference_uses),
    references_planned: src.references_planned === true,
    derive: src.derive === true,
    continuity_image_id: maybeOid(src.continuity_image_id),
    // End frame of a sliding camera: the wide master plate both frames were
    // cropped from (panEndFrame.js); reused while the start frame is its crop.
    master_image_id: maybeOid(src.master_image_id),
    model: str(src.model) || null,
    generated_at: dateOrNull(src.generated_at),
    previous_image_id: maybeOid(src.previous_image_id),
  };
}

function normalizeVideoComfy(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

function normalizeDuration(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`duration_seconds must be a positive number or null, got ${v}`);
  }
  // Half-second steps: a quick cut is 1.5 s, not 1 or 2.
  return Math.max(0.5, Math.round(n * 2) / 2);
}

// trim_head_seconds / trim_tail_seconds: null = automatic, otherwise seconds
// (0 switches the automatic trim off at that end).
function normalizeTrim(v, field = 'trim') {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 60) {
    throw new Error(`${field} must be a number of seconds from 0 to 60 or null, got ${v}`);
  }
  return Math.round(n * 100) / 100;
}

function trimOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function intOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function backfill(doc) {
  if (!doc) return doc;
  return {
    ...doc,
    scene_id: maybeOid(doc.scene_id),
    cut_index: intOrNull(doc.cut_index),
    title: typeof doc.title === 'string' ? doc.title : '',
    prompt: typeof doc.prompt === 'string' ? doc.prompt : '',
    duration_seconds:
      typeof doc.duration_seconds === 'number' && Number.isFinite(doc.duration_seconds) && doc.duration_seconds > 0
        ? doc.duration_seconds
        : null,
    trim_head_seconds: trimOrNull(doc.trim_head_seconds),
    trim_tail_seconds: trimOrNull(doc.trim_tail_seconds),
    camera: normalizeCamera(doc.camera),
    in_frame: normalizeInFrame(doc.in_frame),
    action_by: str(doc.action_by),
    reaction: bool(doc.reaction),
    eyeline: str(doc.eyeline),
    action: str(doc.action),
    others: str(doc.others),
    last_frame: str(doc.last_frame),
    sound: str(doc.sound),
    crossing: bool(doc.crossing),
    contact: bool(doc.contact),
    sound_on_action: bool(doc.sound_on_action),
    characters_in_scene: normalizeStringList(doc.characters_in_scene),
    sets_in_scene: normalizeStringList(doc.sets_in_scene),
    primary_spend: enumOrNull(doc.primary_spend, PRIMARY_SPENDS),
    felt_intent: str(doc.felt_intent),
    hook: str(doc.hook),
    continues_previous: bool(doc.continues_previous),
    dialog_ids: normalizeDialogIds(doc.dialog_ids),
    lock_line: str(doc.lock_line),
    reference_binding: str(doc.reference_binding),
    exclusions: normalizeStringList(doc.exclusions),
    lint: normalizeLint(doc.lint),
    start_frame: normalizeStartFrame(doc.start_frame),
    end_frame: normalizeStartFrame(doc.end_frame),
    frame_check: normalizeFrameCheck(doc.frame_check),
    reference_images: Array.isArray(doc.reference_images)
      ? doc.reference_images
          .filter((r) => r && r.image_id)
          .map((r) => ({
            image_id: r.image_id,
            owner_type: OWNER_TYPES.has(r.owner_type) ? r.owner_type : null,
            owner_name: typeof r.owner_name === 'string' ? r.owner_name : '',
            label: typeof r.label === 'string' ? r.label : '',
          }))
      : [],
    audio_file_id: doc.audio_file_id ?? null,
    audio_duration_seconds:
      typeof doc.audio_duration_seconds === 'number' &&
      Number.isFinite(doc.audio_duration_seconds) &&
      doc.audio_duration_seconds > 0
        ? doc.audio_duration_seconds
        : null,
    video_file_id: doc.video_file_id ?? null,
    video_duration_seconds:
      typeof doc.video_duration_seconds === 'number' && Number.isFinite(doc.video_duration_seconds)
        ? doc.video_duration_seconds
        : null,
    video_generated_at: doc.video_generated_at ?? null,
    video_model_id: typeof doc.video_model_id === 'string' && doc.video_model_id ? doc.video_model_id : null,
    video_model_label:
      typeof doc.video_model_label === 'string' && doc.video_model_label ? doc.video_model_label : null,
    video_fal_model: typeof doc.video_fal_model === 'string' && doc.video_fal_model ? doc.video_fal_model : null,
    video_model_lab: typeof doc.video_model_lab === 'string' && doc.video_model_lab ? doc.video_model_lab : null,
    video_model_family:
      typeof doc.video_model_family === 'string' && doc.video_model_family ? doc.video_model_family : null,
    video_model_added_at: doc.video_model_added_at ?? null,
    video_parameters:
      doc.video_parameters && typeof doc.video_parameters === 'object' && !Array.isArray(doc.video_parameters)
        ? doc.video_parameters
        : null,
    video_cost_usd:
      typeof doc.video_cost_usd === 'number' && Number.isFinite(doc.video_cost_usd) ? doc.video_cost_usd : null,
    video_provider: enumOrNull(doc.video_provider, VIDEO_PROVIDERS),
    video_comfy: normalizeVideoComfy(doc.video_comfy),
  };
}

function sortCuts(docs) {
  // Within a scene: cut_index first (nulls last), then the global order.
  return docs.slice().sort((a, b) => {
    const ai = a.cut_index == null ? Infinity : a.cut_index;
    const bi = b.cut_index == null ? Infinity : b.cut_index;
    if (ai !== bi) return ai - bi;
    return (a.order || 0) - (b.order || 0);
  });
}

export async function listVideoPrompts({ projectId, beatId, sceneId } = {}) {
  if (sceneId) {
    const docs = await col().find({ scene_id: toOid(sceneId) }).toArray();
    return sortCuts(docs.map(backfill));
  }
  if (beatId) {
    const docs = await col().find({ beat_id: toOid(beatId) }).sort({ order: 1 }).toArray();
    return docs.map(backfill);
  }
  const pid = await resolveProjectId(projectId);
  const docs = (await col().find({}).sort({ order: 1 }).toArray()).filter(
    (d) => d.project_id === pid,
  );
  return docs.map(backfill);
}

export async function listVideoPromptsForScene(sceneId) {
  return listVideoPrompts({ sceneId });
}

export async function countVideoPromptsByBeat(projectId) {
  const pid = await resolveProjectId(projectId);
  const docs = await col()
    .find({}, { projection: { beat_id: 1, project_id: 1 } })
    .toArray();
  const counts = new Map();
  for (const d of docs) {
    if (d.project_id !== pid) continue;
    const k = d.beat_id?.toString?.();
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return counts;
}

async function getVideoPromptAnyProject(id) {
  const oid = maybeOid(id);
  if (!oid) return null;
  const doc = await col().findOne({ _id: oid });
  return backfill(doc);
}

export async function getVideoPrompt(projectId, id) {
  const doc = await getVideoPromptAnyProject(id);
  if (!doc) return null;
  // Verify-after-locate: a cross-project id behaves as not-found.
  const pid = await resolveProjectId(projectId);
  if (doc.project_id !== pid) return null;
  return doc;
}

export async function createVideoPrompt({
  id = null,
  projectId,
  beatId,
  order,
  title = '',
  prompt = '',
  durationSeconds = null,
  referenceImages = [],
  sceneId = null,
  cutIndex = null,
  camera = null,
  inFrame = [],
  actionBy = '',
  reaction = false,
  eyeline = '',
  action = '',
  others = '',
  lastFrame = '',
  sound = '',
  crossing = false,
  contact = false,
  soundOnAction = false,
  charactersInScene = [],
  setsInScene = [],
  primarySpend = null,
  feltIntent = '',
  hook = '',
  continuesPrevious = false,
  dialogIds = [],
  lockLine = '',
  referenceBinding = '',
  exclusions = [],
  lint = [],
  startFrame = null,
  endFrame = null,
} = {}) {
  if (!beatId) throw new Error('beatId required');
  const pid = await resolveProjectId(projectId);
  const beatOid = toOid(beatId);
  let nextOrder = order;
  if (nextOrder === undefined || nextOrder === null) {
    const existing = await col()
      .find({ beat_id: beatOid }, { projection: { order: 1 } })
      .toArray();
    nextOrder = existing.length ? Math.max(...existing.map((d) => d.order || 0)) + 1 : 1;
  }
  const sceneOid = maybeOid(sceneId);
  let nextCutIndex = intOrNull(cutIndex);
  if (sceneOid && nextCutIndex == null) {
    const inScene = await col()
      .find({ scene_id: sceneOid }, { projection: { cut_index: 1 } })
      .toArray();
    nextCutIndex = inScene.length ? Math.max(...inScene.map((d) => d.cut_index || 0)) + 1 : 1;
  }
  const now = new Date();
  const doc = {
    _id: id ? toOid(id) : new ObjectId(),
    project_id: pid,
    beat_id: beatOid,
    order: Number(nextOrder),
    scene_id: sceneOid,
    cut_index: sceneOid ? nextCutIndex : null,
    title: String(title || ''),
    prompt: String(prompt || ''),
    duration_seconds: normalizeDuration(durationSeconds),
    trim_head_seconds: null,
    trim_tail_seconds: null,
    camera: normalizeCamera(camera),
    in_frame: normalizeInFrame(inFrame),
    action_by: str(actionBy),
    reaction: bool(reaction),
    eyeline: str(eyeline),
    action: str(action),
    others: str(others),
    last_frame: str(lastFrame),
    sound: str(sound),
    crossing: bool(crossing),
    contact: bool(contact),
    sound_on_action: bool(soundOnAction),
    characters_in_scene: normalizeStringList(charactersInScene),
    sets_in_scene: normalizeStringList(setsInScene),
    primary_spend: enumOrNull(primarySpend, PRIMARY_SPENDS),
    felt_intent: str(feltIntent),
    hook: str(hook),
    continues_previous: bool(continuesPrevious),
    dialog_ids: normalizeDialogIds(dialogIds),
    lock_line: str(lockLine),
    reference_binding: str(referenceBinding),
    exclusions: normalizeStringList(exclusions),
    lint: normalizeLint(lint),
    start_frame: normalizeStartFrame(startFrame),
    end_frame: normalizeStartFrame(endFrame),
    frame_check: null,
    reference_images: normalizeReferenceImages(referenceImages),
    audio_file_id: null,
    audio_duration_seconds: null,
    video_file_id: null,
    video_duration_seconds: null,
    video_generated_at: null,
    video_model_id: null,
    video_model_label: null,
    video_fal_model: null,
    video_model_lab: null,
    video_model_family: null,
    video_model_added_at: null,
    video_parameters: null,
    video_cost_usd: null,
    video_provider: null,
    video_comfy: null,
    created_at: now,
    updated_at: now,
  };
  await col().insertOne(doc);
  logger.info(`mongo: video_prompt create id=${doc._id} beat=${beatOid} order=${doc.order}`);
  return backfill(doc);
}

const TEXT_FIELDS = new Set(['title', 'prompt']);
const ID_FIELDS = new Set(['video_file_id', 'audio_file_id']);
const STRING_OR_NULL_FIELDS = new Set([
  'video_model_id',
  'video_model_label',
  'video_fal_model',
  'video_model_lab',
  'video_model_family',
]);
const DATE_OR_NULL_FIELDS = new Set(['video_generated_at', 'video_model_added_at']);
// Free-text shot-table cells (trimmed strings).
const CUT_STRING_FIELDS = new Set([
  'action_by',
  'eyeline',
  'action',
  'others',
  'last_frame',
  'sound',
  'felt_intent',
  'hook',
  'lock_line',
  'reference_binding',
]);
const CUT_BOOL_FIELDS = new Set(['reaction', 'crossing', 'contact', 'sound_on_action', 'continues_previous']);
const CUT_LIST_FIELDS = new Set(['characters_in_scene', 'sets_in_scene', 'exclusions']);

export async function updateVideoPrompt(projectId, id, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('update_video_prompt: `patch` must be an object.');
  }
  const existing = await getVideoPrompt(projectId, id);
  if (!existing) throw new Error(`Video prompt not found: ${id}`);
  const set = { updated_at: new Date() };
  const framePrompts = {};
  for (const [k, v] of Object.entries(patch)) {
    if (TEXT_FIELDS.has(k)) {
      set[k] = String(v ?? '');
    } else if (ID_FIELDS.has(k)) {
      set[k] = normalizeFileId(v);
    } else if (STRING_OR_NULL_FIELDS.has(k)) {
      set[k] = v == null ? null : String(v);
    } else if (DATE_OR_NULL_FIELDS.has(k)) {
      set[k] = dateOrNull(v);
    } else if (k === 'duration_seconds') {
      set[k] = normalizeDuration(v);
    } else if (k === 'trim_head_seconds' || k === 'trim_tail_seconds') {
      set[k] = normalizeTrim(v, k);
    } else if (k === 'reference_images') {
      set[k] = normalizeReferenceImages(v);
    } else if (k === 'video_duration_seconds' || k === 'video_cost_usd' || k === 'audio_duration_seconds') {
      if (v == null) {
        set[k] = null;
      } else if (!Number.isFinite(Number(v)) || Number(v) < 0) {
        throw new Error(`update_video_prompt: ${k} must be a non-negative number or null, got ${v}`);
      } else {
        set[k] = Number(v);
      }
    } else if (k === 'video_parameters') {
      set[k] = v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } else if (k === 'video_provider') {
      set[k] = enumOrNull(v, VIDEO_PROVIDERS);
    } else if (k === 'video_comfy') {
      set[k] = normalizeVideoComfy(v);
    } else if (k === 'order') {
      if (!Number.isFinite(Number(v))) {
        throw new Error(`update_video_prompt: order must be a number, got ${v}`);
      }
      set[k] = Number(v);
    } else if (k === 'scene_id') {
      if (v != null && !maybeOid(v)) {
        throw new Error(`update_video_prompt: scene_id must be an id or null, got ${v}`);
      }
      set[k] = maybeOid(v);
    } else if (k === 'cut_index') {
      if (v != null && !Number.isFinite(Number(v))) {
        throw new Error(`update_video_prompt: cut_index must be a number or null, got ${v}`);
      }
      set[k] = intOrNull(v);
    } else if (k === 'camera') {
      set[k] = normalizeCamera(v);
    } else if (k === 'in_frame') {
      set[k] = normalizeInFrame(v);
    } else if (CUT_STRING_FIELDS.has(k)) {
      set[k] = str(v);
    } else if (CUT_BOOL_FIELDS.has(k)) {
      set[k] = bool(v);
    } else if (CUT_LIST_FIELDS.has(k)) {
      set[k] = normalizeStringList(v);
    } else if (k === 'primary_spend') {
      set[k] = enumOrNull(v, PRIMARY_SPENDS);
    } else if (k === 'dialog_ids') {
      set[k] = normalizeDialogIds(v);
    } else if (k === 'lint') {
      set[k] = normalizeLint(v);
    } else if (k === 'start_frame' || k === 'end_frame') {
      set[k] = normalizeStartFrame(v);
    } else if (k === 'frame_check') {
      set[k] = normalizeFrameCheck(v);
    } else if (k === 'start_frame_prompt' || k === 'end_frame_prompt') {
      framePrompts[k.replace(/_prompt$/, '')] = typeof v === 'string' ? v : String(v ?? '');
    } else {
      throw new Error(`update_video_prompt: unknown field "${k}"`);
    }
  }
  for (const [key, text] of Object.entries(framePrompts)) {
    // The y-doc persist path for `item:<id>:start_frame_prompt` /
    // `end_frame_prompt`. A dotted $set into a null sub-doc is a Mongo
    // error, so create the sub-doc when the row has no such frame yet.
    if (set[key] && typeof set[key] === 'object') {
      set[key].prompt = text;
    } else if (set[key] === null || !existing[key]) {
      set[key] = normalizeStartFrame({ prompt: text });
    } else {
      set[`${key}.prompt`] = text;
    }
  }
  if (Object.keys(set).length === 1) {
    throw new Error('update_video_prompt: patch produced no changes');
  }
  await col().updateOne({ _id: existing._id }, { $set: set });
  logger.info(
    `mongo: video_prompt update id=${existing._id} fields=[${Object.keys(set)
      .filter((k) => k !== 'updated_at')
      .join(',')}]`,
  );
  return getVideoPrompt(projectId, existing._id);
}

export async function deleteVideoPrompt(id) {
  const d = await getVideoPromptAnyProject(id);
  if (!d) throw new Error(`Video prompt not found: ${id}`);
  await col().deleteOne({ _id: d._id });
  logger.info(`mongo: video_prompt delete id=${d._id}`);
  return d;
}

export async function deleteVideoPromptsForBeat(beatId) {
  const beatOid = toOid(beatId);
  const list = await col().find({ beat_id: beatOid }).toArray();
  if (typeof col().deleteMany === 'function') {
    await col().deleteMany({ beat_id: beatOid });
  } else {
    for (const d of list) await col().deleteOne({ _id: d._id });
  }
  return list.map(backfill);
}

export async function deleteVideoPromptsForScene(sceneId) {
  const sceneOid = toOid(sceneId);
  const list = await col().find({ scene_id: sceneOid }).toArray();
  if (typeof col().deleteMany === 'function') {
    await col().deleteMany({ scene_id: sceneOid });
  } else {
    for (const d of list) await col().deleteOne({ _id: d._id });
  }
  return sortCuts(list.map(backfill));
}

export async function reorderVideoPromptsForBeat(beatId, orderedIds) {
  if (!Array.isArray(orderedIds)) throw new Error('orderedIds must be an array');
  const beatOid = toOid(beatId);
  const current = await listVideoPrompts({ beatId: beatOid });
  if (current.length !== orderedIds.length) {
    throw new Error(`reorder: orderedIds length ${orderedIds.length} != current ${current.length}`);
  }
  const seen = new Set();
  for (const rawId of orderedIds) {
    const oid = toOid(rawId);
    const key = oid.toString();
    if (seen.has(key)) throw new Error(`reorder: duplicate id ${key}`);
    seen.add(key);
    if (!current.some((c) => String(c._id) === key)) {
      throw new Error(`reorder: id ${key} not in this beat`);
    }
  }
  for (let i = 0; i < orderedIds.length; i++) {
    await col().updateOne(
      { _id: toOid(orderedIds[i]) },
      { $set: { order: i + 1, updated_at: new Date() } },
    );
  }
  return listVideoPrompts({ beatId: beatOid });
}

// The beat's scenes in their stored order, as id strings. Read straight from
// the collection so this module stays import-cycle free.
async function sceneOrderForBeat(beatOid) {
  const docs = await scenesCol()
    .find({ beat_id: beatOid }, { projection: { order: 1 } })
    .toArray();
  return docs
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((d) => d._id.toString());
}

// Recompute the global `order` of every cut in a beat: scene by scene (in
// `sceneOrder`, then any scene missing from that list in order of first
// appearance), each scene's cuts by cut_index (ties by current order,
// renumbered 1..N), then the unsorted rows (scene_id: null) in their current
// order with cut_index left null. Only rows whose numbers change are written.
export async function recomputeCutOrderForBeat(beatId, sceneOrder) {
  const beatOid = toOid(beatId);
  const rows = await listVideoPrompts({ beatId: beatOid });
  const listed = Array.isArray(sceneOrder)
    ? sceneOrder.map((s) => String(s?.toString?.() ?? s))
    : await sceneOrderForBeat(beatOid);
  const byScene = new Map();
  const unsorted = [];
  for (const r of rows) {
    const sid = r.scene_id ? r.scene_id.toString() : null;
    if (!sid) {
      unsorted.push(r);
      continue;
    }
    if (!byScene.has(sid)) byScene.set(sid, []);
    byScene.get(sid).push(r);
  }
  const sceneIds = [...listed.filter((sid) => byScene.has(sid))];
  for (const sid of byScene.keys()) if (!sceneIds.includes(sid)) sceneIds.push(sid);
  let order = 0;
  const writes = [];
  for (const sid of sceneIds) {
    const cuts = sortCuts(byScene.get(sid));
    for (let i = 0; i < cuts.length; i++) {
      order += 1;
      const c = cuts[i];
      if (c.order !== order || c.cut_index !== i + 1) {
        writes.push({ _id: c._id, order, cut_index: i + 1 });
      }
    }
  }
  for (const r of unsorted) {
    order += 1;
    if (r.order !== order || r.cut_index != null) {
      writes.push({ _id: r._id, order, cut_index: null });
    }
  }
  for (const w of writes) {
    await col().updateOne(
      { _id: w._id },
      { $set: { order: w.order, cut_index: w.cut_index, updated_at: new Date() } },
    );
  }
  return listVideoPrompts({ beatId: beatOid });
}

// Renumber cut_index within one scene from an explicit full ordering, then
// recompute the beat's global order. Returns the scene's cuts.
export async function reorderCutsInScene(sceneId, orderedIds) {
  if (!Array.isArray(orderedIds)) throw new Error('orderedIds must be an array');
  const sceneOid = toOid(sceneId);
  const current = await listVideoPrompts({ sceneId: sceneOid });
  if (current.length !== orderedIds.length) {
    throw new Error(`reorder: orderedIds length ${orderedIds.length} != current ${current.length}`);
  }
  const seen = new Set();
  for (const rawId of orderedIds) {
    const oid = toOid(rawId);
    const key = oid.toString();
    if (seen.has(key)) throw new Error(`reorder: duplicate id ${key}`);
    seen.add(key);
    if (!current.some((c) => String(c._id) === key)) {
      throw new Error(`reorder: id ${key} not in this scene`);
    }
  }
  for (let i = 0; i < orderedIds.length; i++) {
    await col().updateOne(
      { _id: toOid(orderedIds[i]) },
      { $set: { cut_index: i + 1, updated_at: new Date() } },
    );
  }
  const beatOid = current[0]?.beat_id;
  if (beatOid) await recomputeCutOrderForBeat(beatOid);
  return listVideoPrompts({ sceneId: sceneOid });
}

export async function ensureIndexes() {
  await col().createIndex({ beat_id: 1, order: 1 });
  await col().createIndex({ project_id: 1, beat_id: 1 });
  await col().createIndex({ scene_id: 1, cut_index: 1 });
}
