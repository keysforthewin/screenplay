// Auto-caption library images. Sends a single Anthropic vision call asking
// for a short title and a one-paragraph description; returns {name, description}.
// Failures (missing API key, network, parse errors, oversize input) collapse
// to {name: '', description: ''} so the upload pipeline never fails because
// of vision.

import { config } from '../config.js';
import { modelFor } from './modelSlots.js';
import { getAnthropic } from '../anthropic/client.js';
import { logger } from '../log.js';

const ANTHROPIC_OK = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_RAW = 4 * 1024 * 1024; // ~5 MB cap on raw vision input bytes.

const SYSTEM = [
  'You generate short, useful captions for library images in a screenplay-writing app.',
  'Return a "name" (a 3-6 word title) and a "description" (1-3 sentences).',
  'The name should be a noun-phrase title someone could search for (e.g. "Diner at dusk", "Sheriff with hat").',
  'The description should describe what is depicted in the image — subjects, setting, mood, lighting — in plain prose.',
].join(' ');

const USER_PROMPT = 'Caption this image.';

// Structured output: the API guarantees the text block parses against this
// schema, so no fence-stripping is needed.
const CAPTION_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
    },
    required: ['name', 'description'],
    additionalProperties: false,
  },
};

function safeParse(text) {
  if (typeof text !== 'string') return null;
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object') return null;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    const description = typeof obj.description === 'string' ? obj.description.trim() : '';
    return { name, description };
  } catch {
    return null;
  }
}

export async function analyzeLibraryImage(buffer, contentType) {
  if (!config.anthropic?.apiKey) return { name: '', description: '' };
  if (!Buffer.isBuffer(buffer)) return { name: '', description: '' };
  if (!ANTHROPIC_OK.has(contentType)) {
    logger.warn(`analyzeLibraryImage: unsupported type ${contentType}`);
    return { name: '', description: '' };
  }
  if (buffer.length > MAX_RAW) {
    const mb = (buffer.length / 1024 / 1024).toFixed(1);
    logger.warn(`analyzeLibraryImage: image too large (${mb} MB), skipping vision seed`);
    return { name: '', description: '' };
  }

  const t0 = Date.now();
  try {
    const client = getAnthropic();
    const resp = await client.messages.create({
      model: modelFor('enhancer'),
      max_tokens: 3000,
      system: SYSTEM,
      output_config: { format: CAPTION_FORMAT },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: USER_PROMPT },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: contentType,
                data: buffer.toString('base64'),
              },
            },
          ],
        },
      ],
    });
    const text = (resp.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const parsed = safeParse(text);
    if (!parsed) {
      logger.warn(`analyzeLibraryImage: parse failed (${Date.now() - t0}ms)`);
      return { name: '', description: '' };
    }
    logger.info(
      `analyzeLibraryImage: name=${parsed.name.length}c desc=${parsed.description.length}c ${Date.now() - t0}ms`,
    );
    return parsed;
  } catch (e) {
    logger.warn(`analyzeLibraryImage: ${e.message} (${Date.now() - t0}ms)`);
    return { name: '', description: '' };
  }
}
