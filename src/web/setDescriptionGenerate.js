// Set description auto-generation.
//
// Reads the beats that stage in one reusable set/location and runs a single
// single-tool LLM pass that writes the set's visual bible: several paragraphs
// of observable production language, written to ground image generation.
// Build context → call Anthropic with a forced
// tool → write the result through the gateway so an open CollabField watches
// the description replace itself live (y-doc), persisting to sets.description.

import { modelFor } from '../llm/modelSlots.js';
import { logger } from '../log.js';
import { getPlot } from '../mongo/plots.js';
import { getSet } from '../mongo/sets.js';
import { stripMarkdown } from '../util/markdown.js';
import { getAnthropic } from '../anthropic/client.js';
import { findBeatsReferencingSet, clipField } from './beatPlanShared.js';
import { setEntityFieldMarkdown } from './gateway.js';

// Bound the per-beat body text fed to the pass. Unlike clipField this keeps
// paragraph structure — beat bodies are multi-paragraph prose and the model
// reads staging out of the line breaks.
export const BEAT_BODY_CLIP = 6000;
// Token guard: a set staged in a long screenplay can reference dozens of
// beats; the first N by order carry the establishing material.
export const MAX_CONTEXT_BEATS = 12;

const WRITE_TOOL = {
  name: 'write_set_description',
  strict: true,
  description:
    'Return the visual description of this reusable set/location as an ordered list of paragraphs.',
  input_schema: {
    type: 'object',
    properties: {
      paragraphs: {
        type: 'array',
        items: {
          type: 'string',
          description: 'One visual paragraph, 1-6 sentences, purely observable production language.',
        },
        description:
          'One to six paragraphs, ordered by visual importance. Lead with the PRIMARY visual subject — whatever ' +
          'the beats actually dwell on — and give it the bulk of the description: its geography and ' +
          'layout, materials and textures, light sources and how light behaves at the times of day ' +
          'the beats use, palette and the physical causes of the atmosphere, plus any distinct ' +
          'sub-areas/corners the beats stage in. Secondary elements the beats only pass through, ' +
          'land on, or mention in passing get a single short paragraph or sentence at the end — ' +
          'never equal coverage.',
      },
    },
    required: ['paragraphs'],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = [
  'You are a production designer writing the visual bible for ONE reusable set/location',
  'of a screenplay. Your paragraphs are stored as the set\'s description and used verbatim',
  'to ground image generation (background plates, storyboard references), so every sentence',
  'must translate directly into pixels.',
  '',
  'Read the beats that stage in this set and describe only the PLACE — no characters, no',
  'story events, no proper names of people. Ground the description in what the beats',
  'actually use: the sub-locations, entrances, props, and times of day they stage. Where',
  'the beats are silent, invent details consistent with the story and the directorial voice.',
  '',
  'SCOPE — THE SET\'S NAME DECIDES WHAT YOU DESCRIBE: a beat often moves through several',
  'places, and each place is its own set. This set\'s name says which ONE of them it is.',
  'Before writing, mark the passages of each beat that happen in the place the name names',
  '(sluglines, mini-slugs and "we move to…" lines show where a beat changes place) and use',
  'ONLY those passages. Everything a beat stages somewhere else — another room, another',
  'building, the street outside, a vehicle, a different planet — belongs to another set and',
  'must not appear in this description at all: not its layout, not its props, not its light,',
  'not as a closing sentence. Each beat lists its other sets; those are the places to leave',
  'out. When the name is narrower than the beat (one room of a house the beat roams), describe',
  'only that room. When no passage of a beat happens in this set, take nothing from that beat.',
  'What is physically visible FROM this set (the view through its window, the lot seen from',
  'its doorway) is part of it, described only as seen from here.',
  '',
  'INTENT AND PROPORTION (inside that scope): identify the PRIMARY visual subject — the image',
  'the in-scope passages actually dwell on. A passage that opens on a starfield and only pans',
  'down to a building at the end is ABOUT the starfield: the starfield gets the paragraphs, the',
  'building gets one or two grounding sentences at the end — unless the set is named for the',
  'building, in which case the building is the subject. Never give a minor or transitional element — a',
  'place the camera merely passes, lands on, or mentions in passing — a full architectural',
  'treatment. The description\'s proportions must mirror the beats\' emphasis, because image',
  'plates are planned directly from this text: over-describing a minor element produces',
  'unwanted images of it.',
  '',
  'Write in observable production language. Words like cinematic, epic, moody, dramatic,',
  'beautiful, or atmospheric are banned: name the physical cause that would produce the',
  'feeling instead (a source and its direction, a contrast ratio, a specific color, a',
  'material behavior).',
].join('\n');

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// stripMarkdown + hard length bound that PRESERVES line structure (clipField
// collapses all whitespace — right for one-liners, wrong for beat prose).
export function clipBlock(raw, max = BEAT_BODY_CLIP) {
  const s = stripMarkdown(typeof raw === 'string' ? raw : '').trim();
  if (!s || s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

// The beat's roster minus this set: the places a multi-location beat stages
// that are NOT this one, so the pass knows what to leave out.
function otherSetNames(beat, selfLower) {
  const seen = new Set([selfLower]);
  const out = [];
  for (const raw of Array.isArray(beat?.sets) ? beat.sets : []) {
    const name = stripMarkdown(typeof raw === 'string' ? raw : '').trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function buildContext({ plot, set, beats, direction }) {
  const sections = [];

  const title = stripMarkdown(plot?.title || '').trim();
  const synopsis = stripMarkdown(plot?.synopsis || '').trim();
  if (title || synopsis) {
    const lines = ['# Story'];
    if (title) lines.push(`Title: ${title}`);
    if (synopsis) lines.push(`Logline: ${synopsis}`);
    sections.push(lines.join('\n'));
  }

  const voice = stripMarkdown(plot?.directorial_voice || '').trim();
  if (voice) {
    sections.push(
      ['# Directorial voice (project-wide)', 'Bias every visual choice toward this voice.', '', voice].join('\n'),
    );
  }

  const setName = stripMarkdown(set?.name || '').trim() || 'Untitled set';
  const setLines = [`# The set: ${setName}`];
  const existing = stripMarkdown(set?.description || '').trim();
  if (existing) {
    setLines.push(
      'Current description (you are replacing this — keep what still fits the place the name names; drop anything about another place):',
      '',
      existing,
    );
  }
  sections.push(setLines.join('\n'));

  if (beats.length) {
    const beatSections = [
      `# Beats linked to this set\nA beat may also stage in other places. Use only the passages that happen in "${setName}".`,
    ];
    const selfLower = setName.toLowerCase();
    for (const b of beats) {
      const name = stripMarkdown(b?.name || '').trim() || 'Untitled';
      const lines = [`## Beat #${b?.order ?? '?'}: ${name}`];
      const desc = clipField(b?.desc);
      if (desc) lines.push(desc);
      const others = otherSetNames(b, selfLower);
      if (others.length) {
        lines.push(`Other sets in this beat (their own places — leave them out): ${others.join('; ')}`);
      }
      const body = clipBlock(b?.body);
      if (body) lines.push('', body);
      beatSections.push(lines.join('\n'));
    }
    sections.push(beatSections.join('\n\n'));
  } else {
    sections.push(
      '# Beats\nNo beats are linked to this set yet — describe it from its name and current description alone.',
    );
  }

  const dir = String(direction || '').trim();
  if (dir) sections.push(['# Direction from the user', dir].join('\n'));

  return sections.join('\n\n');
}

export async function generateSetDescription({ projectId, setId, beatIds = [], direction = '' } = {}) {
  const set = await getSet(projectId, String(setId));
  if (!set) throw httpError(`set not found: ${setId}`, 404);

  const linked = await findBeatsReferencingSet(projectId, set);
  let beats = linked;
  const wanted = (beatIds || []).map(String).filter(Boolean);
  if (wanted.length) {
    const want = new Set(wanted);
    beats = linked.filter((b) => want.has(b._id.toString()));
    if (!beats.length) {
      throw httpError('none of the selected beats are linked to this set', 400);
    }
  }
  beats = beats.slice(0, MAX_CONTEXT_BEATS);

  const plot = await getPlot(projectId).catch(() => null);
  const userText = [
    buildContext({ plot, set, beats, direction }),
    '',
    `Write the visual description of THIS set — "${stripMarkdown(set?.name || '').trim() || 'Untitled set'}", and only the part of each beat that happens there — using the write_set_description tool.`,
  ].join('\n');

  const client = getAnthropic();
  const resp = await client.messages.create({
    model: modelFor('storyboard'),
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    tools: [WRITE_TOOL],
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  });

  const toolUse = (resp.content || []).find(
    (b) => b.type === 'tool_use' && b.name === 'write_set_description',
  );
  const paragraphs = (Array.isArray(toolUse?.input?.paragraphs) ? toolUse.input.paragraphs : [])
    .slice(0, 6)
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean);
  if (!paragraphs.length) {
    logger.warn('set description generate: model returned no usable paragraphs');
    throw new Error('Auto-generate failed: the model returned no description.');
  }

  const markdown = paragraphs.join('\n\n');
  const entityId = set._id.toString();
  // Through the gateway: broadcasts to the set:<id> room so an open
  // description CollabField replaces itself live, and persists to Mongo.
  await setEntityFieldMarkdown({
    projectId,
    entityType: 'set',
    entityId,
    field: 'description',
    markdown,
  });
  logger.info(
    `set description generate: wrote ${paragraphs.length} paragraphs for set ${entityId} from ${beats.length} beats`,
  );

  return { description: markdown, beats_used: beats.length };
}
