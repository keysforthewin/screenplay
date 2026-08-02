// Raw-fetch client for the ElevenLabs REST API. No SDK dependency — deploys
// are rsync-only (the bot image is deps-only), and the endpoints we use are
// plain REST. Optional-integration pattern: isConfigured() gates everything;
// callers surface a friendly message instead of crashing when the key is
// missing (same convention as src/gemini/client.js and src/tmdb/client.js).

import { config } from '../config.js';
import { logger } from '../log.js';

const BASE = 'https://api.elevenlabs.io';
const AUDIO_OUTPUT_FORMAT = 'mp3_44100_128';

export function isConfigured() {
  return Boolean(config.eleven.apiKey);
}

export class ElevenApiError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'ElevenApiError';
    this.status = status;
  }
}

// ElevenLabs error bodies come in three shapes:
//   { detail: { status, message } }   — most API errors
//   { detail: 'plain string' }
//   { detail: [{ msg, loc: [...] }] } — FastAPI validation errors
// Returns the human-readable message, or null if the shape is unknown.
export function extractElevenDetail(body) {
  const detail = body?.detail;
  if (!detail) return null;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const parts = detail
      .map((d) => {
        const loc = Array.isArray(d?.loc) ? d.loc.join('.') : null;
        const msg = d?.msg || d?.message || null;
        if (!msg) return null;
        return loc ? `${loc}: ${msg}` : msg;
      })
      .filter(Boolean);
    return parts.length ? parts.join('; ') : null;
  }
  if (typeof detail === 'object' && detail.message) return String(detail.message);
  return null;
}

async function elevenFetch(path, { method = 'GET', query = null, json = null, form = null, expect = 'json' } = {}) {
  if (!isConfigured()) {
    throw new ElevenApiError('ElevenLabs is not configured (ELEVEN_LABS_KEY missing).', { status: 503 });
  }
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === null || v === undefined || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  const headers = { 'xi-api-key': config.eleven.apiKey };
  let body = null;
  if (json) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    body = form; // fetch sets the multipart boundary header itself
  }

  let res;
  try {
    res = await fetch(url, { method, headers, body });
  } catch (e) {
    throw new ElevenApiError(`ElevenLabs network error: ${e.message}`, { status: 502 });
  }
  if (!res.ok) {
    let detail = null;
    try {
      detail = extractElevenDetail(await res.json());
    } catch {
      // Non-JSON error body; fall through to the generic message.
    }
    logger.warn(`elevenlabs ${method} ${url.pathname} failed (${res.status}): ${detail || 'no detail'}`);
    throw new ElevenApiError(detail || `ElevenLabs request failed (${res.status})`, { status: res.status });
  }
  if (expect === 'audio') {
    const contentType = res.headers.get('content-type') || 'audio/mpeg';
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType };
  }
  return res.json();
}

function audioBlob(buffer, contentType) {
  return new Blob([buffer], { type: contentType || 'application/octet-stream' });
}

/** Search the public voice library. All filters optional. */
export async function searchSharedVoices({
  page = 0, pageSize = 30, search, category, gender, age, accent,
  language, useCase, descriptive, featured,
} = {}) {
  return elevenFetch('/v1/shared-voices', {
    query: {
      page,
      page_size: pageSize,
      search,
      category,
      gender,
      age,
      accent,
      language,
      use_cases: useCase,
      descriptives: descriptive,
      featured: featured ? 'true' : undefined,
    },
  });
}

/** Add a shared library voice to the account's My Voices (required before TTS/STS can use it). */
export async function addSharedVoice({ publicOwnerId, voiceId, newName }) {
  return elevenFetch(
    `/v1/voices/add/${encodeURIComponent(publicOwnerId)}/${encodeURIComponent(voiceId)}`,
    { method: 'POST', json: { new_name: newName } },
  );
}

export async function textToSpeech({ voiceId, text, modelId = 'eleven_v3' }) {
  return elevenFetch(`/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: 'POST',
    query: { output_format: AUDIO_OUTPUT_FORMAT },
    json: { text, model_id: modelId },
    expect: 'audio',
  });
}

export async function speechToSpeech({ voiceId, buffer, contentType, modelId = 'eleven_multilingual_sts_v2' }) {
  const form = new FormData();
  form.append('audio', audioBlob(buffer, contentType), 'input-audio');
  form.append('model_id', modelId);
  return elevenFetch(`/v1/speech-to-speech/${encodeURIComponent(voiceId)}`, {
    method: 'POST',
    query: { output_format: AUDIO_OUTPUT_FORMAT },
    form,
    expect: 'audio',
  });
}

export async function isolateAudio({ buffer, contentType }) {
  const form = new FormData();
  form.append('audio', audioBlob(buffer, contentType), 'input-audio');
  return elevenFetch('/v1/audio-isolation', { method: 'POST', form, expect: 'audio' });
}

export async function speechToText({ buffer, contentType }) {
  const form = new FormData();
  form.append('file', audioBlob(buffer, contentType), 'input-audio');
  form.append('model_id', 'scribe_v1');
  return elevenFetch('/v1/speech-to-text', { method: 'POST', form });
}

/** Instant Voice Clone from one or more audio samples. */
export async function createIvcVoice({ name, description = null, removeNoise = false, samples = [] }) {
  const form = new FormData();
  form.append('name', name);
  if (description) form.append('description', description);
  if (removeNoise) form.append('remove_background_noise', 'true');
  for (const s of samples) {
    form.append('files', audioBlob(s.buffer, s.contentType), s.filename || 'sample');
  }
  return elevenFetch('/v1/voices/ivc/create', { method: 'POST', form });
}

/** Voice Design: returns { previews: [{ generated_voice_id, audio_base_64, media_type, duration_secs }], text }. */
export async function designVoice({ voiceDescription, previewText = null }) {
  return elevenFetch('/v1/text-to-voice/design', {
    method: 'POST',
    json: {
      voice_description: voiceDescription,
      ...(previewText ? { text: previewText } : { auto_generate_text: true }),
    },
  });
}

/** Persist a designed preview as a real voice in the account's My Voices. */
export async function createVoiceFromPreview({ voiceName, voiceDescription, generatedVoiceId }) {
  return elevenFetch('/v1/text-to-voice', {
    method: 'POST',
    json: {
      voice_name: voiceName,
      voice_description: voiceDescription,
      generated_voice_id: generatedVoiceId,
    },
  });
}
