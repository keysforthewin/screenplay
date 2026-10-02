// src/web/panEndFrame.js
// The END frame of a pan, tilt, sideways truck/track or crane, made FROM the
// rendered start frame.
//
// These moves slide the picture: the last frame is the first frame shifted
// sideways (or up/down) with new picture revealed along one edge. A fresh
// still from the end prompt cannot hold that — it rebuilds the place from
// whatever vantage point the model likes (the lot seen from the far side of
// the building; five teenagers at a kerb becoming two different ones against a
// different wall). So the end frame is built in up to two attempts
// (cutStartFrames.js#renderSlidEndFrame):
//   1. the start frame's own pixels slid across the canvas, the revealed band
//      flat grey, and an image-edit model fills the band (buildShiftedCanvas +
//      composePanFillPrompt). Direction and distance are exact and the people
//      who stay in view are the same pixels. But about half the time the model
//      paints the band as a SECOND picture and the two meet along a hard line
//      (detectPanSeam) — measured 2026-10-01 on nano-banana-2 and
//      nano-banana-pro, at half a frame and at a third alike; a blurred fill,
//      a shorter instruction and a two-image "layout" variant did not help.
//   2. then a plain edit of the start frame, "the camera has panned left by …"
//      (composePanEndPrompt): never seams, but the model chooses the distance
//      and slid the wrong way once in three trials.
// The pixel check misses a soft or partial seam; the pair check
// (cutFrameCheck.js) is the backstop — it reports a wrong vantage point or a
// visible join as a `camera` issue, and that end frame is rebuilt by attempt 2.
//
// The two stills must OVERLAP (MAX_PAN_STILL_SHIFT): the shared part is the
// anchor, and a first-last-frame video model has nothing to interpolate
// through between two stills that share nothing. A truck's flat slide ignores
// parallax; for the half-frame moves this is limited to, that reads as a slow
// sideways drift, which is the intent. A forward track, push or pull has no
// slide direction and keeps the reference path.

import sharp from 'sharp';
import { stripMarkdown } from '../util/markdown.js';

export const PAN_MOVES = Object.freeze(['pan', 'tilt', 'truck', 'track', 'crane']);
const VERTICAL_MOVES = ['tilt', 'crane'];
export const PAN_DIRECTIONS = Object.freeze(['left', 'right', 'up', 'down']);
// The most of the frame a still pair may travel: at least half of the start
// frame is still in the end frame.
export const MAX_PAN_STILL_SHIFT = 0.5;
const MIN_PAN_STILL_SHIFT = 0.15;
const DEFAULT_PAN_STILL_SHIFT = 0.5;

function plain(v) {
  return stripMarkdown(typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
}

export function isPanMove(cut) {
  return PAN_MOVES.includes(cut?.camera?.movement);
}

function horizontalFrom(text) {
  const t = String(text || '').toLowerCase();
  const span = t.match(/\b(right|left)[\s-]+to[\s-]+(left|right)\b/);
  if (span && span[1] !== span[2]) return span[2];
  const verb = t.match(/\b(?:pan|truck|track|dolly|dollie)(?:s|ning|ing|ned|ed)?\s+(?:slowly\s+|steadily\s+|gently\s+)?(?:to\s+the\s+|to\s+|toward\s+the\s+|towards\s+the\s+)?(left|right)\b/);
  if (verb) return verb[1];
  const drift = t.match(/\b(?:moving|sliding|sweeping|travelling|traveling|turning)\s+(left|right)\b/);
  return drift ? drift[1] : null;
}

function verticalFrom(text) {
  const t = String(text || '').toLowerCase();
  const verb = t.match(/\b(?:tilt|crane|cran|descend|ris)(?:s|ing|ed|es)?\s+(?:slowly\s+|steadily\s+|gently\s+)?(up|down)\b/);
  if (verb) return verb[1];
  if (/\b(top[\s-]+to[\s-]+bottom|downward|downwards)\b/.test(t)) return 'down';
  if (/\b(bottom[\s-]+to[\s-]+top|upward|upwards)\b/.test(t)) return 'up';
  const drift = t.match(/\b(?:moving|sliding|travelling|traveling)\s+(up|down)\b/);
  if (drift) return drift[1];
  const fromTo = t.match(/\bfrom\b[^.;]*?\b(up|down)\s+to\b/);
  return fromTo ? fromTo[1] : null;
}

// Which way the frame travels: 'left' | 'right' for a pan, truck or track,
// 'up' | 'down' for a tilt or crane; null when the cut is none of these or
// does not say (a track forward through a door). The planner's
// camera.travel_direction wins; older cuts are read from the travel cell and
// then the block ("right to left", "panning left", "tilting down").
export function panDirectionForCut(cut) {
  if (!isPanMove(cut)) return null;
  const cam = cut.camera || {};
  const vertical = VERTICAL_MOVES.includes(cam.movement);
  const allowed = vertical ? ['up', 'down'] : ['left', 'right'];
  if (allowed.includes(cam.travel_direction)) return cam.travel_direction;
  const read = vertical ? verticalFrom : horizontalFrom;
  return read(plain(cam.travel)) || read(plain(cut.prompt)) || read(plain(cam.motivation)) || null;
}

// How far the still pair travels, as a fraction of the frame.
export function panShiftFraction(cut) {
  const n = Number(cut?.camera?.travel_widths);
  const f = Number.isFinite(n) && n > 0 ? n : DEFAULT_PAN_STILL_SHIFT;
  return Math.min(MAX_PAN_STILL_SHIFT, Math.max(MIN_PAN_STILL_SHIFT, f));
}

// Where the start frame's picture slides to when the camera turns `direction`.
export function slideSideFor(direction) {
  return { left: 'right', right: 'left', up: 'bottom', down: 'top' }[direction] || null;
}

// How the move is said to the image model.
function moveWords(movement, direction) {
  if (movement === 'truck' || movement === 'track') {
    return { did: `travelled sideways to the ${direction}, parallel to what it is looking at, without turning`, short: `moved ${direction}` };
  }
  if (movement === 'crane') {
    return { did: direction === 'up' ? 'risen straight up without turning' : 'descended straight down without turning', short: direction === 'up' ? 'risen' : 'descended' };
  }
  const verb = movement === 'tilt' || direction === 'up' || direction === 'down' ? 'tilted' : 'panned';
  return { did: `turned on its spot — ${verb} ${direction}`, short: `${verb} ${direction}` };
}

function amountWords(fraction, axis) {
  const pct = Math.round(fraction * 20) * 5;
  return `about ${pct}% of the frame's ${axis}`;
}

// The edit instruction. Input 1 is the rendered START frame; any further
// inputs are set artwork, consulted for what the revealed part of the place is
// built of and never for their camera. `references`: [{ label }].
// `guidance`: where the landmarks end up, in words — the pair check's own fix
// instruction when this is a rebuild. It outranks the end prompt, which on
// older plans was written for a longer move and drags the model to a new spot.
export function composePanEndPrompt({ direction, fraction, endPrompt, travel = '', movement = 'pan', references = [], guidance = '' }) {
  if (!PAN_DIRECTIONS.includes(direction)) throw new Error(`unknown pan direction: ${direction}`);
  const tilt = direction === 'up' || direction === 'down';
  const slide = slideSideFor(direction); // where the old picture goes
  const reveal = tilt ? (direction === 'up' ? 'top' : 'bottom') : direction; // where new picture appears
  const move = moveWords(movement, direction);
  const f = Math.min(MAX_PAN_STILL_SHIFT, Math.max(MIN_PAN_STILL_SHIFT, Number(fraction) || DEFAULT_PAN_STILL_SHIFT));
  const amount = amountWords(f, tilt ? 'height' : 'width');
  const slideWord = tilt ? (slide === 'bottom' ? 'DOWN' : 'UP') : slide.toUpperCase();
  const refs = (Array.isArray(references) ? references : []).map((r, i) => {
    const name = String(r?.label || '').trim() || 'the place';
    return `Image ${i + 2} shows ${name} from a different camera: use it only for what the newly revealed part of the place is built of — architecture, materials, colours. Never its viewpoint or composition.`;
  });
  return [
    `The first image is the opening frame of a film shot. Produce the closing frame of the same shot, a few seconds later: the same camera, at the same distance with the same lens, has only ${move.did}, by ${amount}.`,
    `So everything in the picture slides ${slideWord} by ${amount}: what is at the ${reveal} edge of the opening frame ends up well inside the new frame, and what is along its ${slide} edge slides out past the ${slide} edge, partly or wholly. It is the same place seen by the same camera — the same buildings, vehicles, objects and people in the same positions, the same sky, light, colour and grain. Nothing is moved, rebuilt, restaged, removed or seen from another side, and the camera does not come closer, pull back or swing round.`,
    `The ${reveal} part of the new frame is what the move brings into view; paint it as the continuation of the same place in the same perspective.`,
    ...(refs.length ? [refs.join('\n')] : []),
    ...(plain(guidance) ? [`Where things end up: ${plain(guidance)}`] : plain(travel) ? [`The move: ${plain(travel)}`] : []),
    'What the closing frame shows — use this ONLY for what comes into view along the leading edge and for anything the shot has changed by its end. It may describe a longer move than this one and name a framing this frame has not reached: where it disagrees with the opening frame about how far the camera has moved, the angle the place is seen from or where something stands, the opening frame and the move described above win:',
    plain(endPrompt),
  ].join('\n\n');
}

const FILL = { r: 128, g: 128, b: 128 };
// A seam: a brightness step of SEAM_STEP (of 255) along SEAM_COVERAGE of a line.
const SEAM_STEP = 5;
// Measured on nano-banana-2 output: seams 0.5–0.9, clean stills up to 0.31.
const SEAM_COVERAGE = 0.4;
// …or one unbroken stretch this long (gaps of a few pixels allowed): seams
// 0.19–0.38, clean stills up to 0.17.
const SEAM_RUN = 0.195;
const SEAM_GAP = 6;

// The start frame slid across its own canvas: same size, the surviving part
// against the edge the camera turned AWAY from, the revealed band flat grey.
// → { buffer (PNG), contentType, width, height, shiftPx, bandPercent, bandSide }
export async function buildShiftedCanvas(startBuffer, direction, fraction) {
  if (!PAN_DIRECTIONS.includes(direction)) throw new Error(`unknown pan direction: ${direction}`);
  const upright = await sharp(startBuffer).rotate().png().toBuffer();
  const { width, height } = await sharp(upright).metadata();
  const horizontal = direction === 'left' || direction === 'right';
  const span = horizontal ? width : height;
  const f = Math.min(MAX_PAN_STILL_SHIFT, Math.max(MIN_PAN_STILL_SHIFT, Number(fraction) || DEFAULT_PAN_STILL_SHIFT));
  const shiftPx = Math.min(span - 1, Math.max(1, Math.round(span * f)));
  const kept = span - shiftPx;
  // Panning left keeps the LEFT part of the start frame and shows it at the
  // RIGHT of the new frame; tilting up keeps the top and shows it at the bottom.
  const region = {
    left: { left: 0, top: 0, width: kept, height },
    right: { left: shiftPx, top: 0, width: kept, height },
    up: { left: 0, top: 0, width, height: kept },
    down: { left: 0, top: shiftPx, width, height: kept },
  }[direction];
  const at = {
    left: { left: shiftPx, top: 0 },
    right: { left: 0, top: 0 },
    up: { left: 0, top: shiftPx },
    down: { left: 0, top: 0 },
  }[direction];
  const piece = await sharp(upright).extract(region).toBuffer();
  const buffer = await sharp({ create: { width, height, channels: 3, background: FILL } })
    .composite([{ input: piece, ...at }])
    .png()
    .toBuffer();
  return {
    buffer,
    contentType: 'image/png',
    width,
    height,
    shiftPx,
    bandPercent: Math.round((shiftPx / span) * 100),
    bandSide: horizontal ? direction : direction === 'up' ? 'top' : 'bottom',
  };
}

// The instruction that goes with the shifted canvas.
export function composePanFillPrompt({ direction, bandPercent, endPrompt, movement = 'pan' }) {
  const tilt = direction === 'up' || direction === 'down';
  const band = tilt ? (direction === 'up' ? 'top' : 'bottom') : direction;
  const move = moveWords(movement, direction);
  return [
    `This image is a film frame in preparation. The camera has ${move.short}, so the picture has already been slid across the canvas: the flat grey band along the ${band} (about ${bandPercent}% of the image) is empty canvas, the rest is the photograph.`,
    `Fill the grey band so the image is ONE continuous photograph, as if the lens had simply been wider on that side: every line that reaches the band — the horizon, the ground and its markings, walls, rooflines, kerbs, rows of things, the sky gradient — carries straight on across it in the same perspective, scale, light, colour and grain. No visible boundary, seam, split or change of sky, and no grey left anywhere.`,
    'The place in the rest of the image stays where it is: the same buildings, parked vehicles, fixtures and ground in the same positions, seen by the same camera at the same distance, height and lens. Do not reframe, zoom, or move the camera further. Only people and things the description below says have moved or changed are repainted where it puts them.',
    'What the finished frame shows — use it for what the band contains and for where the people are at this moment. Where it disagrees with the photograph about where a fixed thing stands or how far the camera has moved, the photograph wins:',
    plain(endPrompt),
  ].join('\n\n');
}

// Did the model paint the band as a SECOND picture? Then there is a hard line
// across the whole frame where the two meet — not always where the band ended
// (the model sometimes slides the picture further itself). A seam is a pair of
// neighbouring pixel columns (rows, for a vertical move) that differ sharply
// along much of their length, or along one long unbroken stretch; a building
// corner or a pole does neither. Best effort: a blended seam passes.
// → { seam, at (0–1 across the frame), coverage, run }
export async function detectPanSeam(buffer, direction) {
  const horizontal = direction === 'left' || direction === 'right';
  // Full resolution: a seam is one pixel wide, and scaling down smears it away.
  const { data, info } = await sharp(buffer).rotate().resize({ width: 1600, withoutEnlargement: true }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const span = horizontal ? W : H;
  const across = horizontal ? H : W;
  const at = (i, j) => (horizontal ? data[j * W + i] : data[i * W + j]);
  let best = { coverage: 0, run: 0, at: 0, score: 0 };
  for (let i = Math.max(2, Math.round(span * 0.08)); i < Math.min(span - 1, Math.round(span * 0.92)); i++) {
    let sharpRows = 0;
    let run = 0;
    let gap = 0;
    let longest = 0;
    for (let j = 0; j < across; j++) {
      // A step at this line that is not there one line to either side.
      const here = Math.abs(at(i, j) - at(i - 1, j));
      const beside = Math.max(Math.abs(at(i - 1, j) - at(i - 2, j)), Math.abs(at(i + 1, j) - at(i, j)));
      if (here >= SEAM_STEP && here >= beside * 2) {
        sharpRows += 1;
        run += 1;
        gap = 0;
        if (run > longest) longest = run;
      } else if (++gap > SEAM_GAP) {
        run = 0;
      }
    }
    const coverage = sharpRows / across;
    const runShare = longest / across;
    const score = Math.max(coverage / SEAM_COVERAGE, runShare / SEAM_RUN);
    if (score > best.score) best = { coverage, run: runShare, at: i / span, score };
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  return { seam: best.score >= 1, at: r2(best.at), coverage: r2(best.coverage), run: r2(best.run) };
}

// ─── The master plate ───────────────────────────────────────────────────────
// The method that holds (2026-10-01): ONE wider picture of the place — the
// start frame extended in the direction of the move — and BOTH frames cropped
// from it. A pan is then an exact crop: nothing to seam, nothing to re-invent,
// the same pixels for everything the two frames share. The model reframes a
// little when it widens the picture, so the start frame is replaced by its
// crop too (Undo keeps the original). When people travel WITH the camera (a
// pan that follows a walking family), a pure crop would leave them standing
// where the shot began — so they are moved inside the master first (one more
// edit of the master alone; attaching the start frame as a "who they are"
// reference made the model copy its framing, which is the fault this fixes),
// and the end frame is cropped from that. The slid canvas and the plain edit
// above remain the fallback for models that cannot render another aspect.

const FRAME_ASPECT = 16 / 9;
// Wider (or taller) than the frame by about a third of it: the travel of the
// still pair. 21:9 → 0.31 of a frame-width; 4:3 → 0.33 of a frame-height.
export const MASTER_ASPECTS = Object.freeze({ horizontal: '21:9', vertical: '4:3' });
export const MASTER_RESOLUTION = '2K';
const STORED_FRAME_WIDTH = 1920;

function isHorizontal(direction) {
  return direction === 'left' || direction === 'right';
}

export function masterAspectFor(direction) {
  return isHorizontal(direction) ? MASTER_ASPECTS.horizontal : MASTER_ASPECTS.vertical;
}

// Which part of the master each frame is: the shot OPENS on the part the
// camera moves away from and CLOSES on the part it moves toward.
function masterPart(direction, which) {
  const toward = { left: 'left', right: 'right', up: 'top', down: 'bottom' }[direction];
  const away = { left: 'right', right: 'left', up: 'bottom', down: 'top' }[direction];
  return which === 'end' ? toward : away;
}

// The 16:9 frame at one end of the master. Throws when the master is not
// wider (taller) than a frame by at least a tenth of it.
// → { buffer (PNG), contentType, width, height, travel (share of the frame) }
export async function cropFromMaster(masterBuffer, direction, which) {
  if (!PAN_DIRECTIONS.includes(direction)) throw new Error(`unknown pan direction: ${direction}`);
  const upright = await sharp(masterBuffer).rotate().png().toBuffer();
  const { width, height } = await sharp(upright).metadata();
  const part = masterPart(direction, which);
  let region;
  let travel;
  if (isHorizontal(direction)) {
    const w = Math.min(width, Math.round(height * FRAME_ASPECT));
    travel = (width - w) / w;
    region = { left: part === 'left' ? 0 : width - w, top: 0, width: w, height };
  } else {
    const h = Math.min(height, Math.round(width / FRAME_ASPECT));
    travel = (height - h) / h;
    region = { left: 0, top: part === 'top' ? 0 : height - h, width, height: h };
  }
  if (travel < 0.1) throw new Error(`the master plate (${width}x${height}) is not ${isHorizontal(direction) ? 'wider' : 'taller'} than a frame`);
  const out = await sharp(upright).extract(region).resize({ width: STORED_FRAME_WIDTH, withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
  return { buffer: out.data, contentType: 'image/png', width: out.info.width, height: out.info.height, travel: Math.round(travel * 100) / 100 };
}

// Input: the rendered start frame. Output: the master plate.
export function composeMasterPrompt({ direction, movement = 'pan', endPrompt = '' }) {
  const start = masterPart(direction, 'start');
  const toward = masterPart(direction, 'end');
  const dim = isHorizontal(direction) ? 'wider' : 'taller';
  return [
    `Extend this photograph into a ${dim} frame. It is the opening frame of a film shot whose camera then has ${moveWords(movement, direction).short}; the ${dim} frame is the whole view the shot covers.`,
    `The picture you are given is the ${start.toUpperCase()} part of the ${dim} frame and stays as it is: every person, vehicle, object, the buildings, the ground, the sky, the light and the colour, each where it is and as it looks, seen by the same camera from the same position, height and lens.`,
    `Paint the new area at the ${toward}: the same place carrying on in the same perspective — the ground and its markings, walls, rooflines, kerbs, rows of things and the sky continue straight across. One continuous photograph: no border, no seam, no second picture, no repeated copy of anything already in the picture.`,
    `What the camera finds at the ${toward} — use this for what the new area contains (it describes the frame the shot closes on; ignore where it puts people who are already in the picture, they stay where they are):`,
    plain(endPrompt),
  ].join('\n\n');
}

// Input: the master plate. Output: the same plate with the people where they
// are when the shot closes. `guidance`: the pair check's note, on a rebuild.
export function composeMasterMovePrompt({ direction, movement = 'pan', endPrompt = '', guidance = '' }) {
  const start = masterPart(direction, 'start');
  const toward = masterPart(direction, 'end');
  const axis = isHorizontal(direction) ? 'across' : 'down';
  return [
    `This image is the master plate of a film shot in which the camera has ${moveWords(movement, direction).short}: the shot opens on the ${start.toUpperCase()} part of the plate and closes on the ${toward.toUpperCase()} part. It shows the people where they are when the shot OPENS.`,
    'Produce the same plate at the moment the shot CLOSES. Keep it exactly as it is — the same framing, buildings, vehicles, ground, markings, objects, light and colour; nothing in the place is moved, added or removed — except the people, who have moved while the camera went with them. Move each person to where the description below puts them: take them out of where they stood, restore the ground and background there, and paint them in their new place with the same faces, hair, build, clothing and size, in the pose the description gives, lit by the light of the spot they now stand in. ',
    `How far: the camera went WITH the people who are travelling (walking, running, riding), so each of them is about as far ${axis} the closing frame as they were ${axis} the opening frame. On this plate that is a move of about a QUARTER of the plate's ${isHorizontal(direction) ? 'width' : 'height'} toward the ${toward} — several strides of real ground, never half a step — unless the description below plainly puts them somewhere else. People who are sitting, leaning or standing in one place have not moved at all.`,
    `The description is of the closing frame, which is the ${toward.toUpperCase()} three quarters of this plate. Its positions are positions in THAT frame: "centre" is about ${toward === 'left' || toward === 'top' ? 'three eighths' : 'five eighths'} of the way ${axis} the plate, and its ${start} edge is about ${toward === 'left' || toward === 'top' ? 'three quarters' : 'one quarter'} of the way ${axis}. A person it does not mention has left the frame.`,
    ...(plain(guidance) ? [`A first attempt got this wrong: ${plain(guidance)}`] : []),
    'The closing frame:',
    plain(endPrompt),
  ].join('\n\n');
}

// People who travel with the camera have to be moved inside the master.
export function cutHasPeopleToPlace(cut) {
  return Array.isArray(cut?.in_frame) && cut.in_frame.length > 0;
}
