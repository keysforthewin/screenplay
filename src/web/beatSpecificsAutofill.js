// beatSpecificsAutofill.js
//
// Mirror of specificsAutofill.js for *beats* (scenes). Reads the beat's
// name/desc/body text plus any attached reference images, and asks Claude
// vision to fill empty entries on the beat's `specifics.*` subdoc.
//
// Unlike the character flow, this works with text alone — beats often have
// rich body text but no images. Bails only when there is neither text nor
// eligible images to send.

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../log.js';
import { BEAT_SPECIFICS_FIELDS, BEAT_SPECIFICS_FIELD_NAMES } from '../util/beatSpecifics.js';
import { readImageBuffer } from '../mongo/images.js';
import { getBeat } from '../mongo/plots.js';
import { setEntityFieldMarkdown } from './gateway.js';

const ANTHROPIC_OK = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_RAW_BYTES = 4 * 1024 * 1024;

const AUTOFILL_TOOL = {
  name: 'fill_specifics',
  description:
    'Fill in technical scene-reference fields based on the beat description and any reference images provided. ' +
    'Only return values that are clearly stated in the description or visible in the images. ' +
    'Leave a field as the empty string if it is not stated and not visible.',
  input_schema: {
    type: 'object',
    properties: BEAT_SPECIFICS_FIELDS.reduce((acc, f) => {
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
  'You are filling in technical scene-reference fields from a combination of ' +
  'the beat description (name + summary + body text) and any attached reference images. ' +
  'Return values via the fill_specifics tool. ' +
  'Do not invent details that are not stated in the text and not visible in the images. ' +
  'Leave any field as the empty string if you cannot determine it from the source material.';

function buildBeatTextContext(beat) {
  const lines = [];
  const name = String(beat?.name ?? '').trim();
  const desc = String(beat?.desc ?? '').trim();
  const body = String(beat?.body ?? '').trim();
  if (name) lines.push(`Scene name: ${name}`);
  if (desc) {
    lines.push('');
    lines.push('Scene short description:');
    lines.push(desc);
  }
  if (body) {
    lines.push('');
    lines.push('Scene body (full text from the Details tab):');
    lines.push(body);
  }
  return lines.join('\n').trim();
}

function buildUserBlocks(currentSpecifics, imageInputs, textContext) {
  const lines = [];
  if (textContext) {
    lines.push('=== SCENE CONTEXT (descriptive text) ===');
    lines.push(textContext);
    lines.push('');
  }
  if (imageInputs.length) {
    lines.push(`=== REFERENCE IMAGES (${imageInputs.length}) attached below ===`);
  }
  lines.push(
    'Fill in the empty fields by calling the `fill_specifics` tool. ' +
      'Do NOT modify fields that already have a value — return them as the empty string.',
  );
  lines.push('');
  lines.push('Current values (empty strings mean "please fill"):');
  for (const f of BEAT_SPECIFICS_FIELDS) {
    const current = String(currentSpecifics?.[f.name] ?? '').trim();
    lines.push(`- ${f.name}: ${current ? JSON.stringify(current) : '""'}`);
  }
  lines.push('');
  lines.push('Field descriptions / examples:');
  for (const f of BEAT_SPECIFICS_FIELDS) {
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
      logger.info(`beat autofill: skipping ${id} (unsupported type ${mediaType})`);
      continue;
    }
    if (buffer.length > MAX_RAW_BYTES) {
      logger.info(`beat autofill: skipping ${id} (${buffer.length} > ${MAX_RAW_BYTES})`);
      continue;
    }
    out.push({ buffer, mediaType });
  }
  return out;
}

let anthropicFactory = () => new Anthropic({ apiKey: config.anthropic.apiKey });
export function _setAnthropicFactoryForTests(fn) {
  anthropicFactory = fn;
}

export async function autofillBeatSpecifics({ beatId }) {
  const beat = await getBeat(beatId);
  if (!beat) throw new Error(`Beat not found: ${beatId}`);

  const id = beat._id.toString();
  const textContext = buildBeatTextContext(beat);
  const imageInputs = await loadImageInputs(beat.images || []);

  if (!textContext && !imageInputs.length) {
    return { filled: [], reason: 'no_context' };
  }

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
        content: buildUserBlocks(beat.specifics || {}, imageInputs, textContext),
      },
    ],
  });

  const toolUse = (resp.content || []).find(
    (b) => b.type === 'tool_use' && b.name === 'fill_specifics',
  );
  if (!toolUse) {
    logger.warn('beat autofill: model did not call fill_specifics tool');
    return { filled: [], reason: 'no_tool_call' };
  }
  const proposed = toolUse.input || {};

  const fresh = await getBeat(id);
  const current = fresh?.specifics || {};
  const filled = [];
  for (const name of BEAT_SPECIFICS_FIELD_NAMES) {
    const proposedVal = String(proposed[name] ?? '').trim();
    if (!proposedVal) continue;
    const existing = String(current[name] ?? '').trim();
    if (existing) continue;
    await setEntityFieldMarkdown({
      entityType: 'beat',
      entityId: id,
      field: `specifics.${name}`,
      markdown: proposedVal,
    });
    filled.push(name);
  }

  logger.info(
    `beat autofill: beat=${id} text=${textContext.length} images=${imageInputs.length} filled=[${filled.join(',')}]`,
  );
  return { filled };
}
