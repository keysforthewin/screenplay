// Deterministic lint for a cut's prose block, from Emily's rendered findings
// (docs/video-prompting-notes.md §2 block shape, §3 trap phrases, §4 emotion,
// §7 anti-slop). Pure: no I/O. Every finding is severity 'warn' — lint never
// blocks generation; it tells the user what a video model will misread.
//
// The cut shape is the Mongo cut row: `prompt` (the full prose block the
// video model receives, lock line and ending included), `lock_line`,
// `exclusions[]`, `in_frame[]`. `coveredDialogs` are the dialog docs for the
// cut's dialog_ids so the words-never-in-a-prompt rule can be checked.

import { stripMarkdown } from '../util/markdown.js';
import { cameraTravels } from './cutTiming.js';

export const TRAP_PHRASES = Object.freeze([
  'his face fell',
  'her face fell',
  'the smile goes',
  'a look that could',
  'like someone',
  'as if',
  'his face darkens',
  'her face darkens',
  'the air freezes',
  'time stands still',
  'nothing else in the frame moves',
  'stay still for the whole shot',
  'does not move',
  'nobody moves',
]);

export const EMPTY_EVALUATORS = Object.freeze([
  'cinematic',
  'epic',
  'stunning',
  'breathtaking',
  'beautiful',
  'gorgeous',
  'dramatic',
  'dynamic',
  'moody',
  'atmospheric',
  'evocative',
  'striking',
  'hauntingly',
  'masterpiece',
  'award-winning',
  'vibey',
  'vibes',
]);

export const IMAGE_MODEL_TOKENS = Object.freeze([
  '8K',
  'ultra-HD',
  'hyper-detailed',
  'photorealistic',
  'high quality',
  'Unreal Engine',
  'octane render',
  'trending on artstation',
  '4K resolution',
]);

export const FEELING_WORDS = Object.freeze([
  'sad',
  'angry',
  'furious',
  'nervous',
  'anxious',
  'happy',
  'devastated',
  'terrified',
  'afraid',
  'scared',
  'tense',
  'grief',
  'grieving',
  'betrayed',
  'guilty',
  'ashamed',
  'embarrassed',
  'hurt',
  'jealous',
  'relieved',
  'hopeful',
  'desperate',
  'lonely',
  'bored',
  'confused',
  'excited',
  'proud',
  'disgusted',
  'surprised',
  'shocked',
  'worried',
  'heartbroken',
  'uneasy',
]);

// Adverb forms of the feeling words: a feeling standing alone, dressed as a
// manner ("she says it furiously").
export const FEELING_ADVERBS = Object.freeze([
  'sadly',
  'angrily',
  'furiously',
  'nervously',
  'anxiously',
  'happily',
  'guiltily',
  'jealously',
  'hopefully',
  'desperately',
  'proudly',
  'excitedly',
  'worriedly',
  'uneasily',
  'tensely',
  'fearfully',
  'shamefully',
]);

// Negations that are NOT faults: the three official templates plus the
// dialogue stabiliser and the "one continuous hold" marker.
export const ALLOWED_NEGATIONS = Object.freeze([
  'no music during the line',
  'no music',
  'no subtitles',
  'no logo',
  'no watermark',
  'no cuts',
  'no text',
]);

const LIGHT_WORDS = [
  'light',
  'lamp',
  'tungsten',
  'sodium',
  'neon',
  'sun',
  'sunlight',
  'daylight',
  'window',
  'tube',
  'fluorescent',
  'candle',
  'practical',
  'moon',
  'fire',
  'screen glow',
  'overhead',
  'key',
];

const NEGATION_RE = /\b(no|not|never|nothing|nobody|don't|doesn't|does not|do not|without|cannot|can't)\b/i;
const ENDING_RE = /\b(end with|end on|ends with|ends on|stop when|hold on|hold this|hold the)\b/i;
const FADE_RE = /\bfade (out|to black|in)\b/i;
const INVOLUNTARY_RE = /\b(slips|trips|spills|drops it|stumbles|catches (his|her|their) (coat|sleeve|foot))\b/i;
const TIMESTAMP_RES = [
  /\b\d+(?:\.\d+)?\s*(?:s|sec|secs|second|seconds)\b/i,
  /\b\d+:\d\d\b/,
  /\bfor the (?:first|last|next) \d+ seconds\b/i,
];
// A decade is not a length: "boxy 1980s sedans", "an '80s arcade cabinet".
const DECADE_RE = /\b(?:1[89]|20)\d0s\b|['’]\d0s\b|\bthe \d0s\b/gi;
const BRACKET_RE = /\[[^\]]*\]|[[\]]/;
// A travelling camera (cutTiming.js): the sentence that carries the move, the
// words that make a model brake it, and the words that give it a speed.
const CAMERA_MOVE_RE = /\b(camera|pan|pans|panning|tilt|tilts|tilting|truck|trucks|trucking|track|tracks|tracking|crane|cranes|craning|push|pushes|pushing|pull|pulls|pulling|dolly|dollies)\b/i;
const CAMERA_SETTLE_RE = /\b(settles?|settling|comes? to (?:a )?rest|coming to rest|comes? to a (?:stop|halt)|eases? (?:in|out|to|into)|easing|slows?(?: down)? to a (?:stop|halt)|slows down|slowing|decelerat\w*|stops? on)\b/i;
const CAMERA_SPEED_RE = /\b(slow|slowly|even|evenly|steady|steadily|unhurried|constant|brisk|briskly|fast|quick|quickly|gentle|gently|speed|pace)\b/i;
// Faster than one frame-width in this many seconds reads as a whip.
const MIN_SECONDS_PER_FRAME_WIDTH = 3;
const SLIDING_MOVES = ['pan', 'tilt', 'truck', 'track', 'crane'];
const MAX_SLIDE_WIDTHS = 0.5;
// An accident written by the accident rules says that it is one.
const ACCIDENT_FORM_RE = /\b(by accident|accidentally|unnoticed|forgotten|on its own)\b/i;

const MAX_WORDS = 220;
const MIN_WORDS = 35;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordRe(phrase, flags = 'i') {
  return new RegExp(`\\b${escapeRe(phrase)}\\b`, flags);
}

function normWs(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function normWords(s) {
  return stripMarkdown(String(s || ''))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function removeAll(haystack, needle) {
  const n = normWs(needle);
  if (!n) return haystack;
  let out = haystack;
  let idx = out.toLowerCase().indexOf(n.toLowerCase());
  while (idx >= 0) {
    out = `${out.slice(0, idx)} ${out.slice(idx + n.length)}`;
    idx = out.toLowerCase().indexOf(n.toLowerCase());
  }
  return out;
}

function firstNameToken(character) {
  const clean = stripMarkdown(String(character || '')).trim();
  return clean ? clean.split(/\s+/)[0] : '';
}

function finding(code, message) {
  return { code, severity: 'warn', message };
}

export function lintCut(cut, { coveredDialogs = [] } = {}) {
  const out = [];
  const prompt = normWs(cut?.prompt);
  const lockLine = normWs(cut?.lock_line);
  const exclusions = Array.isArray(cut?.exclusions) ? cut.exclusions.map(normWs).filter(Boolean) : [];
  const inFrame = Array.isArray(cut?.in_frame) ? cut.in_frame : [];

  // §3 trap phrases — the linter fails a block on these.
  for (const phrase of TRAP_PHRASES) {
    if (wordRe(phrase).test(prompt)) {
      out.push(
        finding(
          'trap_phrase',
          `"${phrase}" renders literally. Write what the camera records instead — a plain feeling word as a label on one physical anchor.`,
        ),
      );
    }
  }

  // §4 a feeling standing alone. Allowed form: the feeling word immediately
  // followed by a comma ("embarrassed, the polite smile fades").
  const feelingAlt = FEELING_WORDS.map(escapeRe).join('|');
  const copulaRe = new RegExp(
    `\\b(?:is|feels|looks|seems|was|were|are)\\s+(?:very\\s+|so\\s+)?(${feelingAlt})\\b(?!\\s*,)`,
    'gi',
  );
  const moodRe = new RegExp(`\\b(${feelingAlt})\\s+(?:atmosphere|mood|air|silence)\\b`, 'gi');
  const adverbRe = new RegExp(`\\b(${FEELING_ADVERBS.map(escapeRe).join('|')})\\b`, 'gi');
  const flaggedFeelings = new Set();
  for (const re of [copulaRe, moodRe, adverbRe]) {
    let m;
    while ((m = re.exec(prompt))) {
      flaggedFeelings.add(m[1].toLowerCase());
    }
  }
  for (const word of flaggedFeelings) {
    out.push(
      finding(
        'bare_feeling',
        `"${word}" has no pixels on its own. Write the feeling as a label on an anchor: 'embarrassed, the polite smile fades and he swallows'.`,
      ),
    );
  }

  // §2 no brackets, no seconds inside a block.
  if (BRACKET_RE.test(prompt)) {
    out.push(
      finding(
        'bracket',
        'Square brackets are not prose. Write the cut and camera in words at the start of the block: "Medium shot from the counter side:".',
      ),
    );
  }
  const undated = prompt.replace(DECADE_RE, '');
  if (TIMESTAMP_RES.some((re) => re.test(undated))) {
    out.push(
      finding(
        'timestamp',
        'Seconds inside a block destabilise the model. Duration is the API parameter; write felt length as behaviour ("hold on the settled fan for one beat").',
      ),
    );
  }

  // §7 anti-slop classes.
  for (const word of EMPTY_EVALUATORS) {
    if (wordRe(word).test(prompt)) {
      out.push(
        finding(
          'empty_evaluator',
          `"${word}" is an evaluation, not a direction. Replace it with the framing, light, pacing or blocking that made you reach for it.`,
        ),
      );
    }
  }
  for (const token of IMAGE_MODEL_TOKENS) {
    if (wordRe(token).test(prompt)) {
      out.push(
        finding(
          'image_model_token',
          `"${token}" is an image-model token. Resolution and quality are delivery parameters, not prompt text — delete it.`,
        ),
      );
    }
  }

  // Negation outside the two sanctioned positions (reference non-transfer
  // clauses live in reference_binding, clip-scope exclusions in exclusions[]).
  let body = prompt;
  body = removeAll(body, lockLine);
  for (const ex of exclusions) body = removeAll(body, ex);
  for (const phrase of [...ALLOWED_NEGATIONS].sort((a, b) => b.length - a.length)) {
    body = body.replace(wordRe(phrase, 'gi'), ' ');
  }
  const seenNeg = new Set();
  for (const sentence of splitSentences(body)) {
    if (!NEGATION_RE.test(sentence)) continue;
    const key = sentence.toLowerCase();
    if (seenNeg.has(key)) continue;
    seenNeg.add(key);
    const shown = sentence.length > 120 ? `${sentence.slice(0, 117)}…` : sentence;
    out.push(
      finding(
        'negation_in_body',
        `Naming a thing plants it: "${shown}" — write the positive state instead, or move a clip-scope exclusion into the exclusions list.`,
      ),
    );
  }

  // §2 / §3 the lock line, in every cut.
  if (!lockLine || !prompt.toLowerCase().includes(lockLine.toLowerCase())) {
    out.push(
      finding(
        'lock_line_missing',
        'Every cut ends with a lock line — the light source and colour, each principal\'s identity and position relative to a landmark, which way they face, and the camera side — in the same words as the other cuts.',
      ),
    );
  }
  if (lockLine) {
    const lockLower = lockLine.toLowerCase();
    if (!LIGHT_WORDS.some((w) => wordRe(w).test(lockLower))) {
      out.push(
        finding(
          'lock_line_light',
          'The lock line names no light source. Start it with the source and its colour: "Same light: one warm tungsten lamp overhead."',
        ),
      );
    }
    for (const p of inFrame) {
      const first = firstNameToken(p?.character);
      if (!first) continue;
      if (!wordRe(first).test(lockLine)) {
        out.push(
          finding(
            'lock_line_principal',
            `The lock line does not restate ${first}. The model keeps nothing across a cut that the prompt does not repeat — add age band, hair, wardrobe, position and facing for ${first}.`,
          ),
        );
      }
    }
    if (inFrame.length && !/\bfacing\b/i.test(lockLine)) {
      out.push(
        finding(
          'lock_line_facing',
          'The lock line does not say which way each principal faces ("seated in the window booth, facing the door").',
        ),
      );
    }
    if (!/\bcamera\b/i.test(lockLine)) {
      out.push(
        finding(
          'lock_line_camera_side',
          'The lock line does not name the camera side ("Camera on the counter side.").',
        ),
      );
    }
  }

  // §2 ending inside the frame.
  if (!ENDING_RE.test(prompt)) {
    out.push(
      finding(
        'ending_missing',
        'End inside the frame the cut can see: "End with …", "Stop when …", or "Hold on this frame as …".',
      ),
    );
  }
  if (FADE_RE.test(prompt)) {
    out.push(
      finding(
        'fade_out',
        'Never "fade out" — it is an edit, not a frame. Write what the last frame holds instead.',
      ),
    );
  }
  const sentences = splitSentences(prompt);
  const last = sentences.length ? sentences[sentences.length - 1] : '';
  if (last && INVOLUNTARY_RE.test(last) && !ACCIDENT_FORM_RE.test(prompt)) {
    out.push(
      finding(
        'involuntary_endpoint',
        'An involuntary outcome as the endpoint (a slip, a spill, a coat caught in a door) is staged as a deliberate act. Write it as an accident — where the attention stays, the grip going slack, the object leaving on its own, where it lands — and end on the result.',
      ),
    );
  }

  // A travelling camera: one even speed, no braking, and a length that fits
  // how far the frame moves (cutRules.js CAMERA_TRAVEL_RULES).
  if (cameraTravels(cut)) {
    const moveSentences = sentences.filter((sentence) => CAMERA_MOVE_RE.test(sentence));
    const braked = moveSentences.find((sentence) => CAMERA_SETTLE_RE.test(sentence));
    if (braked) {
      const shown = braked.length > 120 ? `${braked.slice(0, 117)}…` : braked;
      out.push(
        finding(
          'camera_settle',
          `"${shown}" tells the model to brake the move, and it eases the whole cut to obey. Name the framing the move has reached and keep it travelling: "End with the marquee filling the frame, the tilt still moving at the same slow speed."`,
        ),
      );
    }
    if (!moveSentences.some((sentence) => CAMERA_SPEED_RE.test(sentence))) {
      out.push(
        finding(
          'camera_speed_missing',
          'The camera moves but the block gives it no speed. Say it: "already panning right at one slow, even speed".',
        ),
      );
    }
    const widths = Number(cut?.camera?.travel_widths);
    const seconds = Number(cut?.duration_seconds);
    if (Number.isFinite(widths) && widths > 0 && Number.isFinite(seconds) && seconds > 0 && seconds / widths < MIN_SECONDS_PER_FRAME_WIDTH) {
      out.push(
        finding(
          'camera_fast',
          `The frame travels ${widths} frame-width${widths === 1 ? '' : 's'} in ${seconds} s — faster than one in ${MIN_SECONDS_PER_FRAME_WIDTH} s reads as a whip. Lengthen the cut or narrow the travel.`,
        ),
      );
    }
  }

  // A sliding move's two stills must overlap: the end still is the start still
  // slid by the travel, and more than half a frame leaves too little to anchor.
  if (SLIDING_MOVES.includes(cut?.camera?.movement)) {
    const widths = Number(cut?.camera?.travel_widths);
    if (Number.isFinite(widths) && widths > MAX_SLIDE_WIDTHS) {
      out.push(
        finding(
          'pan_no_overlap',
          `The frame travels ${widths} frame-width${widths === 1 ? '' : 's'}: the two stills share too little, so the end frame is rendered as only half a frame of travel. Narrow the travel to ${MAX_SLIDE_WIDTHS} or cover the rest in another cut.`,
        ),
      );
    }
  }

  // Words never enter a prompt: real voices are recorded and lip-synced.
  const promptWords = normWords(prompt);
  const lines = Array.isArray(coveredDialogs) ? coveredDialogs : [];
  for (const line of lines) {
    const lineNorm = normWords(line?.body);
    const words = lineNorm ? lineNorm.split(' ') : [];
    if (words.length < 4) continue;
    let hit = promptWords.includes(lineNorm);
    if (!hit && words.length >= 5) {
      for (let i = 0; i + 5 <= words.length && !hit; i++) {
        hit = promptWords.includes(words.slice(i, i + 5).join(' '));
      }
    }
    if (hit) {
      const speaker = stripMarkdown(String(line?.character || '')).trim() || 'a character';
      out.push(
        finding(
          'dialogue_words',
          `${speaker}'s line appears in the prompt. The words are recorded by the actor and lip-synced in post — write the speaker tag, the voice, the eyes and what the face does after the last word instead.`,
        ),
      );
    }
  }

  // §7 length.
  const wc = countWords(prompt);
  if (wc > MAX_WORDS) {
    out.push(
      finding(
        'too_long',
        `${wc} words. Cut duplicate style adjectives, generic quality words, background detail the references already show, secondary camera moves and secondary actions — never the lock line, a stated position or a feeling word.`,
      ),
    );
  } else if (wc < MIN_WORDS) {
    out.push(
      finding(
        'too_short',
        `${wc} words. A cut block carries the camera in words, one action with its anchor, the others' idle business, a Sound line, the lock line and an ending — this one is missing most of them.`,
      ),
    );
  }

  return out;
}

export function summarizeLint(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const codes = {};
  for (const f of list) {
    if (!f?.code) continue;
    codes[f.code] = (codes[f.code] || 0) + 1;
  }
  return { count: list.length, codes };
}
