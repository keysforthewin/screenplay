// Backfilling the wardrobe lock (src/web/wardrobe.js) for characters created
// before the `wardrobe` template field existed. For each character the script
// (scripts/backfill-wardrobe.js) gathers what the project already says about
// them — the character card, the beat that introduces them in full, and the
// paragraphs of the next beats that mention them — and asks the writer model
// for ONE outfit in the lock's own form: concrete garments, colours and
// footwear, ≤ WARDROBE_TEXT_MAX chars, no prose. The answer carries the quotes
// it rests on, and says when the clothes had to be invented from the
// description alone, so a dry run can be read before anything is written.
import { modelFor } from '../llm/modelSlots.js';
import { getAnthropic } from '../anthropic/client.js';
import { recordAnthropicTextUsage } from '../mongo/tokenUsage.js';
import { stripMarkdown } from '../util/markdown.js';
import { formatCharacterFull } from './beatContext.js';
import { WARDROBE_FIELD, WARDROBE_TEXT_MAX } from './wardrobe.js';

export const INTRO_BEAT_MAX_CHARS = 14000;
export const MENTION_BEATS = 4;
export const MENTION_PARAGRAPHS_PER_BEAT = 6;
export const MENTION_PARAGRAPH_MAX_CHARS = 600;

const WARDROBE_SYSTEM_PROMPT = [
  'You are the costume designer on a film. You are given one character — their card from the screenplay database and the pages where they appear — and you write the ONE outfit this character is locked into for every picture of them.',
  '',
  'Rules for the wardrobe text:',
  `- At most ${WARDROBE_TEXT_MAX} characters. One sentence or a comma-separated list. No name, no personality, no story — clothes only.`,
  '- Concrete and reproducible: every garment with its colour and material or cut, footwear, and any worn accessory that reads on screen (glasses, a cap, a lanyard, a watch, a bag). Nothing an image model cannot draw.',
  '- The outfit the pages describe wins. Quote every garment the text gives in `evidence`, with the beat it comes from. If a beat shows a change of clothes, lock the outfit from the beat that INTRODUCES the character (the first one given) and ignore the rest.',
  '- When the pages say nothing about clothes, invent an outfit from the card — age, job, era, class, place, season, the kind of person they are — and set `invented` to true. Keep it specific and ordinary for that person; no costume-drama flourishes, no logos, no text on clothing.',
  '- Never describe the face, hair, body or expression. The lock covers clothing only.',
].join('\n');

export const WARDROBE_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      wardrobe: { type: 'string' },
      invented: { type: 'boolean' },
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          properties: { beat: { type: 'string' }, quote: { type: 'string' } },
          required: ['beat', 'quote'],
          additionalProperties: false,
        },
      },
    },
    required: ['wardrobe', 'invented', 'evidence'],
    additionalProperties: false,
  },
};

function plainName(c) {
  return stripMarkdown(String(c?.name || '')).replace(/\s+/g, ' ').trim();
}

function nameKey(s) {
  return stripMarkdown(String(s || '')).replace(/\s+/g, ' ').trim().toLowerCase();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A word-boundary matcher for the character's name and its first word (a
// screenplay refers to "Steve Keys" as STEVE after the introduction).
export function nameMatcher(name) {
  const full = plainName({ name });
  if (!full) return null;
  const parts = [full];
  const first = full.split(' ')[0];
  if (first && first.length >= 3 && first !== full) parts.push(first);
  return new RegExp(`(^|[^\\p{L}\\p{N}])(${parts.map(escapeRe).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'iu');
}

// stripMarkdown flattens newlines; a screenplay page needs its lines
// (sluglines, action, dialogue) kept apart, so strip line by line.
export function plainBody(body) {
  return String(body || '').split('\n').map((l) => stripMarkdown(l).replace(/[ \t]+/g, ' ').trimEnd()).join('\n').trim();
}

function clipText(s, max) {
  const t = String(s || '').trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}\n[… ${t.length - max} more characters cut]` : t;
}

// The beats that carry this character, in script order: the roster
// (`beat.characters`, by stripped name) first, else a body mention. The
// first is the introduction.
export function beatsForCharacter(beats, character) {
  const key = nameKey(character?.name);
  const re = nameMatcher(character?.name);
  const out = [];
  for (const beat of [...(beats || [])].sort((a, b) => (a.order || 0) - (b.order || 0))) {
    const rostered = (beat.characters || []).some((n) => nameKey(n) === key);
    const body = String(beat.body || '');
    const mentioned = !rostered && re ? re.test(plainBody(body)) : false;
    if (rostered || mentioned) out.push({ beat, rostered });
  }
  return out;
}

// The paragraphs of a beat that name the character — what later beats
// contribute without pasting them whole.
export function mentionParagraphs(beat, character, { limit = MENTION_PARAGRAPHS_PER_BEAT } = {}) {
  const re = nameMatcher(character?.name);
  if (!re) return [];
  const paragraphs = plainBody(beat?.body).split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = [];
  for (const p of paragraphs) {
    if (!re.test(p)) continue;
    out.push(p.length > MENTION_PARAGRAPH_MAX_CHARS ? `${p.slice(0, MENTION_PARAGRAPH_MAX_CHARS).trimEnd()}…` : p);
    if (out.length >= limit) break;
  }
  return out;
}

// Everything the prompt needs for one character — pure, so a dry run can
// print it and a test can pin it. `intro` is null when no beat carries the
// character (the outfit is then invented from the card alone).
export function collectWardrobeContext({ plot, character }) {
  const appearances = beatsForCharacter(plot?.beats || [], character);
  const intro = appearances[0] || null;
  const later = appearances.slice(1, 1 + MENTION_BEATS)
    .map(({ beat }) => ({ beat, paragraphs: mentionParagraphs(beat, character) }))
    .filter((x) => x.paragraphs.length);
  return {
    name: plainName(character),
    current: stripMarkdown(String(character?.fields?.[WARDROBE_FIELD] || '')).trim(),
    intro,
    later,
    appearanceCount: appearances.length,
  };
}

export function buildWardrobePrompt({ plot, character, context }) {
  const ctx = context || collectWardrobeContext({ plot, character });
  const beatLabel = (b) => `beat ${b.order}${b.name ? ` "${stripMarkdown(b.name)}"` : ''}`;
  const parts = [];
  const title = stripMarkdown(String(plot?.title || '')).trim();
  const synopsis = stripMarkdown(String(plot?.synopsis || '')).trim();
  if (title || synopsis) parts.push(`# The film${title ? `: ${title}` : ''}\n${clipText(synopsis, 1500) || '(no synopsis)'}`);
  // The card without a wardrobe line (the one being written), via the same
  // formatter the planners read.
  const card = formatCharacterFull({ ...character, fields: { ...(character?.fields || {}), [WARDROBE_FIELD]: '' } });
  parts.push(`# The character\n${card}`);
  if (ctx.intro) {
    const { beat, rostered } = ctx.intro;
    parts.push(`# The beat that introduces ${ctx.name} — ${beatLabel(beat)}${rostered ? '' : ' (named in the text, not on the roster)'}\n${clipText(plainBody(beat.body), INTRO_BEAT_MAX_CHARS) || '(empty)'}`);
  } else {
    parts.push(`# Appearances\n${ctx.name} is not in any beat yet. Invent the outfit from the card.`);
  }
  for (const { beat, paragraphs } of ctx.later) {
    parts.push(`# Later, ${beatLabel(beat)} — the paragraphs naming ${ctx.name}\n${paragraphs.map((p) => `- ${p}`).join('\n')}`);
  }
  if (ctx.appearanceCount > 1 + ctx.later.length) {
    parts.push(`(${ctx.name} appears in ${ctx.appearanceCount} beats in all; the rest are not shown.)`);
  }
  parts.push(`Write the locked wardrobe for ${ctx.name}.`);
  return parts.join('\n\n');
}

// Pure: the model's answer → {wardrobe, invented, evidence}, the text clipped
// to the lock's limit and flattened to one line.
export function normalizeWardrobeAnswer(raw) {
  const text = stripMarkdown(typeof raw?.wardrobe === 'string' ? raw.wardrobe : '').replace(/\s+/g, ' ').trim();
  const wardrobe = text.length > WARDROBE_TEXT_MAX ? `${text.slice(0, WARDROBE_TEXT_MAX - 1).trimEnd()}…` : text;
  const evidence = (Array.isArray(raw?.evidence) ? raw.evidence : [])
    .map((e) => ({ beat: String(e?.beat || '').trim(), quote: String(e?.quote || '').replace(/\s+/g, ' ').trim() }))
    .filter((e) => e.quote)
    .slice(0, 8);
  return { wardrobe, invented: raw?.invented === true || evidence.length === 0, evidence };
}

let proposerOverride = null;
// Test seam: async ({prompt, slot}) → raw answer object.
export function _setWardrobeProposerForTests(fn) {
  proposerOverride = typeof fn === 'function' ? fn : null;
}

async function askModel({ prompt, slot }) {
  if (proposerOverride) return proposerOverride({ prompt, slot });
  const model = modelFor(slot);
  const resp = await getAnthropic().messages.create({
    model,
    max_tokens: 2000,
    system: WARDROBE_SYSTEM_PROMPT,
    output_config: { format: WARDROBE_FORMAT },
    messages: [{ role: 'user', content: prompt }],
  });
  await recordAnthropicTextUsage({
    discordUser: null,
    channelId: null,
    model,
    totals: { input_tokens: Number(resp?.usage?.input_tokens) || 0, output_tokens: Number(resp?.usage?.output_tokens) || 0 },
  }).catch(() => {});
  const text = (resp?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) throw new Error(`empty answer from ${model}`);
  return JSON.parse(text);
}

// One character → {name, context, prompt, wardrobe, invented, evidence}.
export async function proposeWardrobe({ plot, character, slot = 'writer' }) {
  const context = collectWardrobeContext({ plot, character });
  const prompt = buildWardrobePrompt({ plot, character, context });
  const answer = normalizeWardrobeAnswer(await askModel({ prompt, slot }));
  if (!answer.wardrobe) throw new Error(`the model returned no wardrobe for ${context.name}`);
  return { name: context.name, context, prompt, ...answer };
}
