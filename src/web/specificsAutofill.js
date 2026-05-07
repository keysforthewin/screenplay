// specificsAutofill.js
//
// Uses Claude vision to fill in empty Specifics fields from a character's
// reference images. Writes only the fields that are currently empty — never
// overwrites human-entered values.
//
// Called by POST /api/character/:id/specifics/autofill in entityRoutes.js.
// Kept in its own module so it's testable in isolation (mock the Anthropic
// client and the gateway writes).

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../log.js';
import { SPECIFICS_FIELDS, SPECIFICS_FIELD_NAMES } from '../util/specifics.js';
import { readImageBuffer } from '../mongo/images.js';
import { getCharacter } from '../mongo/characters.js';
import { setEntityFieldMarkdown } from './gateway.js';

const ANTHROPIC_OK = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_RAW_BYTES = 4 * 1024 * 1024;

const AUTOFILL_TOOL = {
  name: 'fill_specifics',
  description:
    'Fill in technical character-sheet specifics fields based on the reference images provided. ' +
    'Only return values for fields you can clearly observe from the images. ' +
    'Leave a field as the empty string if it is not visible or you are not confident.',
  input_schema: {
    type: 'object',
    properties: SPECIFICS_FIELDS.reduce((acc, f) => {
      acc[f.name] = {
        type: 'string',
        description: f.placeholder,
      };
      return acc;
    }, {}),
    required: [],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT =
  'You are filling in technical character-sheet fields from a combination of ' +
  "reference images and the character's existing descriptive text. " +
  'Return values via the fill_specifics tool. ' +
  'Do not invent details that are not visible in the images and not stated in the descriptive text. ' +
  "When describing left/right asymmetries, always use the character's perspective. " +
  'Leave any field as the empty string if you cannot determine it from the source material.';

function buildCharacterTextContext(character) {
  const lines = [];
  const name = String(character?.name ?? '').trim();
  if (name) lines.push(`Character name: ${name}`);
  const actor = String(character?.hollywood_actor ?? '').trim();
  if (actor) lines.push(`Hollywood actor / face reference: ${actor}`);
  const fields = character?.fields || {};
  const fieldEntries = Object.entries(fields)
    .map(([k, v]) => [k, typeof v === 'string' ? v.trim() : String(v ?? '').trim()])
    .filter(([, v]) => v.length > 0);
  if (fieldEntries.length) {
    lines.push('');
    lines.push('Character description (from the Details tab):');
    for (const [k, v] of fieldEntries) {
      lines.push(`- ${k}: ${v}`);
    }
  }
  return lines.join('\n').trim();
}

function buildUserBlocks(currentSpecifics, imageInputs, textContext) {
  const lines = [];
  if (textContext) {
    lines.push('=== CHARACTER CONTEXT (descriptive text) ===');
    lines.push(textContext);
    lines.push('');
  }
  if (imageInputs.length) {
    lines.push(
      `=== REFERENCE IMAGES (${imageInputs.length}) attached below ===`,
    );
  }
  lines.push(
    'Fill in the empty fields by calling the `fill_specifics` tool. ' +
      'Do NOT modify fields that already have a value — return them as the empty string.',
  );
  lines.push('');
  lines.push('Current values (empty strings mean "please fill"):');
  for (const f of SPECIFICS_FIELDS) {
    const current = String(currentSpecifics?.[f.name] ?? '').trim();
    lines.push(`- ${f.name}: ${current ? JSON.stringify(current) : '""'}`);
  }
  lines.push('');
  lines.push('Field descriptions / examples:');
  for (const f of SPECIFICS_FIELDS) {
    lines.push(`- ${f.name}: ${f.placeholder}`);
  }
  const blocks = [{ type: 'text', text: lines.join('\n') }];
  for (const img of imageInputs) {
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mediaType,
        data: img.buffer.toString('base64'),
      },
    });
  }
  return blocks;
}

async function loadImageInputs(images) {
  const out = [];
  for (const meta of images || []) {
    const id = meta?._id?.toString?.() || String(meta?._id || '');
    if (!id) continue;
    const result = await readImageBuffer(id);
    if (!result) continue;
    const { buffer, file } = result;
    const mediaType = file.contentType || file.metadata?.contentType || meta.content_type;
    if (!ANTHROPIC_OK.has(mediaType)) {
      logger.info(`specifics autofill: skipping ${id} (unsupported type ${mediaType})`);
      continue;
    }
    if (buffer.length > MAX_RAW_BYTES) {
      logger.info(`specifics autofill: skipping ${id} (${buffer.length} > ${MAX_RAW_BYTES})`);
      continue;
    }
    out.push({ buffer, mediaType });
  }
  return out;
}

// Allow tests to inject a fake Anthropic client.
let anthropicFactory = () => new Anthropic({ apiKey: config.anthropic.apiKey });
export function _setAnthropicFactoryForTests(fn) {
  anthropicFactory = fn;
}

export async function autofillCharacterSpecifics({ characterId }) {
  const character = await getCharacter(characterId);
  if (!character) throw new Error(`Character not found: ${characterId}`);

  const cid = character._id.toString();
  const images = character.images || [];
  if (!images.length) {
    return { filled: [], reason: 'no_images' };
  }
  const imageInputs = await loadImageInputs(images);
  if (!imageInputs.length) {
    return { filled: [], reason: 'no_eligible_images' };
  }

  const textContext = buildCharacterTextContext(character);
  const client = anthropicFactory();
  const resp = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: [AUTOFILL_TOOL],
    tool_choice: { type: 'tool', name: 'fill_specifics' },
    messages: [
      {
        role: 'user',
        content: buildUserBlocks(character.specifics || {}, imageInputs, textContext),
      },
    ],
  });

  const toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'fill_specifics');
  if (!toolUse) {
    logger.warn('specifics autofill: model did not call fill_specifics tool');
    return { filled: [], reason: 'no_tool_call' };
  }
  const proposed = toolUse.input || {};

  // Re-read the character so we don't clobber values that were written during
  // the model call. Also lets the caller trust that "filled" = wrote new data.
  const fresh = await getCharacter(cid);
  const current = fresh?.specifics || {};
  const filled = [];
  for (const name of SPECIFICS_FIELD_NAMES) {
    const proposedVal = String(proposed[name] ?? '').trim();
    if (!proposedVal) continue;
    const existing = String(current[name] ?? '').trim();
    if (existing) continue; // never overwrite
    await setEntityFieldMarkdown({
      entityType: 'character',
      entityId: cid,
      field: `specifics.${name}`,
      markdown: proposedVal,
    });
    filled.push(name);
  }

  logger.info(
    `specifics autofill: character=${cid} images=${imageInputs.length} filled=[${filled.join(',')}]`,
  );
  return { filled };
}
