// Scene Bible auto-fill.
//
// Reads one beat (its prose + project context) and runs a single LLM pass that
// produces a compact, structured "look book" for the beat — the eight scene
// bible fields every shot inherits. Mirrors the one-shot forced-tool pattern in
// dialogCritique.js: build context → call Anthropic with a forced tool → coerce
// the result with normalizeSceneBible → write each field back through the
// gateway so connected SPA clients watch the fields populate live (y-doc),
// and the values persist to beats.$.scene_bible.

import { config } from '../config.js';
import { logger } from '../log.js';
import { getBeat, getPlot } from '../mongo/plots.js';
import { getDirectorNotes } from '../mongo/directorNotes.js';
import { SCENE_BIBLE_FIELDS, normalizeSceneBible } from '../mongo/sceneBible.js';
import { stripMarkdown } from '../util/markdown.js';
import { getAnthropic } from '../anthropic/client.js';
import { loadCharacterDocs, formatCharacterBio } from './dialogContext.js';
import { setEntityFieldMarkdown } from './gateway.js';
import { isBeatLocked, withBeatLock } from './beatLocks.js';
import { BeatBusyError } from './storyboardGenerate.js';

// Per-field guidance shown to the model. Keyed by field; the example phrasing
// mirrors the header comment in src/mongo/sceneBible.js so the model returns
// compact, comma-separated descriptors rather than prose.
const FIELD_GUIDANCE = Object.freeze({
  location: "Where the scene happens, concrete and specific. e.g. 'Corner diner, booth by the window'",
  time_of_day: "Time of day + weather/season context. e.g. 'Dusk, rain starting'",
  lighting_key: "Primary + fill light scheme. e.g. 'Cold blue fill + warm sodium practicals'",
  palette: "Color scheme / grade, a few descriptors. e.g. 'Teal, amber, wet asphalt grey'",
  mood: "Emotional tone of the scene. e.g. 'Quiet, waiting, unspoken tension'",
  blocking:
    "Character geography & spatial relationships (screen-left/right, foreground/background). " +
    "e.g. 'Sarah at booth screen-left; door + entrance screen-right behind her'",
  continuity_anchors:
    "Props, wardrobe, or weather that must stay constant across every shot of the scene. " +
    "e.g. 'Rain on windows throughout; Sarah's red coat; chipped coffee mug'",
  camera_language: "Shot grammar for the scene. e.g. 'Mostly locked-off; occasional slow push'",
});

const FILL_TOOL = {
  name: 'fill_scene_bible',
  description:
    'Return a complete scene bible for the beat: a compact value for every field. ' +
    'Each value is a short comma-separated phrase, not prose.',
  input_schema: {
    type: 'object',
    properties: SCENE_BIBLE_FIELDS.reduce((props, field) => {
      props[field] = { type: 'string', description: FIELD_GUIDANCE[field] };
      return props;
    }, {}),
    required: [...SCENE_BIBLE_FIELDS],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = [
  'You are a cinematographer and production designer building the visual "scene bible"',
  'for ONE beat of a screenplay. The scene bible is a compact look book that every',
  'storyboard shot of the beat inherits, so the scene stays visually unified.',
  '',
  'Read the beat and the project context, then fill in every field with the',
  'fill_scene_bible tool. Ground each field in what the beat actually depicts —',
  'infer sensible, evocative choices where the text is silent, but stay consistent',
  'with the story and characters. Keep each value to a short comma-separated phrase',
  '(a few words), never a paragraph. Always return all fields.',
].join('\n');

// Assemble the steering context for one beat: logline, the beat itself,
// character bios, and project-wide director's notes. Mirrors dialogContext's
// shape but is visual-look focused (no previous-beat dialogue / dialogue style).
export async function buildSceneBibleContext(projectId, beat) {
  const sections = [];

  const plot = await getPlot(projectId).catch(() => null);
  const title = stripMarkdown(plot?.title || '').trim();
  const synopsis = stripMarkdown(plot?.synopsis || '').trim();
  if (title || synopsis) {
    const lines = ['# Story'];
    if (title) lines.push(`Title: ${title}`);
    if (synopsis) lines.push(`Logline: ${synopsis}`);
    sections.push(lines.join('\n'));
  }

  const beatName = stripMarkdown(beat?.name || '').trim() || 'Untitled';
  const beatDesc = stripMarkdown(beat?.desc || '').trim();
  const beatBody = stripMarkdown(beat?.body || '').trim();
  const beatLines = [`# This beat — #${beat?.order ?? '?'}: ${beatName}`];
  if (beatDesc) beatLines.push(beatDesc);
  if (beatBody) beatLines.push('', beatBody);
  sections.push(beatLines.join('\n'));

  const characters = await loadCharacterDocs(projectId, beat?.characters || []).catch(() => []);
  const bios = characters.map(formatCharacterBio).filter(Boolean);
  if (bios.length) {
    sections.push(['# Characters in this story', bios.join('\n\n')].join('\n'));
  }

  const notesDoc = await getDirectorNotes(projectId).catch(() => null);
  const noteTexts = (notesDoc?.notes || [])
    .map((n) => stripMarkdown(n?.text || '').trim())
    .filter(Boolean);
  if (noteTexts.length) {
    sections.push(['# Director\'s notes', noteTexts.map((t) => `- ${t}`).join('\n')].join('\n'));
  }

  return sections.join('\n\n');
}

export async function autofillSceneBible({ projectId, beatId } = {}) {
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw new Error(`Beat not found: ${beatId}`);
  // Serialize with every other scene_bible writer (storyboard generation writes
  // the bible too). Fail fast if the beat is already busy, then hold the lock
  // across the LLM call + writes so a Generate can't clobber the result.
  if (isBeatLocked(beat._id)) throw new BeatBusyError(beat._id.toString());

  return withBeatLock(beat._id, async () => {
    const context = await buildSceneBibleContext(projectId, beat);
    const userText = [
      context,
      '',
      'Fill in the scene bible for THIS beat using the fill_scene_bible tool. Return every field.',
    ].join('\n');

    const client = getAnthropic();
    const resp = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [FILL_TOOL],
      tool_choice: { type: 'tool', name: 'fill_scene_bible' },
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    });

    const toolUse = (resp.content || []).find(
      (b) => b.type === 'tool_use' && b.name === 'fill_scene_bible',
    );
    if (!toolUse) {
      logger.warn('scene bible autofill: model did not call fill_scene_bible');
      throw new Error('Auto-fill failed: the model returned no scene bible.');
    }

    const sceneBible = normalizeSceneBible(toolUse.input);
    const entityId = beat._id.toString();
    // Write through the gateway so the change broadcasts to the live y-doc room
    // (open SceneBiblePanel CollabFields update themselves) and persists to Mongo.
    for (const field of SCENE_BIBLE_FIELDS) {
      await setEntityFieldMarkdown({
        projectId,
        entityType: 'beat',
        entityId,
        field: `scene_bible.${field}`,
        markdown: sceneBible[field],
      });
    }
    logger.info(
      `scene bible autofill: filled ${SCENE_BIBLE_FIELDS.length} fields for beat ${entityId}`,
    );

    return { scene_bible: sceneBible };
  });
}
