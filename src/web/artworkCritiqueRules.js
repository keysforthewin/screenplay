// Pure half of the beat ARTWORK critique: the three prompts, their JSON output
// schemas, the normalizers that turn a model answer into stored rows, and the
// coverage arithmetic. No I/O here — src/web/artworkCritique.js owns the calls.
//
// Pass A (requirements): what pictures must exist for this beat, per subject.
// Pass B (audit, vision): which existing artwork covers each requirement, and
//          what in each image disagrees with the writing.
// Pass C (proposals): a generation prompt per missing/partial requirement.

import { ObjectId } from 'mongodb';
import { stripMarkdown } from '../util/markdown.js';
import { STATIC_PLATE_CONSTRAINTS } from './beatSheetPlanner.js';
import { CHARACTER_SHEET_OUTPUT_RULES, buildSubjectHandle } from './characterSheetShots.js';
import { NO_TEXT_RULES } from './promptConstraints.js';
import { WARDROBE_LINE_RE, wardrobeImageId, wardrobeLine, wardrobeText } from './wardrobe.js';

export const MAX_SUBJECTS = 8;
export const MAX_ARTWORKS_PER_SUBJECT = 12;
export const MAX_REQUIREMENTS_PER_SUBJECT = 12;
export const MAX_PROPOSALS_PER_SUBJECT = 8;
export const MAX_PROPOSAL_REFERENCES = 12;

export const SET_CATEGORIES = ['view', 'sub_location', 'vehicle', 'building', 'prop', 'light'];
export const CHARACTER_CATEGORIES = ['costume', 'expression', 'pose', 'action', 'held_prop'];
export const REQUIREMENT_CATEGORIES = [...SET_CATEGORIES, ...CHARACTER_CATEGORIES];
export const COVERAGE_STATUSES = ['covered', 'partial', 'missing'];
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
  '# Characters',
  '- costume: a character whose subject line carries a LOCKED WARDROBE gets exactly ONE costume requirement whose detail is that wardrobe text VERBATIM (quote: "wardrobe lock"), plus a further costume requirement ONLY for a garment the beat text explicitly adds, removes or changes (a jacket off, a torn sleeve). Never invent or paraphrase a locked wardrobe. Only a character with NO lock gets what the text says they wear — and if the text says nothing, one requirement for "the costume this beat implies" with the quote that implies it.',
  '- expression: every distinct facial expression the beat plays on this character (fear, fury, a held-back smile) — one requirement each, named in plain words.',
  '- pose / action: the positions and physical actions the beat stages (seated in the back seat, leaning on the counter, dragging a parent by the hand) — one requirement per distinct staging the camera will need.',
  '- held_prop: an object the character holds or handles on screen.',
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
    const n = (counts.get(key) || 0) + 1;
    if (n > MAX_REQUIREMENTS_PER_SUBJECT) {
      if (n === MAX_REQUIREMENTS_PER_SUBJECT + 1) warnings.push(`${subject.name}: more than ${MAX_REQUIREMENTS_PER_SUBJECT} requirements — the rest were dropped`);
      counts.set(key, n);
      continue;
    }
    counts.set(key, n);
    const allowed = subject.kind === 'set' ? SET_CATEGORIES : CHARACTER_CATEGORIES;
    const category = allowed.includes(r.category) ? r.category : allowed[0];
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

export const AUDIT_SYSTEM_PROMPT = [
  'You are the art director checking ONE subject\'s artwork library against ONE screenplay beat. The artwork images are attached and numbered; the requirements the beat imposes on this subject follow them. LOOK at the images — never judge from their descriptions alone.',
  '',
  '# Coverage',
  '- For EVERY requirement say which artwork covers it: covered = some image shows exactly that view / costume / expression / pose; partial = the subject is there but the angle, costume, expression, light or state differs from what the requirement describes; missing = nothing on file shows it. artwork_indexes lists the covering images (1-based); note says what is right or what differs.',
  '',
  '# Accuracy of what exists',
  '- For every artwork, list ONLY disagreements with THIS BEAT\'S WRITING: a wrong jacket, daylight where the beat is night, a smile where the beat says fury, a prop the beat names that is absent, lettering in the picture, a layout the beat contradicts. Never taste notes, never style preferences, never faults that do not touch this beat.',
  '- A character with a LOCKED WARDROBE (stated under the subject): every garment, colour and piece of footwear in each image is compared with that text — any difference is a `wardrobe` issue, whether or not the beat mentions clothes. The suggested_edit then names the locked garments.',
  '- suggested_edit: ONE imperative sentence an image-edit model could apply to THAT image alone to fix the issues ("Change the jacket to a worn brown leather bomber; keep everything else exactly as it is."). Empty string when the image is fine.',
  '- accuracy_score: 1–10 for how faithful the existing artwork as a whole is to this beat\'s writing. 10 = everything on file matches; 5 or below = a frame rendered from this artwork would contradict the beat.',
  '- summary: two or three sentences for the art department — what is on file, what is wrong, what is missing.',
  '',
  'Return only the JSON object the schema describes.',
].join('\n');

export const AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['coverage', 'artworks', 'accuracy_score', 'summary'],
  properties: {
    coverage: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['requirement_id', 'status', 'artwork_indexes', 'note'],
        properties: {
          requirement_id: { type: 'string' },
          status: { type: 'string', enum: COVERAGE_STATUSES },
          artwork_indexes: { type: 'array', items: { type: 'integer' } },
          note: { type: 'string' },
        },
      },
    },
    artworks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'issues', 'suggested_edit'],
        properties: {
          index: { type: 'integer' },
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
          suggested_edit: { type: 'string' },
        },
      },
    },
    accuracy_score: { type: 'integer', description: '1-10' },
    summary: { type: 'string' },
  },
};

export function buildAuditText({ beat, subject, subjectCard, requirements, artworks }) {
  const lock = subject.kind === 'character' ? wardrobeText(subject.doc, beat) : '';
  const lines = [
    `# Beat #${beat?.order ?? '?'}: ${plain(beat?.name) || 'Untitled'}`,
    plain(beat?.desc, 600) || '',
    '',
    `# Subject: ${subject.kind.toUpperCase()} "${plain(subject.name)}"`,
    subjectCard || '',
    ...(lock ? [`LOCKED WARDROBE (every image must match these words): ${lock}`] : []),
    '',
    '# Artwork on file (attached above, in this order)',
    ...(artworks.length
      ? artworks.map((a, i) => `Artwork ${i + 1} — "${plain(a.name, 80) || 'untitled'}"${a.description ? `: ${plain(a.description, 300)}` : ''}`)
      : ['(none)']),
    '',
    '# Requirements this beat imposes on the subject',
    ...requirements.map((r) => `${r.id} [${r.category}${r.importance === 'essential' ? ', essential' : ''}] ${r.summary} — ${r.detail}${r.quote ? ` (beat: "${r.quote}")` : ''}`),
    '',
    'For every requirement say which artwork covers it; for every artwork say what disagrees with the writing.',
  ];
  return lines.join('\n');
}

// → { requirements (with status/covered_by/note), artworks: [{artwork_id, result_image_id, name, issues, suggested_edit}], accuracy_score, summary }
export function normalizeAudit(raw, { requirements, artworks }) {
  const byReq = new Map();
  for (const c of Array.isArray(raw?.coverage) ? raw.coverage : []) {
    if (!c || typeof c !== 'object' || byReq.has(c.requirement_id)) continue;
    byReq.set(String(c.requirement_id), c);
  }
  const indexToId = (i) => {
    const n = Number(i);
    return Number.isInteger(n) && n >= 1 && n <= artworks.length ? artworks[n - 1] : null;
  };
  const outReqs = requirements.map((r) => {
    const c = byReq.get(r.id);
    if (!c) return { ...r, status: 'missing', covered_by: [], note: '' };
    const covered = (Array.isArray(c.artwork_indexes) ? c.artwork_indexes : []).map(indexToId).filter(Boolean);
    let status = COVERAGE_STATUSES.includes(c.status) ? c.status : 'missing';
    if (status !== 'missing' && !covered.length) status = 'missing';
    return {
      ...r,
      status,
      covered_by: [...new Set(covered.map((a) => String(a._id)))].map((id) => new ObjectId(id)),
      note: plain(c.note, 400),
    };
  });
  const byIndex = new Map();
  for (const a of Array.isArray(raw?.artworks) ? raw.artworks : []) {
    if (!a || typeof a !== 'object') continue;
    const n = Number(a.index);
    if (Number.isInteger(n) && n >= 1 && n <= artworks.length && !byIndex.has(n)) byIndex.set(n, a);
  }
  const outArtworks = artworks.map((a, i) => {
    const v = byIndex.get(i + 1);
    const issues = (Array.isArray(v?.issues) ? v.issues : [])
      .map((x) => ({ kind: ARTWORK_ISSUE_KINDS.includes(x?.kind) ? x.kind : 'other', note: plain(x?.note, 300) }))
      .filter((x) => x.note)
      .slice(0, 8);
    return {
      artwork_id: a._id,
      result_image_id: a.result_image_id,
      name: plain(a.name, 120),
      issues,
      suggested_edit: issues.length ? plain(v?.suggested_edit, 600) : '',
    };
  });
  return {
    requirements: outReqs,
    artworks: outArtworks,
    accuracy_score: clampInt(raw?.accuracy_score),
    summary: plain(raw?.summary, 1200),
  };
}

// ───────────────────────────── Pass C: proposals ─────────────────────────────

const SET_PROPOSAL_RULES = [
  '# Set proposals',
  '- Each proposal is one still of the SET for the art library: the view, sub-location, vehicle, building or set piece the requirement names, at the time of day and in the light the beat describes.',
  '- reference_indexes may name only catalog entries of THIS SAME SET. With references the prompt is a MINIMAL EDIT: anchor on the reference ("Edit this photo of the theatre lot…"), one blanket keep clause ("keep everything exactly as it is: same architecture, all existing signage unchanged"), then ONLY the change the requirement needs (a new angle is NOT an edit — a different vantage is a refless proposal). Without references it is a complete standalone scene description: location, layout (foreground / midground / background, left / right), time of day, lighting, palette, lens and framing, and explicit OCCUPANCY (the seats are empty, the lot is unoccupied).',
  STATIC_PLATE_CONSTRAINTS,
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
  'You are the art director briefing image generation for the artwork a screenplay beat is missing. You are given one subject (a set or a character), the requirements the beat imposes on it that are MISSING or only PARTIALLY covered, the audit of what is on file, and a numbered catalog of the project\'s existing artwork to use as references. Write one generation proposal per picture the library needs.',
  '',
  SET_PROPOSAL_RULES,
  '',
  CHARACTER_PROPOSAL_RULES,
  '',
  '# Every proposal',
  '- requirement_ids: the requirement ids this picture satisfies (at least one).',
  '- name: a card label of at most 60 characters.',
  '- prompt: sent VERBATIM to the image model together with ONLY the references you pick. Purely visual. No justification, no quotes from the beat, no character names.',
  '- reference_indexes: catalog entries to attach (the same subject\'s artwork for continuity; for a character pose, optionally one set plate). Empty when nothing on file depicts the subject.',
  '- rationale: one sentence for the reviewer — why this picture, and what in the beat calls for it.',
  `- At most ${MAX_PROPOSALS_PER_SUBJECT} proposals.`,
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
    '# Requirements to satisfy (missing or partial)',
    ...requirements.map((r) => `${r.id} [${r.category}${r.importance === 'essential' ? ', essential' : ''}, ${r.status}] ${r.summary} — ${r.detail}${r.note ? ` (audit: ${r.note})` : ''}${r.quote ? ` (beat: "${r.quote}")` : ''}`),
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
  const out = [];
  const warnings = [];
  const any = Array.isArray(raw?.proposals) && raw.proposals.length > 0;
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
    if (out.length >= MAX_PROPOSALS_PER_SUBJECT) {
      warnings.push(`${subject.name}: more than ${MAX_PROPOSALS_PER_SUBJECT} proposals — the rest were dropped`);
      break;
    }
    const picks = (Array.isArray(p.reference_indexes) ? p.reference_indexes : []).map(indexToEntry).filter(Boolean);
    let refs;
    let prompt;
    if (subject.kind === 'character') {
      const ordered = orderCharacterReferences({ portraitId, wardrobeId, picks });
      refs = ordered.map((r) => r.image_id);
      prompt = composeCharacterProposalPrompt(promptText, subject.doc, { references: ordered, beat });
    } else {
      refs = [...new Set(picks.map((e) => String(e.image_id)))].slice(0, MAX_PROPOSAL_REFERENCES);
      prompt = promptText;
    }
    out.push({
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

// Essential requirements weigh 2, useful 1; partial counts half.
export function computeCoverage(subjects) {
  let total = 0;
  let covered = 0;
  let partial = 0;
  let missing = 0;
  let wsum = 0;
  let wcov = 0;
  for (const s of subjects || []) {
    for (const r of s?.requirements || []) {
      const w = r.importance === 'essential' ? 2 : 1;
      total += 1;
      wsum += w;
      if (r.status === 'covered') { covered += 1; wcov += w; }
      else if (r.status === 'partial') { partial += 1; wcov += w / 2; }
      else missing += 1;
    }
  }
  return { total, covered, partial, missing, pct: wsum ? Math.round((wcov / wsum) * 100) : null };
}
