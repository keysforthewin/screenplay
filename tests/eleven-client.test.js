// Tests for the raw-fetch ElevenLabs client. global fetch is stubbed; no
// network. ELEVEN_LABS_KEY is set before the dynamic import because
// src/config.js reads env at import time.

import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.ELEVEN_LABS_KEY = 'test-eleven-key';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const eleven = await import('../src/eleven/client.js');

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function audioResponse(bytes, contentType = 'audio/mpeg') {
  return {
    ok: true,
    status: 200,
    headers: { get: (h) => (h === 'content-type' ? contentType : null) },
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
    json: async () => ({}),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('isConfigured', () => {
  it('is true when ELEVEN_LABS_KEY is set', () => {
    expect(eleven.isConfigured()).toBe(true);
  });
});

describe('extractElevenDetail', () => {
  it('handles {detail:{message}} objects', () => {
    expect(eleven.extractElevenDetail({ detail: { status: 'x', message: 'Voice slots full' } }))
      .toBe('Voice slots full');
  });
  it('handles string details', () => {
    expect(eleven.extractElevenDetail({ detail: 'nope' })).toBe('nope');
  });
  it('handles validation arrays', () => {
    expect(eleven.extractElevenDetail({ detail: [{ msg: 'field required', loc: ['body', 'text'] }] }))
      .toBe('body.text: field required');
  });
  it('returns null for unknown shapes', () => {
    expect(eleven.extractElevenDetail({})).toBeNull();
    expect(eleven.extractElevenDetail(null)).toBeNull();
  });
});

describe('searchSharedVoices', () => {
  it('maps params to /v1/shared-voices query and sends the api key', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ voices: [], has_more: false }));
    await eleven.searchSharedVoices({
      page: 2, search: 'noir', gender: 'male', age: 'old', accent: 'american',
      language: 'en', category: 'professional', useCase: 'narrative_story',
      descriptive: 'deep', featured: true,
    });
    const [url, opts] = fetchMock.mock.calls[0];
    const u = new URL(String(url));
    expect(u.pathname).toBe('/v1/shared-voices');
    expect(u.searchParams.get('page')).toBe('2');
    expect(u.searchParams.get('search')).toBe('noir');
    expect(u.searchParams.get('gender')).toBe('male');
    expect(u.searchParams.get('age')).toBe('old');
    expect(u.searchParams.get('accent')).toBe('american');
    expect(u.searchParams.get('language')).toBe('en');
    expect(u.searchParams.get('category')).toBe('professional');
    expect(u.searchParams.get('use_cases')).toBe('narrative_story');
    expect(u.searchParams.get('descriptives')).toBe('deep');
    expect(u.searchParams.get('featured')).toBe('true');
    expect(opts.headers['xi-api-key']).toBe('test-eleven-key');
  });

  it('omits empty params entirely', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ voices: [] }));
    await eleven.searchSharedVoices({ search: '', gender: null });
    const u = new URL(String(fetchMock.mock.calls[0][0]));
    expect(u.searchParams.has('search')).toBe(false);
    expect(u.searchParams.has('gender')).toBe(false);
    expect(u.searchParams.has('featured')).toBe(false);
  });
});

describe('textToSpeech', () => {
  it('POSTs json to the voice path and returns audio bytes', async () => {
    fetchMock.mockResolvedValueOnce(audioResponse([1, 2, 3]));
    const out = await eleven.textToSpeech({ voiceId: 'v1', text: 'hello [laughs]' });
    const [url, opts] = fetchMock.mock.calls[0];
    const u = new URL(String(url));
    expect(u.pathname).toBe('/v1/text-to-speech/v1');
    expect(u.searchParams.get('output_format')).toBe('mp3_44100_128');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ text: 'hello [laughs]', model_id: 'eleven_v3' });
    expect(Buffer.isBuffer(out.buffer)).toBe(true);
    expect(out.buffer.length).toBe(3);
    expect(out.contentType).toBe('audio/mpeg');
  });
});

describe('speechToSpeech', () => {
  it('sends multipart with audio blob and model_id', async () => {
    fetchMock.mockResolvedValueOnce(audioResponse([9]));
    await eleven.speechToSpeech({ voiceId: 'v2', buffer: Buffer.from([1]), contentType: 'audio/webm' });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe('/v1/speech-to-speech/v2');
    expect(opts.body).toBeInstanceOf(FormData);
    expect(opts.body.get('model_id')).toBe('eleven_multilingual_sts_v2');
    expect(opts.body.get('audio')).toBeInstanceOf(Blob);
  });
});

describe('speechToText', () => {
  it('sends multipart with file and scribe_v1', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ text: 'hi', language_code: 'en' }));
    const r = await eleven.speechToText({ buffer: Buffer.from([1]), contentType: 'audio/mpeg' });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe('/v1/speech-to-text');
    expect(opts.body.get('model_id')).toBe('scribe_v1');
    expect(opts.body.get('file')).toBeInstanceOf(Blob);
    expect(r.text).toBe('hi');
  });
});

describe('createIvcVoice', () => {
  it('appends every sample under files', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ voice_id: 'new1' }));
    await eleven.createIvcVoice({
      name: 'Me',
      description: 'my voice',
      removeNoise: true,
      samples: [
        { buffer: Buffer.from([1]), contentType: 'audio/webm', filename: 'a.webm' },
        { buffer: Buffer.from([2]), contentType: 'audio/mpeg', filename: 'b.mp3' },
      ],
    });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe('/v1/voices/ivc/create');
    expect(opts.body.get('name')).toBe('Me');
    expect(opts.body.get('description')).toBe('my voice');
    expect(opts.body.get('remove_background_noise')).toBe('true');
    expect(opts.body.getAll('files')).toHaveLength(2);
  });
});

describe('designVoice / createVoiceFromPreview', () => {
  it('design sends voice_description and auto_generate_text when no preview text', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ previews: [] }));
    await eleven.designVoice({ voiceDescription: 'a sassy squeaky mouse with a big attitude' });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe('/v1/text-to-voice/design');
    const body = JSON.parse(opts.body);
    expect(body.voice_description).toMatch(/sassy/);
    expect(body.auto_generate_text).toBe(true);
    expect(body.text).toBeUndefined();
  });

  it('design sends custom preview text when provided', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ previews: [] }));
    await eleven.designVoice({ voiceDescription: 'x'.repeat(30), previewText: 'p'.repeat(120) });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toBe('p'.repeat(120));
    expect(body.auto_generate_text).toBeUndefined();
  });

  it('createVoiceFromPreview posts to /v1/text-to-voice', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ voice_id: 'saved1' }));
    await eleven.createVoiceFromPreview({
      voiceName: 'Mouse', voiceDescription: 'a sassy squeaky mouse', generatedVoiceId: 'gen1',
    });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe('/v1/text-to-voice');
    expect(JSON.parse(opts.body)).toEqual({
      voice_name: 'Mouse', voice_description: 'a sassy squeaky mouse', generated_voice_id: 'gen1',
    });
  });
});

describe('error handling', () => {
  it('raises ElevenApiError with the extracted detail and status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(
      { detail: { status: 'voice_limit_reached', message: 'Voice slots full' } },
      { ok: false, status: 400 },
    ));
    await expect(eleven.searchSharedVoices({})).rejects.toMatchObject({
      message: 'Voice slots full',
      status: 400,
    });
  });

  it('falls back to a status message when the body is not json', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 500,
      headers: { get: () => 'text/html' },
      json: async () => { throw new Error('not json'); },
    });
    await expect(eleven.searchSharedVoices({})).rejects.toMatchObject({
      message: 'ElevenLabs request failed (500)',
      status: 500,
    });
  });
});
