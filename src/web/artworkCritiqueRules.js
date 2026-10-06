// Pure half of the beat ARTWORK critique: the three prompts, their JSON output
// schemas, the normalizers that turn a model answer into stored rows, and the
// coverage arithmetic. No I/O here — src/web/artworkCritique.js owns the calls.
//
// Pass A (requirements): what pictures must exist for this beat, per subject.
// Phase 1 (match, TEXT): every artwork's description against the requirements
//          → which pieces answer which requirement. This alone is COVERAGE.
// Phase 2 (review, VISION): the matched pieces are looked at and scored on a
//          rubric (REVIEW_CRITERIA); the score is derived in code and the
//          reviewer says keep / edit / regenerate (cached per image).
// Pass C (proposals): a generation prompt per requirement nothing answers, or
//          whose best piece the reviewer wants regenerated.

import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { stripMarkdown } from '../util/markdown.js';
import { STATIC_PLATE_CONSTRAINTS } from './beatSheetPlanner.js';
import { CHARACTER_SHEET_OUTPUT_RULES, buildSubjectHandle } from './characterSheetShots.js';
import { NO_TEXT_RULES } from './promptConstraints.js';
import { WARDROBE_LINE_RE, wardrobeImageId, wardrobeLine, wardrobeText } from './wardrobe.js';

export const AUDIT_BATCH_SIZE = 8;
// Phase 1 reads the library this many descriptions per call, so a coverage
// check can say which pictures it is on and how many are done.
export const MATCH_BATCH_SIZE = 8;
// How many of a requirement's description matches the reviewer looks at
// (best first; a piece the reviewer rejected makes room for the next).
export const REVIEW_PER_REQUIREMENT = 2;
// A reviewed piece at or above this is good enough to render frames from.
export const KEEP_SCORE = 9;
// Renders made for one requirement (its first, then regenerations of a piece
// the reviewer turned down) before the requirement is left to a human.
export const MAX_REGENERATIONS = 3;
// Part of every review fingerprint: bump to re-review everything on file.
export const REVIEW_RUBRIC_VERSION = 'rubric-1';
export const REVIEW_ACTIONS = ['keep', 'edit', 'regenerate'];
// Nothing is capped: every subject on the roster, every requirement the beat
// imposes and every prop plate is kept and checked (the user's rule,
// 2026-10-05 — a cap of 12 per subject silently dropped props and views).
// The planner drafts the missing pictures this many requirements per call.
export const PROPOSAL_BATCH_SIZE = 8;
export const MAX_PROPOSAL_REFERENCES = 12;

export const SET_CATEGORIES = ['view', 'sub_location', 'vehicle', 'building', 'prop', 'light'];
export const CHARACTER_CATEGORIES = ['costume', 'expression', 'pose', 'action', 'held_prop'];
export const REQUIREMENT_CATEGORIES = [...SET_CATEGORIES, ...CHARACTER_CATEGORIES];
export const COVERAGE_STATUSES = ['covered', 'partial', 'missing'];
export const FIT_STATUSES = ['covered', 'partial'];
export const ARTWORK_ISSUE_KINDS = ['wardrobe', 'identity', 'expression', 'pose', 'prop', 'layout', 'light', 'time_of_day', 'angle', 'text_in_image', 'style', 'other'];

function plain(s, max = Infinity) {
  const v = stripMarkdown(typeof s === 'string' ? s : '').replace(/\s+/g, ' ').trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

function clampInt(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return null;
  return Math.min(10, Math.max(1, v));
}

// ───────────────────────────── The review rubric ─────────────────────────────
// What a reviewed artwork is scored on. Each criterion is scored 1–10 against
// its written anchors; the artwork's score is the weighted mean, derived in
// code (deriveArtworkScore) — the reviewer never states an overall.
export const REVIEW_CRITERIA = [
  {
    key: 'requirement',
    label: 'Does the job',
    weight: 2,
    focus: 'Does the picture show what the requirement(s) it is matched to ask for — that view, costume, expression, pose, prop — at the angle and distance described?',
    anchors: {
      3: 'A different view, pose or expression; only the subject is the same.',
      6: 'The right picture in outline, but the angle, pose, expression or garment differs in a way a frame would show.',
      9: 'Exactly what the requirement describes; nothing a frame built on it would have to change.',
    },
  },
  {
    key: 'beat',
    label: 'Agrees with the beat',
    weight: 1.5,
    focus: 'Time of day, light, weather, season, the state of the place and the props the beat names — does anything in the picture contradict the writing?',
    anchors: {
      3: 'Contradicts the beat outright (daylight for a night scene, the wrong vehicle, a prop the beat depends on absent).',
      6: 'Right in the main, one visible detail the beat states is off or missing.',
      9: 'Every detail the beat states about this moment is in the picture.',
    },
  },
  {
    key: 'subject',
    label: 'True to the subject',
    weight: 1.5,
    focus: 'A character: the same face, hair, age and build as the subject card, and every garment of a LOCKED WARDROBE. A set: the same place — construction, layout, period — as its description.',
    anchors: {
      3: 'A different person or a different place; or the locked wardrobe replaced by another outfit.',
      6: 'Recognisably the subject, but the likeness, one garment, or a part of the construction differs.',
      9: 'Unmistakably this subject, wardrobe and construction as written.',
    },
  },
  {
    key: 'reference',
    label: 'Usable as a reference',
    weight: 1,
    focus: 'Can a frame be built from it? One clear subject, nothing in the way, no stray people in a set plate, no lettering or captions, not a collage or a sheet when a single still is needed.',
    anchors: {
      3: 'Cluttered, cropped through the subject, a multi-panel sheet, or carrying text an image model would copy.',
      6: 'Usable with care: a stray figure, a tight crop or a busy background a frame would inherit.',
      9: 'A clean single still of the subject that a frame can be rendered from as it is.',
    },
  },
  {
    key: 'technical',
    label: 'Technically clean',
    weight: 0.5,
    focus: 'Rendering faults: malformed hands or faces, melted geometry, garbled signage, smeared detail.',
    anchors: {
      3: 'Obvious faults a viewer would notice at once.',
      6: 'A fault on close inspection.',
      9: 'No visible faults.',
    },
  },
];
const REVIEW_CRITERION_KEYS = REVIEW_CRITERIA.map((c) => c.key);

function clampScore(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.round(Math.min(10, Math.max(1, v)) * 10) / 10;
}

// Reviewer criteria → stored rows [{key, score, note}], unknown keys dropped.
export function normalizeReviewCriteria(raw) {
  const seen = new Set();
  const rows = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    const key = String(c?.key || '');
    const score = clampInt(c?.score);
    if (!REVIEW_CRITERION_KEYS.includes(key) || seen.has(key) || score == null) continue;
    seen.add(key);
    rows.push({ key, score, note: plain(c?.note, 240) });
  }
  return rows;
}

// The artwork's score: the weighted mean of its criteria, one decimal. A
// picture that is the wrong picture cannot be carried by being clean: the
// score never exceeds its `requirement` criterion by more than 2.
export function deriveArtworkScore(criteria) {
  const rows = (criteria || []).filter((c) => Number.isFinite(c?.score));
  if (!rows.length) return null;
  let wsum = 0;
  let sum = 0;
  for (const c of rows) {
    const w = REVIEW_CRITERIA.find((d) => d.key === c.key)?.weight ?? 1;
    wsum += w;
    sum += w * c.score;
  }
  let score = sum / wsum;
  const job = rows.find((c) => c.key === 'requirement');
  if (job) score = Math.min(score, job.score + 2);
  return clampScore(score);
}

function rubricText() {
  return REVIEW_CRITERIA.map((c) => [
    `- ${c.key} (${c.label}, weight ${c.weight}): ${c.focus}`,
    ...Object.entries(c.anchors).map(([n, t]) => `    ${n} = ${t}`),
  ].join('\n')).join('\n');
}

export function subjectKey(kind, id) {
  return `${kind}:${String(id)}`;
}

// ───────────────────────────── Pass A: requirements ─────────────────────────────

export const REQUIREMENTS_SYSTEM_PROMPT = [
  'You are the production designer and the costume supervisor reading ONE screenplay beat to list every picture the art department must have on file BEFORE any frame of it is rendered. The pictures are reference artwork for the beat\'s SETS (places) and CHARACTERS (people) — the subjects are listed at the end of the message with their ids.',
  '',
  '# Sets',
  '- One requirement per distinct VIEW the beat actually stages: a slugline or mini-slug (BACK SEAT, AT THE WINDOW) names a sub-location; a vehicle, a building or a named set piece the action depends on is its own requirement; a camera direction the beat implies (from the doorway, from across the lot) is a view.',
  '- Time of day and light are a separate requirement only when the beat MOVES between two (dusk to night) — otherwise fold the light into the view\'s detail.',
  '- The fewest requirements that cover the beat. An element the beat only pans past or mentions in passing gets at most one modest requirement — never a wide + detail pair the beat does not dwell on. There is no target count; a short beat often needs 1–3.',
  '',
  '# Props',
  '- Every distinct physical OBJECT the action depends on — one a character handles, throws, kicks, catches, wears as a featured item or hands over, one the camera singles out in a close-up or an insert, or one that comes back later in the beat (a ball, a watch, a ticket, a tub of popcorn, a skateboard) — gets exactly ONE requirement of category prop: the PROP PLATE, a picture of the object ALONE that every frame showing it will copy it from. File it under the SET where the object first appears, never under a character. importance: essential.',
  '- A prop plate\'s summary is the object\'s plain name and nothing else, at most 5 words ("crocheted hacky sack", "black digital watch"). Its detail is the object itself as the beat describes it — shape, size, material, colours, pattern, wear — and never the place, the light, a pose or a moment of the action.',
  '- List the prop plate requirements FIRST, before any view of the set. Every object named in a character\'s held_prop requirement must also have its own prop plate requirement — a held_prop with no prop plate for the same object is an error.',
  '- Something built into the place — a marquee, a sign, a ticket window, a counter, a door — is not a prop: it is a building, a sub_location or a view.',
  '- Go through the beat object by object: a handled or featured object with no prop plate requirement is the most common omission. Set dressing nobody touches and the camera does not single out (parked cars, posters, seats) is NOT a prop — it belongs to a view.',
  '- A character\'s held_prop requirement (below) is a different picture — the PERSON holding the object — and is listed in addition to the object\'s prop plate, not instead of it.',
  '',
  '# Characters',
  '- costume: a character whose subject line carries a LOCKED WARDROBE gets exactly ONE costume requirement whose detail is that wardrobe text VERBATIM (quote: "wardrobe lock"), plus a further costume requirement ONLY for a garment the beat text explicitly adds, removes or changes (a jacket off, a torn sleeve). Never invent or paraphrase a locked wardrobe. Only a character with NO lock gets what the text says they wear — and if the text says nothing, one requirement for "the costume this beat implies" with the quote that implies it.',
  '- expression: every distinct facial expression the beat plays on this character (fear, fury, a held-back smile) — one requirement each, named in plain words.',
  '- pose / action: the positions and physical actions the beat stages (seated in the back seat, leaning on the counter, dragging a parent by the hand) — one requirement per distinct staging the camera will need.',
  '- held_prop: the character holding or handling an object on screen (the object alone is the set\'s prop plate — see Props).',
  '',
  '# Every requirement',
  '- subject_id: the exact id from the subject list. Never invent a subject; a place or person the beat names that is NOT in the list goes in unlinked_mentions instead.',
  '- summary: at most 12 words, a card label ("Rear bench from the sliding door", "Fury, close").',
  '- detail: what the picture must show — angle, distance, time of day, light, state of the place, the pose, the garment, the expression — concrete enough to brief an artist.',
  '- quote: VERBATIM text from the beat that calls for it.',
  '- importance: essential when a frame cannot be rendered correctly without this picture on file; useful otherwise.',
  '',
  'Return only the JSON object the schema describes.',
].join('\n');

export const REQUIREMENTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['requirements', 'unlinked_mentions'],
  properties: {
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['subject_id', 'subject_kind', 'category', 'summary', 'detail', 'quote', 'importance'],
        properties: {
          subject_id: { type: 'string', description: 'The subject id from the list' },
          subject_kind: { type: 'string', enum: ['set', 'character'] },
          category: { type: 'string', enum: REQUIREMENT_CATEGORIES },
          summary: { type: 'string', description: 'At most 12 words' },
          detail: { type: 'string' },
          quote: { type: 'string', description: 'Verbatim from the beat' },
          importance: { type: 'string', enum: ['essential', 'useful'] },
        },
      },
    },
    unlinked_mentions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'kind', 'quote'],
        properties: {
          name: { type: 'string' },
          kind: { type: 'string', enum: ['set', 'character'] },
          quote: { type: 'string' },
        },
      },
    },
  },
};

export function buildSubjectRoster(subjects, { beat = null } = {}) {
  const lines = (subjects || []).map((s) => {
    const lock = s.kind === 'character' ? wardrobeText(s.doc, beat) : '';
    return `- ${s.kind.toUpperCase()} "${plain(s.name)}" (id ${String(s.id)})${lock ? ` — LOCKED WARDROBE: ${lock}` : ''}`;
  });
  return ['# Subjects to audit (use these ids)', ...(lines.length ? lines : ['(none)'])].join('\n');
}

// → { requirements: [{id, subject_key, subject_id, subject_kind, category, summary, detail, quote, importance}], unlinked_mentions, warnings }
export function normalizeRequirements(raw, subjects) {
  const byId = new Map((subjects || []).map((s) => [String(s.id), s]));
  const counts = new Map();
  const warnings = [];
  const requirements = [];
  for (const r of Array.isArray(raw?.requirements) ? raw.requirements : []) {
    if (!r || typeof r !== 'object') continue;
    const subject = byId.get(String(r.subject_id || ''));
    if (!subject) {
      warnings.push(`requirement "${plain(r.summary, 60) || '?'}" named an unknown subject and was dropped`);
      continue;
    }
    const key = subjectKey(subject.kind, subject.id);
    const allowed = subject.kind === 'set' ? SET_CATEGORIES : CHARACTER_CATEGORIES;
    const category = allowed.includes(r.category) ? r.category : allowed[0];
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    requirements.push({
      id: `${key}:${n}`,
      subject_key: key,
      subject_id: String(subject.id),
      subject_kind: subject.kind,
      category,
      summary: plain(r.summary, 120) || `${category} ${n}`,
      detail: plain(r.detail, 600),
      quote: plain(r.quote, 300),
      importance: r.importance === 'essential' ? 'essential' : 'useful',
      status: 'missing',
      covered_by: [],
      note: '',
    });
  }
  const unlinked_mentions = (Array.isArray(raw?.unlinked_mentions) ? raw.unlinked_mentions : [])
    .filter((m) => m && plain(m.name))
    .map((m) => ({ name: plain(m.name, 80), kind: m.kind === 'character' ? 'character' : 'set', quote: plain(m.quote, 300) }))
    .slice(0, 20);
  return { requirements, unlinked_mentions, warnings };
}

// ───────────────────────────── Pass B: audit ─────────────────────────────
// One ARTWORK is the unit: the auditor says, for each attached image, which
// requirements it satisfies and how well it does. A subject's library is
// audited in batches of AUDIT_BATCH_SIZE images; an entry is cached on the
// critique and reused while the image and the requirements are the ones it
// was audited against (`audited_image_id` + `req_sig`). The status of every
// requirement is then DERIVED in code from the entries.

export const AUDIT_SYSTEM_PROMPT = [
  'You are the art director REVIEWING artwork from ONE subject\'s library against ONE screenplay beat. The artwork images are attached and numbered; the requirements the beat imposes on this subject follow them. Each artwork is listed with the requirements its DESCRIPTION suggested it answers — you are the check on that: LOOK at the image and say what it really shows. Judge every image on its own: other images in this message never change an image\'s verdict.',
  '',
  '# For EVERY attached artwork',
  '- fits: the requirements THIS image answers, judged from the picture. fit = covered when the image shows exactly that view / costume / expression / pose; partial when the subject is there and the picture is close but the angle, costume, expression, light or state differs from what the requirement describes — then `lacking` says, in one sentence, exactly what is missing or different. A requirement the image does not answer is LEFT OUT, even if its description suggested it. An image that answers nothing has an empty list.',
  '- criteria: score EVERY rubric criterion below from 1 to 10 for this image, against the requirements it fits (an image that fits nothing is scored against the subject alone, and its `requirement` criterion is 3 or below). Use the anchors; `note` is one short sentence of evidence from the picture.',
  '- issues: ONLY disagreements with THIS BEAT\'S WRITING — a wrong jacket, daylight where the beat is night, a smile where the beat says fury, a prop the beat names that is absent, lettering in the picture, a layout the beat contradicts. Never taste notes, never style preferences, never faults that do not touch this beat.',
  '- A character with a LOCKED WARDROBE (stated under the subject): every garment, colour and piece of footwear in the image is compared with that text — any difference is a `wardrobe` issue, whether or not the beat mentions clothes. The suggested_edit then names the locked garments.',
  '- action: what should happen to this image so a frame can be rendered from it.',
  '    keep = it does its job as it is (every criterion at 9 or above, or what is off does not matter to this beat).',
  '    edit = the picture is right in its composition and a LOCAL change fixes it: a garment, a colour, the light or time of day, a prop added or removed, an expression, a stray figure or lettering removed.',
  '    regenerate = an edit cannot get there: the wrong viewpoint or framing, the wrong pose or staging, a different person or place, a sheet or collage, or faults across the whole picture. A new image has to be made from a prompt and references.',
  '- suggested_edit: when action is edit — ONE imperative sentence an image-edit model could apply to THAT image alone ("Change the jacket to a worn brown leather bomber; keep everything else exactly as it is."). Empty otherwise.',
  '- regenerate_reason: when action is regenerate — one sentence on what the new picture must do that this one cannot be edited into. Empty otherwise.',
  '',
  '# Rubric',
  rubricText(),
  '',
  'Return only the JSON object the schema describes.',
].join('\n');

export const AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['artworks'],
  properties: {
    artworks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'fits', 'criteria', 'issues', 'action', 'suggested_edit', 'regenerate_reason'],
        properties: {
          index: { type: 'integer' },
          fits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['requirement_id', 'fit', 'lacking'],
              properties: {
                requirement_id: { type: 'string' },
                fit: { type: 'string', enum: FIT_STATUSES },
                lacking: { type: 'string' },
              },
            },
          },
          criteria: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['key', 'score', 'note'],
              properties: {
                key: { type: 'string', enum: REVIEW_CRITERION_KEYS },
                score: { type: 'integer', description: '1-10, against the anchors' },
                note: { type: 'string' },
              },
            },
          },
          issues: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'note'],
              properties: {
                kind: { type: 'string', enum: ARTWORK_ISSUE_KINDS },
                note: { type: 'string' },
              },
            },
          },
          action: { type: 'string', enum: REVIEW_ACTIONS },
          suggested_edit: { type: 'string' },
          regenerate_reason: { type: 'string' },
        },
      },
    },
  },
};

// `matched`: Map artwork id → requirement ids its description suggested.
export function buildAuditText({ beat, subject, subjectCard, requirements, artworks, matched = null }) {
  const suggested = (a) => {
    const ids = matched?.get(String(a._id)) || [];
    return ids.length ? ` [description suggests: ${ids.join(', ')}]` : '';
  };
  const lock = subject.kind === 'character' ? wardrobeText(subject.doc, beat) : '';
  const lines = [
    `# Beat #${beat?.order ?? '?'}: ${plain(beat?.name) || 'Untitled'}`,
    plain(beat?.desc, 600) || '',
    '',
    `# Subject: ${subject.kind.toUpperCase()} "${plain(subject.name)}"`,
    subjectCard || '',
    ...(lock ? [`LOCKED WARDROBE (every image must match these words): ${lock}`] : []),
    '',
    '# Artwork to audit (attached above, in this order)',
    ...(artworks.length
      ? artworks.map((a, i) => `Artwork ${i + 1} — "${plain(a.name, 80) || 'untitled'}"${suggested(a)}${a.description ? `: ${plain(a.description, 300)}` : ''}`)
      : ['(none)']),
    '',
    '# Requirements this beat imposes on the subject',
    ...requirements.map((r) => `${r.id} [${r.category}${r.importance === 'essential' ? ', essential' : ''}] ${r.summary} — ${r.detail}${r.quote ? ` (beat: "${r.quote}")` : ''}`),
    '',
    'For every artwork: which requirements it really fits, every rubric criterion scored, what disagrees with the writing, and keep / edit / regenerate.',
  ];
  return lines.join('\n');
}

// Fingerprint of what a subject's artwork is audited AGAINST: its
// requirements and (characters) the locked wardrobe. A cached entry is reused
// only while this is unchanged.
export function requirementsSignature(requirements, lock = '') {
  const rows = (requirements || []).map((r) => [r.id, r.category, r.summary, r.detail, r.importance]);
  return createHash('sha1').update(JSON.stringify([rows, String(lock || ''), REVIEW_RUBRIC_VERSION])).digest('hex');
}

// A stored entry still describes the artwork as it is now.
export function auditEntryIsCurrent(entry, artwork, reqSig) {
  return !!entry && !!entry.audited_image_id && entry.req_sig === reqSig
    && String(entry.audited_image_id) === String(artwork?.result_image_id || '');
}

// One audit answer (a batch of `artworks`) → stored entries
// [{artwork_id, result_image_id, name, score, criteria, fits, issues, action,
//   suggested_edit, regenerate_reason, audited_image_id, req_sig}]. The score
// is derived from the criteria; an answer with none (an old stub) keeps the
// score it states.
// An artwork the model did not answer for keeps `audited_image_id: null`, so
// the next run asks again instead of caching "fits nothing".
export function normalizeArtworkAudit(raw, { requirements, artworks, reqSig = '' }) {
  const reqIds = new Set((requirements || []).map((r) => r.id));
  const byIndex = new Map();
  for (const a of Array.isArray(raw?.artworks) ? raw.artworks : []) {
    if (!a || typeof a !== 'object') continue;
    const n = Number(a.index);
    if (Number.isInteger(n) && n >= 1 && n <= artworks.length && !byIndex.has(n)) byIndex.set(n, a);
  }
  return artworks.map((a, i) => {
    const v = byIndex.get(i + 1);
    const seen = new Set();
    const fits = (Array.isArray(v?.fits) ? v.fits : [])
      .filter((f) => f && reqIds.has(String(f.requirement_id)) && !seen.has(String(f.requirement_id)) && seen.add(String(f.requirement_id)))
      .map((f) => {
        const fit = f.fit === 'covered' ? 'covered' : 'partial';
        return { requirement_id: String(f.requirement_id), fit, lacking: fit === 'partial' ? plain(f.lacking, 300) : '' };
      });
    const issues = (Array.isArray(v?.issues) ? v.issues : [])
      .map((x) => ({ kind: ARTWORK_ISSUE_KINDS.includes(x?.kind) ? x.kind : 'other', note: plain(x?.note, 300) }))
      .filter((x) => x.note)
      .slice(0, 8);
    const criteria = normalizeReviewCriteria(v?.criteria);
    const score = v ? (criteria.length ? deriveArtworkScore(criteria) : clampInt(v.score)) : null;
    const flawed = issues.length > 0 || fits.some((f) => f.fit === 'partial');
    const edit = plain(v?.suggested_edit, 600);
    // The reviewer's call, held to what the answer supports: nothing wrong and
    // a keep-worthy score is a keep; an edit needs an instruction.
    let action = REVIEW_ACTIONS.includes(v?.action) ? v.action : (flawed && edit ? 'edit' : 'keep');
    if (action === 'edit' && !edit) action = flawed ? 'regenerate' : 'keep';
    if (action !== 'keep' && !flawed && (score ?? 0) >= KEEP_SCORE) action = 'keep';
    return {
      artwork_id: a._id,
      result_image_id: a.result_image_id,
      name: plain(a.name, 120),
      score,
      criteria,
      fits,
      issues,
      action: v ? action : null,
      suggested_edit: action === 'edit' ? edit : '',
      regenerate_reason: action === 'regenerate' ? plain(v?.regenerate_reason, 300) : '',
      audited_image_id: v ? a.result_image_id : null,
      req_sig: reqSig,
    };
  });
}

// The entries that answer a requirement, best first: a piece the reviewer has
// LOOKED at before one only its description vouches for, covered before
// partial, then the higher score.
export function entriesForRequirement(requirementId, entries) {
  const rows = [];
  for (const e of entries || []) {
    const fit = (e?.fits || []).find((f) => f.requirement_id === requirementId);
    if (fit) rows.push({ entry: e, fit });
  }
  const rank = (r) => (r.entry.audited_image_id ? 1000 : 0) + (r.fit.fit === 'covered' ? 100 : 0) + (r.entry.score ?? 0);
  return rows.sort((a, b) => rank(b) - rank(a));
}

// Requirement status from the audited entries: covered when some artwork
// covers it, partial when the closest one is only near, missing otherwise.
// `covered_by` lists the artworks at that level, best first; a partial
// requirement's note is what its closest artwork lacks.
export function deriveRequirementStatus(requirements, entries) {
  return (requirements || []).map((r) => {
    const rows = entriesForRequirement(r.id, entries);
    if (!rows.length) return { ...r, status: 'missing', covered_by: [], note: '' };
    const status = rows[0].fit.fit;
    const level = rows.filter((x) => x.fit.fit === status);
    return {
      ...r,
      status,
      covered_by: level.map((x) => new ObjectId(String(x.entry.artwork_id))),
      note: status === 'partial' ? rows[0].fit.lacking : '',
    };
  });
}

// 1–10 for the artwork the beat actually leans on: the mean score of every
// entry that answers a requirement. Null when nothing does.
export function subjectAccuracy(entries) {
  const scores = (entries || []).filter((e) => (e.fits || []).length && Number.isFinite(e.score)).map((e) => e.score);
  if (!scores.length) return null;
  return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
}

// What is on file, for the proposal planner and the subject card.
export function summarizeSubjectAudit({ requirements, entries, total }) {
  const count = (st) => (requirements || []).filter((r) => r.status === st).length;
  const matched = (entries || []).length;
  const reviewed = (entries || []).filter((e) => e.audited_image_id).length;
  const head = `${total} artwork${total === 1 ? '' : 's'} on file, ${matched} matched to this beat by description, ${reviewed} reviewed: `
    + `${count('covered')} requirement${count('covered') === 1 ? '' : 's'} covered, ${count('partial')} partly, ${count('missing')} missing.`;
  const flawed = (entries || []).filter((e) => (e.issues || []).length).length;
  return flawed ? `${head} ${flawed} image${flawed === 1 ? ' disagrees' : 's disagree'} with the writing.` : head;
}

// ───────────────────────────── Phase 1: match (text) ─────────────────────────────
// COVERAGE is decided here, without looking at a single image: one text call
// per subject reads EVERY artwork's name and description and says, for each
// requirement, which pieces answer it (best first) — plus groups of pieces
// that describe the same picture. The result is cached on the subject
// (`inventory`) while the requirements and the library read the same.

export const MATCH_SYSTEM_PROMPT = [
  'You are the art department\'s librarian. One subject (a set or a character) has an artwork library; each piece is listed with a number, its name and a description of what the picture shows. A screenplay beat imposes the listed requirements on this subject. For each requirement, say which pieces on file answer it — from the descriptions alone.',
  '',
  `- matches: for EVERY requirement, EVERY piece that answers it, best first — leave none out, and check each piece against each requirement. fit = covered when the description says the picture shows what the requirement asks for (that view, costume, expression, pose). fit = partial when it is CLOSE — the right place from a slightly different angle, the right person in nearly the right costume or pose — and could be edited into it; then \`lacking\` says in one sentence what differs. Be generous with partial: a piece left out is never looked at, and the picture would be made again. An empty list only when nothing on file is near.`,
  '- A [prop] requirement asks for a PROP PLATE: the object alone, whole and close, on a plain background. Only a piece marked [PROP PLATE] whose object is this one is covered. A picture of a place or a person in which the object merely appears — lying on the ground, in a hand, on a foot — does NOT answer it: leave it out of that requirement\'s matches altogether (it cannot be edited into a plate).',
  '- duplicate_groups: groups of two or more artwork numbers whose descriptions say they are the same picture (same view, same pose, same light). Only clear cases.',
  '',
  'Return only the JSON object the schema describes.',
].join('\n');

// One pass over the WHOLE library for duplicates: the match reads it in
// batches, and two copies of a picture rarely land in the same one.
export const DUPLICATES_SYSTEM_PROMPT = [
  'You are the art department\'s librarian, clearing out a library of reference pictures of one subject. Each piece is listed with a number, its name and a description of what the picture shows. Find the pieces that are the SAME picture as another: the same view or pose, from the same angle and distance, in the same light, showing the same things — one would never need both. Two pictures of the same place or person that differ in angle, framing, pose, expression, costume or time of day are NOT duplicates.',
  '',
  '- duplicate_groups: groups of two or more artwork numbers that are the same picture, the best-described one first. Only clear cases; when unsure, leave it out. No piece in two groups.',
  '',
  'Return only the JSON object the schema describes.',
].join('\n');

export const DUPLICATES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['duplicate_groups'],
  properties: { duplicate_groups: { type: 'array', items: { type: 'array', items: { type: 'integer' } } } },
};

export function buildDuplicatesText({ subject, artworks }) {
  return [
    `# Subject: ${subject.kind.toUpperCase()} "${plain(subject.name)}"`,
    '',
    `# Artwork library (${artworks.length} pieces)`,
    ...artworks.map((a, i) => `${i + 1}. ${a.prop ? `[PROP PLATE: ${plain(a.prop, 80)}] ` : ''}"${plain(a.name, 80) || 'untitled'}" — ${plain(a.description, 300) || '(no description)'}`),
  ].join('\n');
}

// → [[artwork id, …], …] — each id once, groups of 2+.
export function normalizeDuplicateGroups(raw, artworks) {
  const seen = new Set();
  const out = [];
  for (const g of Array.isArray(raw?.duplicate_groups) ? raw.duplicate_groups : []) {
    const ids = [];
    for (const i of Array.isArray(g) ? g : []) {
      const n = Number(i);
      const id = Number.isInteger(n) && n >= 1 && n <= artworks.length ? String(artworks[n - 1]._id) : null;
      if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
    }
    if (ids.length > 1) out.push(ids);
  }
  return out.slice(0, 40);
}

export const MATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['matches', 'duplicate_groups'],
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['requirement_id', 'artworks'],
        properties: {
          requirement_id: { type: 'string' },
          artworks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['index', 'fit', 'lacking'],
              properties: {
                index: { type: 'integer' },
                fit: { type: 'string', enum: FIT_STATUSES },
                lacking: { type: 'string' },
              },
            },
          },
        },
      },
    },
    duplicate_groups: { type: 'array', items: { type: 'array', items: { type: 'integer' } } },
  },
};

export function buildMatchText({ beat, subject, subjectCard, requirements, artworks }) {
  const lock = subject.kind === 'character' ? wardrobeText(subject.doc, beat) : '';
  return [
    `# Beat #${beat?.order ?? '?'}: ${plain(beat?.name) || 'Untitled'}`,
    plain(beat?.desc, 600) || '',
    '',
    `# Subject: ${subject.kind.toUpperCase()} "${plain(subject.name)}"`,
    subjectCard || '',
    ...(lock ? [`LOCKED WARDROBE: ${lock}`] : []),
    '',
    '# Requirements this beat imposes on the subject',
    ...requirements.map((r) => `${r.id} [${r.category}${r.importance === 'essential' ? ', essential' : ''}] ${r.summary} — ${r.detail}`),
    '',
    `# Artwork library (${artworks.length} pieces)`,
    ...artworks.map((a, i) => `${i + 1}. ${a.prop ? `[PROP PLATE: ${plain(a.prop, 80)}] ` : ''}"${plain(a.name, 80) || 'untitled'}" — ${plain(a.description, 300) || '(no description)'}`),
  ].join('\n');
}

// → { matches: [{requirement_id, artwork_id, fit, lacking}] (per requirement,
//     best first), duplicates: [[artwork id string]] }.
// Also reads the older shortlist shape ({candidates: [{requirement_id,
// artwork_indexes}]}) — those count as partial: worth a look, not vouched for.
export function normalizeMatches(raw, { requirements, artworks }) {
  const reqIds = new Set((requirements || []).map((r) => r.id));
  const at = (i) => {
    const n = Number(i);
    return Number.isInteger(n) && n >= 1 && n <= artworks.length ? String(artworks[n - 1]._id) : null;
  };
  const groups = [
    ...(Array.isArray(raw?.matches) ? raw.matches : []),
    ...(Array.isArray(raw?.candidates) ? raw.candidates : []).map((c) => ({
      requirement_id: c?.requirement_id,
      artworks: (Array.isArray(c?.artwork_indexes) ? c.artwork_indexes : []).map((index) => ({ index, fit: 'partial', lacking: '' })),
    })),
  ];
  const matches = [];
  const done = new Set();
  for (const g of groups) {
    const rid = String(g?.requirement_id || '');
    if (!reqIds.has(rid) || done.has(rid)) continue;
    done.add(rid);
    const seen = new Set();
    for (const m of Array.isArray(g.artworks) ? g.artworks : []) {
      const id = at(m?.index);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const fit = m.fit === 'covered' ? 'covered' : 'partial';
      matches.push({ requirement_id: rid, artwork_id: id, fit, lacking: fit === 'partial' ? plain(m.lacking, 300) : '' });
    }
  }
  const duplicates = (Array.isArray(raw?.duplicate_groups) ? raw.duplicate_groups : [])
    .map((g) => [...new Set((Array.isArray(g) ? g : []).map(at).filter(Boolean))])
    .filter((g) => g.length > 1)
    .slice(0, 40);
  return { matches, duplicates };
}

// The library is matched in batches (MATCH_BATCH_SIZE). Their answers joined:
// per requirement, covered pieces before partial ones, each in library order,
// every one kept.
export function mergeMatchBatches(batches, requirements) {
  const all = (batches || []).flatMap((b) => b?.matches || []);
  const matches = [];
  for (const r of requirements || []) {
    const mine = all.filter((m) => m.requirement_id === r.id);
    matches.push(...[...mine.filter((m) => m.fit === 'covered'), ...mine.filter((m) => m.fit !== 'covered')]);
  }
  return { matches, duplicates: (batches || []).flatMap((b) => b?.duplicates || []).slice(0, 40) };
}

// An artwork known only by its description: the entry phase 1 stores for a
// matched piece the reviewer has not looked at (score null, not audited).
export function matchedEntry(artwork, fits, reqSig = '') {
  return {
    artwork_id: artwork._id,
    result_image_id: artwork.result_image_id,
    name: plain(artwork.name, 120),
    score: null,
    criteria: [],
    fits,
    issues: [],
    action: null,
    suggested_edit: '',
    regenerate_reason: '',
    audited_image_id: null,
    req_sig: reqSig,
  };
}

// Which matched pieces the reviewer should look at: per requirement the first
// REVIEW_PER_REQUIREMENT matches (best first) that a current review has not
// already rejected for it. `reviewed`: Map artwork id → current reviewed entry.
export function reviewCandidates(requirements, matches, reviewed) {
  const ids = new Set();
  for (const r of requirements || []) {
    let n = 0;
    for (const m of (matches || []).filter((x) => x.requirement_id === r.id)) {
      const e = reviewed?.get(String(m.artwork_id));
      if (e && !(e.fits || []).some((f) => f.requirement_id === r.id)) continue; // looked at: not it
      ids.add(String(m.artwork_id));
      n += 1;
      if (n >= REVIEW_PER_REQUIREMENT) break;
    }
  }
  return ids;
}

// A requirement whose best piece the reviewer wants made again (or that edits
// stopped improving) and that has not used up its regenerations.
export function requirementNeedsRegeneration(requirement, entries, proposals, maxEditAttempts = 2) {
  if (requirement.status === 'missing') return false;
  const best = (entries || []).find((e) => String(e.artwork_id) === String((requirement.covered_by || [])[0] || ''));
  if (!best || !best.audited_image_id) return false;
  const stuck = best.action === 'regenerate'
    || ((best.edit_attempts || 0) >= maxEditAttempts && (best.score ?? 10) < KEEP_SCORE);
  if (!stuck) return false;
  const made = (proposals || []).filter((p) => p.status === 'done' && (p.requirement_ids || []).map(String).includes(requirement.id)).length;
  return made < MAX_REGENERATIONS;
}

// What the reviewer found wrong with one artwork, in plain sentences: its
// issues, what each partial fit lacks, and the note of every rubric criterion
// scored 6 or below. This is the explanation shown to the user AND what an
// edit or a remake is told to put right.
export function reviewFindings(entry) {
  const out = [];
  for (const i of entry?.issues || []) if (i?.note) out.push(i.note);
  for (const f of entry?.fits || []) if (f?.fit === 'partial' && f.lacking) out.push(f.lacking);
  for (const c of entry?.criteria || []) {
    if (Number.isFinite(c?.score) && c.score <= 6 && c.note) {
      out.push(`${REVIEW_CRITERIA.find((d) => d.key === c.key)?.label || c.key} (${c.score}/10): ${c.note}`);
    }
  }
  return [...new Set(out.map((x) => plain(x, 300)).filter(Boolean))].slice(0, 10);
}

// Why a requirement's picture is being MADE AGAIN, for the planner and the
// user: the reviewer's reason, everything it found wrong, and the edit that
// was tried when edits are what failed.
export function regenerationBrief(entry) {
  if (!entry) return '';
  const parts = [];
  if (entry.regenerate_reason) parts.push(entry.regenerate_reason);
  const found = reviewFindings(entry);
  if (found.length) parts.push(`Wrong in "${plain(entry.name, 80) || 'the piece on file'}": ${found.join('; ')}`);
  if ((entry.edit_attempts || 0) > 0 && entry.suggested_edit) parts.push(`${entry.edit_attempts} in-place edit(s) did not fix it ("${plain(entry.suggested_edit, 300)}") — the new picture must show that from the start`);
  return parts.join('. ');
}

// ───────────────────────────── Climb: in-place edits ─────────────────────────────

// The edit a climb applies to ONE artwork: the auditor's suggested edit, what
// each partly-met requirement still lacks, and what the image already covers
// (which the edit must not lose).
export function composeClimbEditPrompt({ suggestedEdit = '', lacking = [], keep = [], direction = '', findings = [] }) {
  const parts = [];
  const edit = plain(suggestedEdit, 600);
  if (edit) parts.push(edit);
  // Everything the reviewer found wrong goes to the edit model, not only the
  // one-sentence instruction — a fault the sentence left out is still fixed.
  const wrong = [...new Set((findings || []).map((f) => plain(f, 300)).filter(Boolean))].filter((f) => !edit.includes(f));
  if (wrong.length) parts.push(`The reviewer found these wrong in the picture — correct every one: ${wrong.join('; ')}.`);
  for (const l of lacking) {
    const text = plain(l?.lacking, 300);
    if (text && !edit.includes(text)) parts.push(`The picture must show "${plain(l.summary, 120)}" — still missing or different: ${text}`);
  }
  if (!parts.length) return '';
  const kept = keep.map((k) => plain(k, 120)).filter(Boolean);
  parts.push(`Change nothing else: same framing, same subject, same light${kept.length ? `, and keep what it already shows — ${kept.join('; ')}` : ''}.`);
  const dir = String(direction || '').trim();
  if (dir) parts.push(`Director's direction: ${plain(dir, 400)}`);
  return parts.join(' ').slice(0, 4000);
}

// ───────────────────────────── Pass C: proposals ─────────────────────────────

// A [prop] requirement is answered by a prop plate: the object alone. It is
// the one set proposal the clean-plate rules above do not describe.
const PROP_PLATE_RULES = [
  '- EXCEPTION — a requirement of category prop is a PROP PLATE, not a view of the set, and none of the plate rules above apply to it. One proposal per prop requirement, answering that requirement alone. The prompt is a product photograph of the ONE object by itself: whole, sharp, filling about half the frame, three-quarter view at its own eye level, resting on (or, for a ball, just above) a plain seamless mid-grey studio background under soft even light, true colours. State its shape, real-world size ("the size of a plum"), material, every colour and where it sits, the pattern and the wear. Say what it must not be mistaken for when the shape is ambiguous (a crocheted ball, not a hat or a beanie). No hands, no people, no place, no ground texture, no second object, no text. reference_indexes: empty, unless a catalog entry is marked as a prop plate of this same object.',
].join('\n');

const SET_PROPOSAL_RULES = [
  '# Set proposals',
  '- Each proposal is one still of the SET for the art library: the view, sub-location, vehicle, building or set piece the requirement names, at the time of day and in the light the beat describes.',
  '- THE PLACE MUST LOOK LIKE THE PLACE. reference_indexes may name only catalog entries of THIS SAME SET, and when the catalog has any, every view proposal attaches the ones that show the same place or part of it: the set\'s PHOTOS ([SET PHOTO] entries — the real location the set was built from; the main image is attached automatically as reference image 1) first, then its artwork that shows the same part of the place (an interior for an interior, the facade for the facade). Pick the pictures whose architecture, signage, materials and dressing the new picture must reproduce; leave out a picture of an unrelated part of the set. A binding line naming what each attached image is leads the prompt automatically — do not restate it; write "the place in the reference images" and describe what the NEW picture shows: the vantage and framing, the part of the place in frame, time of day, lighting, palette, lens, and explicit OCCUPANCY (the seats are empty, the lot is unoccupied). Never describe the architecture, colours or signage differently from the references; a different vantage or a different time of day is NOT a reason to drop them.',
  '- Only when the catalog holds no picture of this set is the prompt a complete standalone scene description: location, layout (foreground / midground / background, left / right), time of day, lighting, palette, lens and framing, and occupancy.',
  STATIC_PLATE_CONSTRAINTS,
  PROP_PLATE_RULES,
].join('\n');

const CHARACTER_PROPOSAL_RULES = [
  '# Character proposals',
  '- Each proposal is one plain photograph of ONE person in ONE pose: the costume, the expression and the staging the requirement names, as the beat plays it. Describe the person by their look and casting, never by a proper name. The character\'s PORTRAIT is attached automatically as reference image 1 and a binding line naming what each attached image is leads the prompt — do not pick a portrait yourself and do not restate the binding; write "the person in the reference images" and describe only what CHANGES (pose, expression, light, place). Never ask to change the face, hair colour, build or skin.',
  '- The costume is GIVEN when the subject carries a LOCKED WARDROBE: its words are prepended to your prompt automatically and its wardrobe plate (when one exists) is attached as reference image 2. Never describe garments, colours or footwear that differ from it, never invent an outfit, and do not restate it — name only a change the requirement itself calls for (jacket off, sleeves rolled). A character with no lock gets the costume the requirement names, stated once in plain words.',
  '- Pose and expression are body mechanics and specifics, not feelings: "jaw set, eyes narrowed, weight forward on the balls of the feet", not "angry". Pick the character\'s own artwork from the catalog only when it shows something the portrait does not (a full-body view for a full-body pose, the costume the beat reuses). A pose that needs the place (seated in the rear bench) may name ONE set artwork from the catalog as a background reference; otherwise the backdrop is plain and unlettered.',
  '- Several requirements that one still can satisfy (this beat\'s costume + this expression + this pose) become ONE proposal naming all of them.',
  '- The output rules for a character still (one person, no sheet, no text) are appended to your prompt automatically — do not restate them.',
].join('\n');

export const PROPOSALS_SYSTEM_PROMPT = [
  'You are the art director briefing image generation for the artwork a screenplay beat is missing. You are given one subject (a set or a character), the requirements the beat imposes on it that still need a picture MADE — MISSING (nothing on file answers it) or REGENERATE (the piece on file was reviewed and cannot be edited into it; the requirement line says what was wrong, and the new picture must not repeat it) — the audit of what is on file, and a numbered catalog of the project\'s existing artwork to use as references. Write one generation proposal per picture the library needs.',
  '',
  SET_PROPOSAL_RULES,
  '',
  CHARACTER_PROPOSAL_RULES,
  '',
  '# Every proposal',
  '- A requirement marked REGENERATE, or a MISSING one that says a previous render was turned down, carries the reviewer\'s findings after "review:". The new prompt MUST put every one of them right, stated as what the picture SHOWS (the reviewer said "daylight, the beat is dusk" → the prompt says dusk light; "shot from behind" → the prompt states the front three-quarter view). Do not reuse the turned-down piece as a reference when its fault is its composition, viewpoint or the person\'s identity.',
  '- requirement_ids: the requirement ids this picture satisfies (at least one).',
  '- name: a card label of at most 60 characters.',
  '- prompt: sent VERBATIM to the image model together with ONLY the references you pick. Purely visual. No justification, no quotes from the beat, no character names.',
  '- reference_indexes: catalog entries to attach (the same subject\'s photos and artwork for continuity; for a character pose, optionally one set plate). Empty only when nothing on file depicts the subject.',
  '- rationale: one sentence for the reviewer — why this picture, and what in the beat calls for it.',
  '- Every listed requirement must be answered by a proposal — one picture may answer several, none may be left out.',
  '',
  NO_TEXT_RULES,
  '',
  'Return only the JSON object the schema describes.',
].join('\n');

export const PROPOSALS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['proposals'],
  properties: {
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['requirement_ids', 'name', 'prompt', 'reference_indexes', 'rationale'],
        properties: {
          requirement_ids: { type: 'array', items: { type: 'string' } },
          name: { type: 'string' },
          prompt: { type: 'string' },
          reference_indexes: { type: 'array', items: { type: 'integer' } },
          rationale: { type: 'string' },
        },
      },
    },
  },
};

export function buildProposalsText({ beat, subject, subjectCard, requirements, audit, catalogText, direction = '' }) {
  const lock = subject.kind === 'character' ? wardrobeText(subject.doc, beat) : '';
  return [
    `# Beat #${beat?.order ?? '?'}: ${plain(beat?.name) || 'Untitled'}`,
    plain(beat?.desc, 600) || '',
    '',
    `# Subject: ${subject.kind.toUpperCase()} "${plain(subject.name)}"`,
    subjectCard || '',
    ...(lock ? [`LOCKED WARDROBE (given — do not describe or change it): ${lock}`] : []),
    '',
    '# Audit of what is on file',
    audit?.summary || '(no artwork on file — every proposal is standalone, with no references)',
    '',
    '# Requirements to satisfy (missing, or to be made again)',
    ...requirements.map((r) => `${r.id} [${r.category}${r.importance === 'essential' ? ', essential' : ''}, ${r.status}] ${r.summary} — ${r.detail}${r.review ? ` (review: ${r.review})` : r.note ? ` (audit: ${r.note})` : ''}${r.quote ? ` (beat: "${r.quote}")` : ''}`),
    '',
    '# Artwork catalog (reference_indexes point here)',
    catalogText || '(empty)',
    ...(String(direction || '').trim()
      ? ['', "# The director's direction for these proposals", String(direction).trim(), 'Follow it in every prompt, as far as the locked wardrobe and the beat allow.']
      : []),
  ].join('\n');
}

// The character's identity anchor: the main portrait, else the first gallery
// image. The reference catalog deliberately offers artwork only, but artwork
// is already one generation removed from the portrait every sheet was built
// from — without the portrait itself in the call the likeness drifts.
export function characterPortraitId(character) {
  const main = character?.main_image_id ? String(character.main_image_id) : '';
  if (main) return main;
  const first = (character?.images || [])[0];
  const id = first?._id ?? first;
  return id ? String(id) : '';
}

// Order a character proposal's references for a multi-image edit model:
// portrait first (the identity), the wardrobe plate second (the clothes —
// src/web/wardrobe.js), the character's own artwork next, set plates last
// (image 1 is the canvas for nano-banana-style edit endpoints — a plate in
// that slot comes back as the plate with the person pasted in). Returns
// [{ image_id, role: 'portrait'|'wardrobe'|'artwork'|'set' }], deduped and
// capped. A plate that IS the portrait stays one entry with both jobs
// (role 'portrait', wardrobe: true).
export function orderCharacterReferences({ portraitId, wardrobeId = '', picks = [] }) {
  const seen = new Set();
  const out = [];
  const add = (image_id, role) => {
    const k = String(image_id || '');
    if (!k || seen.has(k) || out.length >= MAX_PROPOSAL_REFERENCES) return;
    seen.add(k);
    out.push({ image_id: k, role });
  };
  if (portraitId) add(portraitId, 'portrait');
  const plate = String(wardrobeId || '');
  if (plate) {
    if (out[0] && out[0].image_id === plate) out[0].wardrobe = true;
    else add(plate, 'wardrobe');
  }
  for (const p of picks) if (p.owner_type !== 'set') add(p.image_id, 'artwork');
  for (const p of picks) if (p.owner_type === 'set') add(p.image_id, 'set');
  return out;
}

// What each attached image is, in attachment order — the model is never left
// to guess which picture is the person and which is the place.
export function describeCharacterReferences(refs) {
  if (!refs?.length) return '';
  const lines = refs.map((r, i) => {
    const n = `Reference image ${i + 1}`;
    if (r.role === 'portrait') {
      return r.wardrobe
        ? `${n} is this person's portrait AND wardrobe plate: the authority on face, hair, build and skin, and on the garments, their colours, fit and footwear — reproduce all of them exactly.`
        : `${n} is this person's portrait: the authority on face, hair, build and skin — reproduce them exactly.`;
    }
    if (r.role === 'wardrobe') return `${n} is this person's wardrobe plate: reproduce the garments, their colours, fit and footwear exactly; take nothing else from it — not the pose, not the place, not the light.`;
    if (r.role === 'set') return `${n} shows the PLACE only (a set plate for the background); nobody in it is the subject.`;
    return `${n} is the same person, another view: use it for likeness, build and wardrobe, not for the pose.`;
  });
  return lines.join('\n');
}

// The character still's prompt: the subject handle leads, the reference
// binding follows, then the model's prose, then the one-person/no-text output
// rules. Sets are sent as-is. `references` is the ordered
// [{image_id, role}] list from orderCharacterReferences.
export function composeCharacterProposalPrompt(prompt, character, { references = [], beat = null } = {}) {
  const handle = buildSubjectHandle(character);
  const lock = wardrobeLine(character, beat);
  const binding = describeCharacterReferences(references);
  return [`Subject: ${handle}.`, ...(lock ? [lock] : []), binding, '', plain(prompt, 2000), '', CHARACTER_SHEET_OUTPUT_RULES].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

// A binding line this module wrote — the per-image lines above, or the single
// sentence proposals carried before the portrait was attached automatically.
const BINDING_LINE = /^(Reference image \d+ (is|shows) |The attached reference images are the authority)/;

// Rewrite a STORED character prompt's binding to match the references that
// will actually be sent. Generation (and every retry / regenerate) reuses the
// proposal as saved, so a proposal planned before the portrait rule, or one
// whose references the SPA overrode, would otherwise describe pictures that
// are not attached. The planner's prose and the output rules are untouched.
// `wardrobe` (the current locked wardrobe line, '' when none) replaces any
// stored one the same way.
export function rebindCharacterPrompt(prompt, references, { wardrobe = '' } = {}) {
  const lines = String(prompt || '').split('\n');
  const kept = lines.filter((l) => !BINDING_LINE.test(l.trim()) && !WARDROBE_LINE_RE.test(l.trim()));
  const binding = describeCharacterReferences(references);
  const at = kept.length && /^Subject: /.test(kept[0]) ? 1 : 0;
  const out = [...kept.slice(0, at), ...(wardrobe ? [wardrobe] : []), ...(binding ? [binding] : []), ...kept.slice(at)];
  return out.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

// The set's look anchor: its main image (an uploaded photo of the real place,
// usually), else its first gallery upload. Like the character portrait, it is
// attached to every view proposal whether or not the planner picked it — a
// theatre rendered from the prompt alone is some theatre, not this one.
export function setAnchorId(set) {
  const main = set?.main_image_id ? String(set.main_image_id) : '';
  if (main) return main;
  const first = (set?.images || [])[0];
  const id = first?._id ?? first;
  return id ? String(id) : '';
}

// Order a set proposal's references: the anchor first, then the set's other
// photos (`upload`), then its artwork — only pictures of THIS set; a pick of
// another host is dropped (the rules forbid it, the code enforces it).
// Returns [{ image_id, role: 'photo'|'artwork' }], deduped and capped.
export function orderSetReferences({ anchorId, picks = [], setId = '' }) {
  const seen = new Set();
  const out = [];
  const add = (image_id, role) => {
    const k = String(image_id || '');
    if (!k || seen.has(k) || out.length >= MAX_PROPOSAL_REFERENCES) return;
    seen.add(k);
    out.push({ image_id: k, role });
  };
  if (anchorId) add(anchorId, 'photo');
  const mine = picks.filter((p) => p.owner_type === 'set' && (!setId || !p.owner_id || String(p.owner_id) === String(setId)));
  for (const p of mine) if (p.upload) add(p.image_id, 'photo');
  for (const p of mine) if (!p.upload) add(p.image_id, 'artwork');
  return out;
}

// What each attached image of a set proposal is, in attachment order.
export function describeSetReferences(refs) {
  if (!refs?.length) return '';
  return refs
    .map((r, i) => {
      const n = `Reference image ${i + 1}`;
      return r.role === 'photo'
        ? `${n} is a photograph of this same PLACE: the authority on its architecture, materials, signage, colours and dressing — reproduce them exactly; only the vantage, framing, time of day, light and occupancy change, as the prompt says.`
        : `${n} shows this same PLACE as it has already been rendered: match its architecture, materials, signage and colours; take the vantage and the light from the prompt, not from it.`;
    })
    .join('\n');
}

// The set still's prompt: the reference binding leads, then the planner's
// prose. `references` is the ordered [{image_id, role}] list from
// orderSetReferences; with none, the prompt is sent as written.
export function composeSetProposalPrompt(prompt, { references = [] } = {}) {
  const binding = describeSetReferences(references);
  return [binding, '', plain(prompt, 2000)].filter((l, i, a) => !(l === '' && (i === 0 || a[i - 1] === ''))).join('\n');
}

// Rewrite a STORED set prompt's binding to match the references that will
// actually be sent (see rebindCharacterPrompt for why).
export function rebindSetPrompt(prompt, references) {
  const kept = String(prompt || '').split('\n').filter((l) => !BINDING_LINE.test(l.trim()));
  while (kept.length && kept[0] === '') kept.shift();
  const binding = describeSetReferences(references);
  return [...(binding ? [binding, ''] : []), ...kept].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

// → proposals ready to store: {_id, host_type, host_id, host_name, requirement_ids, name, prompt, reference_image_ids, rationale, status, model, artwork_id, error_message, generated_at}
export function normalizeProposals(raw, { subject, requirements, catalog, beat = null }) {
  const reqIds = new Set((requirements || []).map((r) => r.id));
  const indexToEntry = (i) => {
    const n = Number(i);
    const entry = Number.isInteger(n) ? (catalog || []).find((c) => c.index === n) : null;
    return entry?.image_id ? entry : null;
  };
  const portraitId = subject.kind === 'character' ? characterPortraitId(subject.doc) : '';
  const wardrobeId = subject.kind === 'character' ? wardrobeImageId(subject.doc) : '';
  const anchorId = subject.kind === 'set' ? setAnchorId(subject.doc) : '';
  const setHasPictures = subject.kind === 'set' && (!!anchorId || (catalog || []).some((c) => c.owner_type === 'set' && (!c.owner_id || String(c.owner_id) === String(subject.id))));
  const out = [];
  const warnings = [];
  const any = Array.isArray(raw?.proposals) && raw.proposals.length > 0;
  if (subject.kind === 'set' && any && !setHasPictures && (requirements || []).some((r) => r.category !== 'prop')) {
    warnings.push(`${subject.name}: no picture of the set on file — its look comes from the prompts alone; upload a photo of the place to the set's Images`);
  }
  if (subject.kind === 'character' && !portraitId && any) {
    warnings.push(`${subject.name}: no portrait on file — the proposals rely on artwork alone for the likeness`);
  }
  if (subject.kind === 'character' && any && !wardrobeText(subject.doc, beat) && !wardrobeId) {
    warnings.push(`${subject.name}: no wardrobe lock — the costume will be invented; set Wardrobe on the character`);
  }
  for (const p of Array.isArray(raw?.proposals) ? raw.proposals : []) {
    if (!p || typeof p !== 'object') continue;
    const ids = [...new Set((Array.isArray(p.requirement_ids) ? p.requirement_ids : []).map(String).filter((id) => reqIds.has(id)))];
    const promptText = plain(p.prompt, 2000);
    if (!ids.length || !promptText) {
      warnings.push(`${subject.name}: a proposal with no requirement or no prompt was dropped`);
      continue;
    }
    const picks = (Array.isArray(p.reference_indexes) ? p.reference_indexes : []).map(indexToEntry).filter(Boolean);
    // A proposal that answers a prop requirement renders a PROP PLATE: the
    // artwork it makes carries the object's name (`prop`), which is how the
    // reference catalog and the frame renderer know it is an object, not a
    // view of the set.
    const propReq = subject.kind === 'set' ? requirements.find((r) => ids.includes(r.id) && r.category === 'prop') : null;
    let refs;
    let prompt;
    if (subject.kind === 'character') {
      const ordered = orderCharacterReferences({ portraitId, wardrobeId, picks });
      refs = ordered.map((r) => r.image_id);
      prompt = composeCharacterProposalPrompt(promptText, subject.doc, { references: ordered, beat });
    } else if (propReq) {
      // A prop plate shows the object alone: no view of the place is attached.
      refs = [...new Set(picks.filter((e) => e.prop).map((e) => String(e.image_id)))].slice(0, MAX_PROPOSAL_REFERENCES);
      prompt = promptText;
    } else {
      const ordered = orderSetReferences({ anchorId, picks, setId: subject.id });
      refs = ordered.map((r) => r.image_id);
      prompt = composeSetProposalPrompt(promptText, { references: ordered });
    }
    out.push({
      ...(propReq ? { prop: plain(propReq.summary, 80) } : {}),
      _id: new ObjectId(),
      host_type: subject.kind,
      host_id: new ObjectId(String(subject.id)),
      host_name: plain(subject.name, 120),
      requirement_ids: ids,
      name: plain(p.name, 60) || plain(requirements.find((r) => r.id === ids[0])?.summary, 60) || 'Artwork',
      prompt,
      reference_image_ids: refs.map((id) => new ObjectId(id)),
      rationale: plain(p.rationale, 400),
      status: 'proposed',
      model: null,
      artwork_id: null,
      error_message: null,
      generated_at: null,
    });
  }
  return { proposals: out, warnings };
}

// ───────────────────────────── Coverage ─────────────────────────────

// Essential requirements weigh 2, useful 1.
// `pct` is COVERAGE: the share of requirements a picture on file answers
// (covered, or close enough to be edited into it) — decided by phase 1.
// `quality_pct` (what a climb climbs) weighs each requirement by the rubric
// score of the best REVIEWED artwork answering it; a requirement nothing
// reviewed answers yet counts 0, so quality only exists once phase 2 has
// looked. `reviewed` counts the requirements whose answer has been looked at.
export function computeCoverage(subjects) {
  let total = 0;
  let covered = 0;
  let partial = 0;
  let missing = 0;
  let reviewed = 0;
  let wsum = 0;
  let wcov = 0;
  let wqual = 0;
  for (const s of subjects || []) {
    const scores = new Map((s?.artworks || []).filter((e) => e.audited_image_id).map((e) => [String(e.artwork_id), e.score]));
    for (const r of s?.requirements || []) {
      const w = r.importance === 'essential' ? 2 : 1;
      total += 1;
      wsum += w;
      if (r.status === 'covered') covered += 1;
      else if (r.status === 'partial') partial += 1;
      else { missing += 1; continue; }
      wcov += w;
      const known = (r.covered_by || []).map((id) => scores.get(String(id))).filter(Number.isFinite);
      if (!known.length) continue;
      reviewed += 1;
      wqual += w * (Math.max(...known) / 10);
    }
  }
  return {
    total,
    covered,
    partial,
    missing,
    reviewed,
    pct: wsum ? Math.round((wcov / wsum) * 100) : null,
    quality_pct: wsum ? Math.round((wqual / wsum) * 100) : null,
  };
}
