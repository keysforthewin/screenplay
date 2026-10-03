// src/web/cutFrameCheck.js
// The quality loop for a cut's two stills. A first-last-frame video model
// animates EVERY difference between the start frame and the end frame, so a
// difference the cut does not perform becomes a fault on screen: a jacket
// that turns into the reference photo's T-shirt, a butter dispenser that
// grows out of the counter, a man who pops into a seat, seat rows that slide
// across the floor, a bucket that simply ceases to exist.
//
//   checkCutFramePair  — one vision call: both rendered stills plus what the
//                        cut performs; returns the differences it does not.
//   reconcileCutFrames — check → repair → check, then the verdict is saved on
//                        the cut (`frame_check`). A repair edits whichever
//                        frame is wrong — either direction — with the other
//                        frame attached as the reference for what must match.
//
// Every issue has a SEVERITY. A `blocking` one breaks the shot on screen (a
// person who pops in, a crowd of different people, a wrong vantage point): the
// loop keeps repairing while one remains, up to blockingRepairRounds() rounds
// (6; CUT_FRAME_BLOCKING_ROUNDS, 2–10), and from the third round it stops
// patching the end frame and REBUILDS it from the start frame. A pair left
// with only `minor` issues stops at MAX_REPAIR_ROUNDS. `frame_check.blocking`
// counts what is left — the SPA shows it in red.
//
// reconcileCutFrames never takes the beat lock: its callers hold it (the
// start-frame jobs in cutStartFrames.js, the planner, the beat render).
// A check that cannot run (no API key, an API error) is 'unchecked' and never
// fails the job it runs in. CUT_FRAME_CHECK=off switches the whole loop off
// (each check is one vision call per cut; tests/setup.js pins it off so the
// suite never reaches the API — tests that want it install the seam).

import sharp from 'sharp';
import { computeAnthropicImageTokens } from '../agent/imageTokens.js';
import { getAnthropic } from '../anthropic/client.js';
import { modelFor } from '../llm/modelSlots.js';
import { logger } from '../log.js';
import { recordAnthropicImageInputUsage, recordAnthropicTextUsage } from '../mongo/tokenUsage.js';
import { getVideoPrompt } from '../mongo/videoPrompts.js';
import { stripMarkdown } from '../util/markdown.js';
import { findCharactersInBeat, loadImageInput } from './beatPlanShared.js';
import { cutWardrobeLocks, formatLockRows } from './wardrobe.js';

// The wardrobe lock lines for the people this cut puts in frame (best
// effort — a check never fails for want of them).
async function wardrobeLocksForCut(projectId, beat, cut) {
  if (!projectId || !beat) return '';
  try {
    return formatLockRows(cutWardrobeLocks(cut, await findCharactersInBeat(projectId, beat), beat));
  } catch (e) {
    logger.warn(`cut frame check: wardrobe locks failed: ${e?.message || e}`);
    return '';
  }
}
import { cameraTravels } from './cutTiming.js';
import { panDirectionForCut } from './panEndFrame.js';

export const MAX_REPAIR_ROUNDS = 2;
export const DEFAULT_BLOCKING_ROUNDS = 6;
// Patch edits are tried this many rounds before a blocking end-frame fault
// rebuilds the end frame from the start frame.
const PATCH_ROUNDS_BEFORE_REBUILD = 2;

// Read at call time, like every other switch here.
export function blockingRepairRounds() {
  const n = Math.round(Number(process.env.CUT_FRAME_BLOCKING_ROUNDS));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BLOCKING_ROUNDS;
  return Math.min(10, Math.max(MAX_REPAIR_ROUNDS, n));
}
// A repair edit can itself lose something (the lot's one moving car went with
// a "regrade the sky" edit). When the last check finds ONLY such losses, new
// since the check before, one more round puts them back.
const MISSING_KINDS = ['action_missing', 'prop_missing', 'person_missing'];
export const FRAME_ISSUE_KINDS = Object.freeze([
  'wardrobe',
  'identity',
  'person_added',
  'person_missing',
  'crowd',
  'prop_added',
  'prop_missing',
  'layout',
  'light',
  'camera',
  'action_missing',
  'intent',
  'other',
]);
export const FRAME_ISSUE_SEVERITIES = Object.freeze(['blocking', 'minor']);
// What an issue with no (or an unknown) severity is taken to be.
const BLOCKING_BY_DEFAULT = ['crowd', 'person_added', 'person_missing', 'identity', 'camera'];

// Wide enough to read a jacket, a seat count and a prop on a counter; small
// enough that a check costs about two thousand input tokens.
const VISION_WIDTH = 1280;

const CHECK_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...FRAME_ISSUE_KINDS] },
            severity: { type: 'string', enum: [...FRAME_ISSUE_SEVERITIES] },
            frame_to_fix: { type: 'string', enum: ['start', 'end'] },
            note: { type: 'string' },
            fix_instruction: { type: 'string' },
          },
          required: ['kind', 'severity', 'frame_to_fix', 'note', 'fix_instruction'],
          additionalProperties: false,
        },
      },
    },
    required: ['issues'],
    additionalProperties: false,
  },
};

export const FRAME_CHECK_SYSTEM_PROMPT = [
  'You are the script supervisor checking the two stills of ONE film cut before a video model animates between them. Image 1 is the FIRST frame of the cut; image 2 is its LAST frame, a few seconds later.',
  'A first-last-frame video model turns EVERY difference between the two into motion: a prop in one still and not the other grows out of the counter, a person in one and not the other pops into the seat, seats arranged differently slide across the floor, a jacket in one and a T-shirt in the other morphs on the body. Report every difference the cut does NOT perform. Never report a difference it does perform.',
  '',
  '# What to compare',
  '- A HELD camera (static or handheld): the two stills are the same picture except for the action. Compare everything — count the people in each; each person\'s clothing, hair and build; every prop and fixture and where it sits; the furniture\'s count and arrangement; the light and colour; the framing itself.',
  '- A MOVING camera: the framing differs on purpose. Compare the people and their clothing, and the part of the place that is visible in BOTH stills (the same construction, the same furniture arrangement, the same props). What the move reveals is new and is not an issue.',
  '- A camera that SLIDES the picture (the cut line says so: a pan, tilt, sideways truck or crane, with a direction and a distance): the last frame must be the first frame slid that way. The exact distance does not matter — anything from a third to a half of the frame is right, even where the block describes a longer move — only the direction and the sameness do. Whatever both frames can see is the SAME thing — the same wall, the same people, the same vehicles — seen from the same angle at the same size, only displaced. A last frame taken from another spot, facing the place from another side, at another distance, showing different people or a rebuilt wall where the first frame\'s should still be in view, or made of two pictures that meet along a visible line, is a camera issue on the END frame. A slight change of perspective on a building, as a real turn of the camera gives, is not.',
  '',
  '- EACH still against the cut itself, separately: does the picture show what the block is about? The image model never read the block. Check the point of the cut (a hurry must be visible in the bodies — stride, lean, who is ahead; a stroll is a fault), where people are heading (toward the destination the block names, not past it), the eyeline line, and every "Do not show …" limit (a face the cut withholds must not be visible from the front in either still).',
  '',
  '# Kinds',
  '- wardrobe: a person\'s clothing differs between the stills — or, for a person whose WARDROBE LOCK is stated under the cut, differs from that text in either still (a locked navy flannel shirt rendered as a grey hoodie is a wardrobe issue on that frame, even when both stills agree). identity: their face, hair, build or age differs.',
  '- person_added / person_missing: someone is in one still only and the block does not show them enter or leave. Background people count.',
  '- crowd: the background people are not the same individuals. Wherever both stills show the same part of the place — the whole frame for a held camera, the overlap for a sliding one, what stays in view for a push or a pull — go through the crowd seat by seat, spot by spot: is the person in each place the same person (clothing colour, hair, build, who sits beside whom)? A crowd of the same size and spread made of DIFFERENT people is a crowd issue even though the head count matches: every one of them would morph on screen. Fix the END frame. Name three or four of the swaps in the note ("second row: the woman in the yellow cardigan is a man in a grey hoodie").',
  '- prop_added / prop_missing: an object or fixture is in one still only.',
  '- layout: furniture, seat rows, counters or architecture counted or arranged differently.',
  '- light: the source, its direction or its colour differs.',
  '- camera: a held camera whose framing changed, or a moving camera whose last frame is not where the block takes it.',
  '- intent: a still that contradicts the cut — the wrong energy in the bodies, people heading the wrong way, a withheld face shown, eyes to the lens. Name the frame it is in; when both stills have it, report it once per frame.',
  '- action_missing: the last frame does not show the end state the block and the last-frame cell describe (an object that left a hand must lie somewhere in view), or the first frame already shows it.',
  '',
  '# Severity',
  '- blocking: the clip will visibly break — a viewer would see it at once. A person appearing or vanishing; a principal whose face, build or clothing changes; background people replaced by others (crowd); furniture, seat rows or architecture rearranged; a sliding camera\'s last frame taken from another vantage point or showing a join; the end state the cut is about missing; a withheld face shown; a still that contradicts the point of the cut.',
  '- minor: a viewer would not catch it at speed — a small prop or a piece of set dressing at the edge, a slight shift of light or colour, a detail of a garment, a background object.',
  'When in doubt between the two, ask whether the audience would SEE the change happen in a three-second clip. If yes, blocking.',
  '',
  '# Which frame to fix (frame_to_fix)',
  '- wardrobe, identity, crowd, layout, light: the FIRST frame is the reference — fix the end frame to match it.',
  '- Something only in the LAST frame: if the cut needs it (the block uses or names it), fix the START frame by adding it; otherwise fix the END frame by removing it.',
  '- Something only in the FIRST frame that the block does not take away: fix the END frame by putting it back.',
  '- action_missing, intent: the frame that shows the wrong state.',
  '',
  '# fix_instruction',
  'One imperative sentence an image-edit model can carry out on that frame alone: name the thing, its place, and what it must match. "Change the boy\'s grey T-shirt to the red zip windbreaker he wears in the other frame." "Remove the man in the second seat of the back row; show the empty red seat." "Add a steel butter dispenser at the left end of the counter, exactly as in the other frame." Never ask for a new camera or a reframing — except for the camera issue of a sliding move, where the instruction says what should have slid where ("The entrance canopy and glass doors at the left edge now sit right of centre, seen from the same spot at the same size; the ticket line stays at the window right of the doors; the sign board is half out of frame at the right edge; the same front row of parked cars runs along the bottom") — name each landmark of the first frame and where it now sits; that end frame is rebuilt from the first frame with this sentence as its guide.',
  '',
  '# Judgement',
  'Be strict about people, clothing, props and layout — and about WHO the background people are. Ignore rendering noise: grain, a wrinkle, flicker from a screen, and a background person\'s pose (the same person leaning the other way is not an issue; a different person in their seat is). When you are not sure a difference is real, it is not an issue. An empty list means the pair is ready to animate.',
].join('\n');

function plain(v) {
  return stripMarkdown(typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
}

function idString(v) {
  return v ? v.toString?.() || String(v) : null;
}

// What the cut performs between its two stills, in words.
// `wardrobeLocks`: the `Wardrobe lock — <name>: <text>` block for the people
// in frame (src/web/wardrobe.js), when the caller has the beat's cast.
export function buildFrameCheckText(cut, { wardrobeLocks = '' } = {}) {
  const cam = cut?.camera || {};
  const travels = cameraTravels(cut);
  const slideDirection = panDirectionForCut(cut);
  const people = (cut?.in_frame || []).map((p) => `${p.character} — ${p.position || '?'}, facing ${p.facing || '?'}${p.acts ? ' (acts)' : ''}`);
  return [
    '# The cut',
    `Camera: ${travels ? `MOVING — ${String(cam.movement).replace(/_/g, ' ')}${cam.travel ? `, ${cam.travel}` : ''}` : `HELD (${cam.movement ? String(cam.movement).replace(/_/g, ' ') : 'static'})`}`,
    ...(slideDirection
      ? [`The move SLIDES the picture: the camera goes ${slideDirection}, so everything in the first frame is displaced the other way by a third to a half of the frame, and about half of the first frame is still in view in the last. The stills are deliberately a SHORTER slide than the block and the last-frame prompt may describe: something they say has left the frame may still sit at its edge, and that is correct.`]
      : []),
    `Principals in frame: ${people.length ? people.join('; ') : '(none named)'}`,
    `The one action${cut?.action_by ? ` (${cut.action_by})` : ''}: ${plain(cut?.action) || '—'}`,
    `Others in frame: ${plain(cut?.others) || '—'}`,
    `Eyeline: ${plain(cut?.eyeline) || '—'}`,
    `Felt intent: ${plain(cut?.felt_intent) || '—'}`,
    `Hook (what the eye must go to): ${plain(cut?.hook) || '—'}`,
    `Limits: ${(Array.isArray(cut?.exclusions) ? cut.exclusions : []).map(plain).filter(Boolean).join(' ') || '—'}`,
    `Last-frame cell: ${plain(cut?.last_frame) || '—'}`,
    ...(String(wardrobeLocks || '').trim() ? ['', 'Wardrobe locks (each still must match these words):', String(wardrobeLocks).trim()] : []),
    '',
    'Block (what the clip performs between the two stills):',
    plain(cut?.prompt) || '(none)',
    '',
    `First-frame prompt: ${plain(cut?.start_frame?.prompt) || '(none)'}`,
    `Last-frame prompt${cut?.end_frame?.derive ? ' (a change list applied to the first frame)' : ''}: ${plain(cut?.end_frame?.prompt) || '(none)'}`,
  ].join('\n');
}

// A still as the checker sees it: a JPEG no wider than VISION_WIDTH. Falls
// back to the stored bytes when they cannot be decoded.
async function visionImage(imageId) {
  const ref = await loadImageInput(imageId);
  if (!ref) return null;
  try {
    const buffer = await sharp(ref.buffer).rotate().resize({ width: VISION_WIDTH, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    return { buffer, contentType: 'image/jpeg' };
  } catch (e) {
    logger.warn(`cut frame check: could not resize image ${imageId}: ${e?.message || e}`);
    return { buffer: ref.buffer, contentType: ref.contentType };
  }
}

export function normalizeFrameIssues(raw) {
  const out = [];
  for (const e of Array.isArray(raw) ? raw : []) {
    if (!e || typeof e !== 'object') continue;
    const note = plain(e.note);
    if (!note) continue;
    const kind = FRAME_ISSUE_KINDS.includes(e.kind) ? e.kind : 'other';
    out.push({
      kind,
      severity: FRAME_ISSUE_SEVERITIES.includes(e.severity) ? e.severity : BLOCKING_BY_DEFAULT.includes(kind) ? 'blocking' : 'minor',
      frame_to_fix: e.frame_to_fix === 'start' ? 'start' : 'end',
      note,
      fix_instruction: plain(e.fix_instruction) || note,
    });
  }
  return out;
}

// Test seam: fn({ cut, text }) → { issues: [...] } (or throws).
let checkerOverride = null;
export function _setFrameCheckerForTests(fn) {
  checkerOverride = fn;
}

// Read at call time, like every other switch here.
export function frameCheckEnabled() {
  if (checkerOverride) return true;
  return String(process.env.CUT_FRAME_CHECK || '').trim().toLowerCase() !== 'off';
}

async function callChecker({ cut, text }) {
  const [first, last] = await Promise.all([visionImage(cut.start_frame.image_id), visionImage(cut.end_frame.image_id)]);
  if (!first || !last) throw new Error('a frame image could not be read');
  const model = modelFor('storyboard');
  const image = (img) => ({ type: 'image', source: { type: 'base64', media_type: img.contentType, data: img.buffer.toString('base64') } });
  const ask = () => getAnthropic().messages.create({
    model,
    max_tokens: 16000,
    system: FRAME_CHECK_SYSTEM_PROMPT,
    output_config: { format: CHECK_FORMAT },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Image 1 — the FIRST frame of the cut:' },
          image(first),
          { type: 'text', text: 'Image 2 — the LAST frame of the cut:' },
          image(last),
          { type: 'text', text: `${text}\n\nReturn every difference between the two stills that this cut does not perform.` },
        ],
      },
    ],
  });
  const textOf = (r) => (r?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  let resp = await ask();
  // An empty answer (seen from the coding-agent providers) is asked once more
  // rather than leaving the pair unchecked.
  if (!textOf(resp)) {
    logger.warn(`cut frame check: empty answer for cut ${cut?._id} (stop_reason ${resp?.stop_reason || '?'}); asking again`);
    resp = await ask();
  }
  try {
    const imageTokens = computeAnthropicImageTokens([first.buffer, last.buffer]);
    const input = Number(resp?.usage?.input_tokens) || 0;
    await recordAnthropicTextUsage({
      discordUser: null,
      channelId: null,
      model,
      totals: { input_tokens: Math.max(0, input - imageTokens.total), output_tokens: Number(resp?.usage?.output_tokens) || 0 },
    });
    await recordAnthropicImageInputUsage({ discordUser: null, channelId: null, model, perImageTokens: imageTokens.perImageTokens });
  } catch (e) {
    logger.warn(`cut frame check: usage record failed: ${e?.message || e}`);
  }
  return JSON.parse(textOf(resp));
}

// One check of the cut's two rendered stills. Never throws:
// { status: 'pass' | 'fail' | 'unchecked', issues, reason? }.
export async function checkCutFramePair({ cut, wardrobeLocks = '' }) {
  if (!cut?.start_frame?.image_id || !cut?.end_frame?.image_id) {
    return { status: 'unchecked', issues: [], reason: 'both frames must be rendered' };
  }
  const text = buildFrameCheckText(cut, { wardrobeLocks });
  try {
    const raw = checkerOverride ? await checkerOverride({ cut, text }) : await callChecker({ cut, text });
    const issues = normalizeFrameIssues(raw?.issues);
    return { status: issues.length ? 'fail' : 'pass', issues };
  } catch (e) {
    logger.warn(`cut frame check: cut ${cut?._id} could not be checked: ${e?.message || e}`);
    return { status: 'unchecked', issues: [], reason: e?.message || String(e) };
  }
}

// The instruction an image-edit model gets to repair one frame. The frame
// being repaired is the first input; the cut's other frame rides along as
// the reference for what must match.
export function composeRepairPrompt({ frame, fixes, withOtherFrame = true }) {
  const which = frame === 'start' ? 'opening' : 'closing';
  const other = frame === 'start' ? 'closing frame of the same shot, a few seconds later' : 'opening frame of the same shot, a few seconds earlier';
  const list = (fixes || []).map((f) => `- ${plain(f.fix_instruction || f.note)}`).filter((l) => l.length > 2);
  return [
    `The first image is the ${which} frame of a film shot.${withOtherFrame ? ` The second image is the ${other}: it is only the reference for what must match — never copy its framing or its poses.` : ''}`,
    'Keep the camera, the framing, the light and everything else in the first image exactly as it is. Make only these corrections:',
    list.join('\n'),
    'Apart from those corrections, lose nothing: every person, vehicle, object, sign and light that is in the first image now is still in it afterwards, in the same place and the same state.',
  ].join('\n\n');
}

function summarize(issues) {
  return issues.map((i) => i.note).join(' ');
}

// One repair round: edit whichever frames the issues name. The start frame
// goes first; an end frame that is DERIVED from it is then re-derived (it is
// an edit of the start frame, so it inherits the fix) instead of edited.
async function repairFrames({ projectId, beat, cut, issues, imageModel, comfyParams, repaired, shouldStop, onEvent, round = 1 }) {
  const { renderCutStartFrame } = await import('./cutStartFrames.js');
  let current = cut;
  const startFixes = issues.filter((i) => i.frame_to_fix === 'start');
  let endFixes = issues.filter((i) => i.frame_to_fix === 'end');
  const edit = async (frame, fixes) => {
    const otherId = idString(frame === 'start' ? current.end_frame?.image_id : current.start_frame?.image_id);
    onEvent?.(`repairing the ${frame} frame: ${summarize(fixes)}`);
    const r = await renderCutStartFrame({
      projectId,
      cut: current,
      beat,
      frame,
      // With no model asked for, the one that made the frame edits it.
      imageModel: imageModel || current[`${frame}_frame`]?.model || null,
      comfyParams,
      mode: 'edit',
      editPrompt: composeRepairPrompt({ frame, fixes, withOtherFrame: Boolean(otherId) }),
      editReferenceImageIds: otherId ? [otherId] : [],
      keepUndo: repaired.has(frame),
    });
    repaired.add(frame);
    current = r.cut || (await getVideoPrompt(projectId, String(cut._id))) || current;
  };
  // An end frame that is BUILT from the start frame — a held camera's edit, a
  // sliding camera's slid canvas — is rebuilt rather than patched: after the
  // start frame was repaired, and when the end frame's own fault is the camera
  // (a patch edit is told to keep the camera, so it cannot fix that).
  const builtFromStart = (c) => Boolean(c.end_frame?.derive || panDirectionForCut(c));
  // How the end frame is rebuilt depends on how it is built: a sliding camera
  // gets a new master plate, a held camera is derived again, any other move is
  // one edit of the start frame ('from_start') instead of a fresh still.
  const rebuildEnd = async (why, guidance = '') => {
    onEvent?.(why);
    const how = panDirectionForCut(current) ? { slideMethod: 'remaster' } : current.end_frame?.derive ? {} : { endMethod: 'from_start' };
    const r = await renderCutStartFrame({ projectId, cut: current, beat, frame: 'end', imageModel: imageModel || current.end_frame?.model || null, comfyParams, keepUndo: repaired.has('end'), slideGuidance: guidance, ...how });
    repaired.add('end');
    current = r.cut || current;
    endFixes = [];
  };
  if (!startFixes.length && endFixes.some((i) => i.kind === 'camera') && panDirectionForCut(current) && current.start_frame?.image_id) {
    const cameraFixes = endFixes.filter((i) => i.kind === 'camera');
    await rebuildEnd(`rebuilding the end frame from the start frame: ${summarize(cameraFixes)}`, cameraFixes.map((i) => plain(i.fix_instruction)).filter(Boolean).join(' '));
    return current;
  }
  if (startFixes.length) {
    await edit('start', startFixes);
    if (builtFromStart(current) && !shouldStop?.()) {
      onEvent?.('re-deriving the end frame from the repaired start frame');
      const r = await renderCutStartFrame({ projectId, cut: current, beat, frame: 'end', imageModel: imageModel || current.end_frame?.model || null, comfyParams, keepUndo: repaired.has('end') });
      repaired.add('end');
      current = r.cut || current;
      endFixes = [];
    }
  }
  // A blocking fault on the end frame that patch edits did not clear — or a
  // crowd of different people, which no patch can clear — rebuilds the end
  // frame from the start frame, with the checker's corrections as its guide.
  const blockingEnd = endFixes.filter((i) => i.severity === 'blocking');
  if (blockingEnd.length && current.start_frame?.image_id && !shouldStop?.()
    && (round > PATCH_ROUNDS_BEFORE_REBUILD || blockingEnd.some((i) => i.kind === 'crowd'))) {
    await rebuildEnd(`rebuilding the end frame from the start frame: ${summarize(blockingEnd)}`, endFixes.map((i) => plain(i.fix_instruction)).filter(Boolean).join(' '));
  }
  if (endFixes.length && !shouldStop?.()) await edit('end', endFixes);
  return current;
}

// True when every issue is something MISSING that the check before did not
// report: the last repair edit lost it.
function repairCausedLosses(verdict, previous) {
  if (!previous || !verdict?.issues?.length) return false;
  const before = new Set(previous.issues.map((i) => i.kind));
  return verdict.issues.every((i) => MISSING_KINDS.includes(i.kind) && !before.has(i.kind));
}

export function blockingCount(issues) {
  return (issues || []).filter((i) => i.severity === 'blocking').length;
}

// Check the pair and, when asked, repair it: check → repair → check, at most
// `maxRounds` repair rounds (`maxBlockingRounds` while a blocking issue remains). CALLER HOLDS THE BEAT LOCK. Saves the verdict on
// the cut and returns { cut, frame_check, repaired } — `repaired` is true when
// a repair turned a failing pair into a passing one. Never throws for a
// failed repair: the last verdict stands.
export async function reconcileCutFrames({
  projectId,
  beat,
  cut,
  imageModel = null,
  comfyParams = null,
  repair = true,
  maxRounds = MAX_REPAIR_ROUNDS,
  maxBlockingRounds = null,
  shouldStop = null,
  onEvent = null,
}) {
  if (!frameCheckEnabled()) {
    return { cut, frame_check: cut?.frame_check || null, repaired: false, reason: 'disabled' };
  }
  let current = cut;
  let rounds = 0;
  let verdict;
  let previous = null;
  let firstFailed = false;
  const repaired = new Set();
  const wardrobeLocks = await wardrobeLocksForCut(projectId, beat, cut);
  for (;;) {
    verdict = await checkCutFramePair({ cut: current, wardrobeLocks });
    if (verdict.status === 'fail' && rounds === 0) firstFailed = true;
    if (verdict.status !== 'fail' || !repair || shouldStop?.()) break;
    // A blocking fault earns more rounds than a minor one.
    const cap = blockingCount(verdict.issues) ? Math.max(maxRounds, maxBlockingRounds ?? blockingRepairRounds()) : maxRounds;
    if (rounds >= cap && !(rounds === cap && repairCausedLosses(verdict, previous))) break;
    previous = verdict;
    rounds += 1;
    try {
      current = await repairFrames({ projectId, beat, cut: current, issues: verdict.issues, imageModel, comfyParams, repaired, shouldStop, onEvent, round: rounds });
    } catch (e) {
      logger.warn(`cut frame check: repair round ${rounds} failed for cut ${cut?._id}: ${e?.message || e}`);
      onEvent?.(`repair failed: ${e?.message || e}`);
      current = (await getVideoPrompt(projectId, String(cut._id))) || current;
      break;
    }
  }
  const frameCheck = {
    status: verdict.status,
    issues: verdict.issues,
    blocking: blockingCount(verdict.issues),
    rounds,
    checked_at: new Date(),
    start_image_id: current.start_frame?.image_id || null,
    end_image_id: current.end_frame?.image_id || null,
  };
  let updated = current;
  try {
    const { updateVideoPromptScalarsViaGateway } = await import('./gateway.js');
    updated = await updateVideoPromptScalarsViaGateway({ projectId, promptId: String(cut._id), patch: { frame_check: frameCheck } });
  } catch (e) {
    logger.warn(`cut frame check: saving the verdict for cut ${cut?._id} failed: ${e?.message || e}`);
  }
  return { cut: updated, frame_check: updated?.frame_check || frameCheck, repaired: firstFailed && verdict.status === 'pass', reason: verdict.reason || null };
}

// Is the saved verdict about the two images the cut has now?
export function frameCheckIsCurrent(cut) {
  const c = cut?.frame_check;
  if (!c || !cut?.start_frame?.image_id || !cut?.end_frame?.image_id) return false;
  return idString(c.start_image_id) === idString(cut.start_frame.image_id) && idString(c.end_image_id) === idString(cut.end_frame.image_id);
}
