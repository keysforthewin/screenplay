// Voyage AI embedding client. Raw fetch — no SDK dep.
//
// Public surface:
//   embedTexts(texts, { inputType: 'document'|'query' }) -> Promise<number[][]>
//   RagDisabledError
//
// Behavior:
//   - Throws RagDisabledError when VOYAGE_API_KEY is not configured.
//   - Batches at 128 inputs per request (Voyage limit).
//   - Retries 429/5xx with backoff [500, 1500, 4500] ms honoring Retry-After.
//   - Throws after 4 attempts.

import { config } from '../config.js';
import { logger } from '../log.js';

export class RagDisabledError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'RagDisabledError';
  }
}

const ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
const BATCH_SIZE = 128;
const BACKOFF_MS = [500, 1500, 4500];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callVoyage({ inputs, inputType }) {
  const key = config.voyage.apiKey;
  if (!key) throw new RagDisabledError('VOYAGE_API_KEY not configured');
  const body = {
    model: config.voyage.model,
    input: inputs,
    input_type: inputType,
  };
  let lastErr = null;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = e;
      if (attempt < BACKOFF_MS.length) {
        await sleep(BACKOFF_MS[attempt]);
        continue;
      }
      throw new Error(`Voyage network error: ${e.message}`);
    }
    if (res.ok) {
      const json = await res.json();
      const data = Array.isArray(json?.data) ? json.data : [];
      const out = new Array(inputs.length);
      for (const row of data) {
        const i = typeof row.index === 'number' ? row.index : -1;
        if (i >= 0 && Array.isArray(row.embedding)) out[i] = row.embedding;
      }
      if (out.some((v) => !Array.isArray(v))) {
        throw new Error('Voyage response missing embeddings for some inputs');
      }
      return out;
    }
    const text = await res.text().catch(() => '');
    if ((res.status === 429 || res.status >= 500) && attempt < BACKOFF_MS.length) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : BACKOFF_MS[attempt];
      logger.warn(`voyage: status=${res.status} attempt=${attempt + 1} retry_in=${delay}ms`);
      await sleep(delay);
      lastErr = new Error(`Voyage ${res.status}: ${text.slice(0, 200)}`);
      continue;
    }
    throw new Error(`Voyage ${res.status}: ${text.slice(0, 200)}`);
  }
  throw lastErr || new Error('Voyage embedding failed');
}

export async function embedTexts(texts, { inputType = 'document' } = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const out = new Array(texts.length);
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const slice = texts.slice(i, i + BATCH_SIZE);
    const vectors = await callVoyage({ inputs: slice, inputType });
    for (let j = 0; j < slice.length; j++) out[i + j] = vectors[j];
  }
  return out;
}
