import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { logger } from '../log.js';

const MODEL = 'gemini-2.5-flash-image';

// Force the OAuth transporter (gaxios, used transitively by google-auth-library)
// to use Node's built-in global fetch. Otherwise gaxios falls through to a
// dynamic `await import('node-fetch')` and — if that import resolves with
// `.default` undefined for any reason on the host — every Vertex auth call
// fails with "fetchImpl is not a function" before the request leaves the
// process. Node ≥18 has global fetch, so this is always safe.
const TRANSPORTER_OPTIONS = { fetchImplementation: globalThis.fetch };

let client;
function getClient() {
  if (client) return client;
  if (config.gemini.vertex.project) {
    client = new GoogleGenAI({
      vertexai: true,
      project: config.gemini.vertex.project,
      location: config.gemini.vertex.location,
      googleAuthOptions: {
        clientOptions: { transporterOptions: TRANSPORTER_OPTIONS },
      },
    });
  } else if (config.gemini.apiKey) {
    client = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  } else {
    throw new Error(
      'Gemini is not configured. Set GEMINI_VERTEX_PROJECT (+ GOOGLE_APPLICATION_CREDENTIALS) for Vertex AI, or GEMINI_API_KEY for the Developer API.',
    );
  }
  return client;
}

function appendAspectRatioHint(prompt, aspectRatio) {
  if (!aspectRatio) return prompt;
  return `${prompt}\n\nFraming: render with a ${aspectRatio} aspect ratio.`;
}

export async function generateImage({ prompt, aspectRatio, inputImage, inputImages }) {
  if (!prompt || !prompt.trim()) {
    throw new Error('Empty prompt; nothing to generate.');
  }
  const ai = getClient();
  const finalPrompt = appendAspectRatioHint(prompt, aspectRatio);
  // Normalize legacy `inputImage` into an array.
  const imageInputs = Array.isArray(inputImages) && inputImages.length
    ? inputImages
    : inputImage
      ? [inputImage]
      : [];
  // Console-log the full prompt before every call so safety-system rejections
  // are debuggable. Goes to logger.info (visible by default).
  logger.info(
    `gemini → model=${MODEL} prompt=${finalPrompt.length}c aspect=${aspectRatio || 'default'}${
      imageInputs.length
        ? ` editing inputs=${imageInputs.length} bytes=${imageInputs.reduce((n, i) => n + i.buffer.length, 0)}`
        : ''
    }\n────── prompt (${finalPrompt.length} chars) ──────\n${finalPrompt}\n──────────────────────────────────────────`,
  );
  const contents = imageInputs.length
    ? [
        { text: finalPrompt },
        ...imageInputs.map((img) => ({
          inlineData: {
            mimeType: img.contentType,
            data: img.buffer.toString('base64'),
          },
        })),
      ]
    : finalPrompt;
  const t0 = Date.now();
  let response;
  try {
    response = await ai.models.generateContent({
      model: MODEL,
      contents,
    });
  } catch (e) {
    logger.error(`gemini ← failed ${Date.now() - t0}ms: ${e.message}`);
    throw e;
  }
  const parts = response?.candidates?.[0]?.content?.parts || [];
  const usageMetadata = response?.usageMetadata;
  for (const part of parts) {
    if (part.inlineData?.data) {
      const buffer = Buffer.from(part.inlineData.data, 'base64');
      const contentType = part.inlineData.mimeType || 'image/png';
      logger.info(
        `gemini ← bytes=${buffer.length} in_tok=${usageMetadata?.promptTokenCount || 0} out_tok=${usageMetadata?.candidatesTokenCount || 0} ${Date.now() - t0}ms`,
      );
      return { buffer, contentType, usageMetadata };
    }
  }
  const textParts = parts
    .filter((p) => p.text)
    .map((p) => p.text)
    .join(' ')
    .trim();
  logger.error(`gemini ← no image data ${Date.now() - t0}ms`);
  throw new Error(
    `Image generation returned no image data.${textParts ? ` Model response: ${textParts}` : ''}`,
  );
}

export const NANO_BANANA_MODEL = MODEL;
