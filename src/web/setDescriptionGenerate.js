// Set description auto-generation.
//
// Reads the beats that stage in one reusable set/location and runs a single
// forced-tool LLM pass that writes the set's visual bible: several paragraphs
// of observable production language, written to ground image generation.
// Mirrors sceneBibleAutofill.js: build context → call Anthropic with a forced
// tool → write the result through the gateway so an open CollabField watches
// the description replace itself live (y-doc), persisting to sets.description.

import { config } from '../config.js';
import { logger } from '../log.js';
import { getPlot } from '../mongo/plots.js';
import { getSet } from '../mongo/sets.js';
import { stripMarkdown } from '../util/markdown.js';
import { getAnthropic } from '../anthropic/client.js';
import { findBeatsReferencingSet, clipField } from './storyboardGenerate.js';
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
  description:
    'Return the visual description of this reusable set/location as an ordered list of paragraphs.',
  input_schema: {
    type: 'object',
    properties: {
      paragraphs: {
        type: 'array',
        minItems: 2,
        maxItems: 6,
        items: {
          type: 'string',
          description: 'One visual paragraph, 3-6 sentences, purely observable production language.',
        },
        description:
          'Several paragraphs covering, in order: (1) overall geography, layout and architecture; ' +
          '(2) materials, textures, set dressing and key props; (3) light sources and how light ' +
          'behaves at the times of day the beats use; (4) palette and the physical causes of the ' +
          "atmosphere; optionally distinct sub-areas/corners the beats stage in.",
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
    setLines.push('Current description (you are replacing this — keep what still fits):', '', existing);
  }
  sections.push(setLines.join('\n'));

  if (beats.length) {
    const beatSections = ['# Beats that take place in this set'];
    for (const b of beats) {
      const name = stripMarkdown(b?.name || '').trim() || 'Untitled';
      const lines = [`## Beat #${b?.order ?? '?'}: ${name}`];
      const desc = clipField(b?.desc);
      if (desc) lines.push(desc);
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
    'Write the visual description of THIS set using the write_set_description tool.',
  ].join('\n');

  const client = getAnthropic();
  const resp = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    tools: [WRITE_TOOL],
    tool_choice: { type: 'tool', name: 'write_set_description' },
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  });

  const toolUse = (resp.content || []).find(
    (b) => b.type === 'tool_use' && b.name === 'write_set_description',
  );
  const paragraphs = (Array.isArray(toolUse?.input?.paragraphs) ? toolUse.input.paragraphs : [])
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
