// Auto-caption library images. Sends a single Anthropic vision call asking
// for a short title and a one-paragraph description; returns {name, description}.
// Failures (missing API key, network, parse errors, oversize input) collapse
// to {name: '', description: ''} so the upload pipeline never fails because
// of vision.

import { config } from '../config.js';
import { getAnthropic } from '../anthropic/client.js';
import { logger } from '../log.js';

const VISION_MODEL = config.anthropic.enhancerModel || 'claude-haiku-4-5-20251001';
const ANTHROPIC_OK = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_RAW = 4 * 1024 * 1024; // ~5 MB cap on raw vision input bytes.

const SYSTEM = [
  'You generate short, useful captions for library images in a screenplay-writing app.',
  'Respond with EXACTLY one line of compact JSON: {"name": "<3-6 word title>", "description": "<1-3 sentence description>"}.',
  'No markdown, no code fences, no commentary outside the JSON.',
  'The name should be a noun-phrase title someone could search for (e.g. "Diner at dusk", "Sheriff with hat").',
  'The description should describe what is depicted in the image — subjects, setting, mood, lighting — in plain prose.',
].join(' ');

const USER_PROMPT =
  'Caption this image. Return only the JSON object: {"name": ..., "description": ...}.';

function safeParse(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  // Tolerate a code fence the model might emit despite instructions.
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const obj = JSON.parse(stripped);
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
      model: VISION_MODEL,
      max_tokens: 400,
      system: SYSTEM,
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
