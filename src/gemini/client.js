import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';

const MODEL = 'gemini-2.5-flash-image';

let client;
function getClient() {
  if (client) return client;
  if (config.gemini.vertex.project) {
    client = new GoogleGenAI({
      vertexai: true,
      project: config.gemini.vertex.project,
      location: config.gemini.vertex.location,
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

export async function generateImage({ prompt, aspectRatio }) {
  if (!prompt || !prompt.trim()) {
    throw new Error('Empty prompt; nothing to generate.');
  }
  const ai = getClient();
  const finalPrompt = appendAspectRatioHint(prompt, aspectRatio);
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: finalPrompt,
  });
  const parts = response?.candidates?.[0]?.content?.parts || [];
  const usageMetadata = response?.usageMetadata;
  for (const part of parts) {
    if (part.inlineData?.data) {
      const buffer = Buffer.from(part.inlineData.data, 'base64');
      const contentType = part.inlineData.mimeType || 'image/png';
      return { buffer, contentType, usageMetadata };
    }
  }
  const textParts = parts
    .filter((p) => p.text)
    .map((p) => p.text)
    .join(' ')
    .trim();
  throw new Error(
    `Image generation returned no image data.${textParts ? ` Model response: ${textParts}` : ''}`,
  );
}

export const NANO_BANANA_MODEL = MODEL;
