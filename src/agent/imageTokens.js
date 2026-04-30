import { imageSize } from 'image-size';
import { logger } from '../log.js';

const MAX_TOKENS_PER_IMAGE = 1600;
const FALLBACK_TOKENS = MAX_TOKENS_PER_IMAGE;

function tokensFromDimensions(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return FALLBACK_TOKENS;
  }
  return Math.min(MAX_TOKENS_PER_IMAGE, Math.ceil((width * height) / 750));
}

export function computeAnthropicImageTokens(buffers) {
  if (!Array.isArray(buffers) || !buffers.length) {
    return { perImageTokens: [], total: 0 };
  }
  const perImageTokens = [];
  for (const buf of buffers) {
    let tokens;
    try {
      const dims = imageSize(buf);
      tokens = tokensFromDimensions(dims?.width, dims?.height);
    } catch (e) {
      logger?.warn?.(`image-size failed: ${e.message}`);
      tokens = FALLBACK_TOKENS;
    }
    perImageTokens.push(tokens);
  }
  const total = perImageTokens.reduce((a, b) => a + b, 0);
  return { perImageTokens, total };
}
