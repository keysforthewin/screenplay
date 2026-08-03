// Route tests for /api/eleven. The eleven client, enhance, and attachments
// modules are mocked; the router is mounted standalone with a stub middleware
// injecting req.projectId (in production the outer buildApiRouter's
// resolveProject() does this).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const elevenMock = vi.hoisted(() => ({
  isConfigured: vi.fn(() => true),
  searchSharedVoices: vi.fn(),
  addSharedVoice: vi.fn(),
  textToSpeech: vi.fn(),
  speechToSpeech: vi.fn(),
  isolateAudio: vi.fn(),
  speechToText: vi.fn(),
  createIvcVoice: vi.fn(),
  designVoice: vi.fn(),
  createVoiceFromPreview: vi.fn(),
}));
vi.mock('../src/eleven/client.js', () => ({
  ...elevenMock,
  ElevenApiError: class ElevenApiError extends Error {
    constructor(message, { status = null } = {}) { super(message); this.status = status; }
  },
}));

const enhanceMock = vi.hoisted(() => ({ enhanceWithAudioTags: vi.fn() }));
vi.mock('../src/eleven/enhance.js', () => enhanceMock);

const attachmentsMock = vi.hoisted(() => ({
  readAttachmentBuffer: vi.fn(),
  uploadAttachmentBuffer: vi.fn(),
}));
vi.mock('../src/mongo/attachments.js', () => attachmentsMock);

const { buildElevenRouter } = await import('../src/web/elevenRoutes.js');
const { addVoiceToCollection, getCollectionVoice, listCollectionVoices } =
  await import('../src/mongo/elevenVoices.js');

const PID = '65e000000000000000000001';

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.projectId = PID; next(); });
  app.use('/api/eleven', buildElevenRouter());
  await new Promise((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  fakeDb.reset();
  for (const fn of Object.values(elevenMock)) fn.mockReset?.();
  elevenMock.isConfigured.mockReturnValue(true);
  enhanceMock.enhanceWithAudioTags.mockReset();
  attachmentsMock.readAttachmentBuffer.mockReset();
  attachmentsMock.uploadAttachmentBuffer.mockReset();
  attachmentsMock.uploadAttachmentBuffer.mockImplementation(async (_pid, { filename, contentType }) => ({
    _id: { toString: () => 'file123' }, filename, content_type: contentType, size: 3,
  }));
});

function playgroundRef({ contentType = 'audio/webm', projectId = PID, ownerType = 'playground' } = {}) {
  return {
    buffer: Buffer.from([1, 2, 3]),
    file: { metadata: { project_id: projectId, owner_type: ownerType, content_type: contentType }, filename: 'in.webm' },
  };
}

describe('GET /info', () => {
  it('reports configured + tags', async () => {
    const r = await fetch(`${baseUrl}/api/eleven/info`);
    const body = await r.json();
    expect(body.configured).toBe(true);
    expect(body.tags.Reactions).toContain('laughs');
  });
});

describe('GET /library', () => {
  it('maps query params through to searchSharedVoices and trims the response', async () => {
    elevenMock.searchSharedVoices.mockResolvedValueOnce({
      voices: [{
        voice_id: 'v1', public_owner_id: 'o1', name: 'Noir', description: 'gravelly',
        preview_url: 'https://cdn/p.mp3', category: 'professional', gender: 'male',
        age: 'old', accent: 'american', language: 'en', use_case: 'narrative_story',
        descriptive: 'deep', free_users_allowed: true, some_internal_field: 'x',
      }],
      has_more: true,
    });
    const r = await fetch(`${baseUrl}/api/eleven/library?search=noir&gender=male&featured=true&page=1`);
    const body = await r.json();
    expect(elevenMock.searchSharedVoices).toHaveBeenCalledWith(expect.objectContaining({
      search: 'noir', gender: 'male', featured: true, page: 1,
    }));
    expect(body.has_more).toBe(true);
    expect(body.voices[0]).not.toHaveProperty('some_internal_field');
    expect(body.voices[0].voice_id).toBe('v1');
  });

  it('returns 503 when unconfigured', async () => {
    elevenMock.isConfigured.mockReturnValue(false);
    const r = await fetch(`${baseUrl}/api/eleven/library`);
    expect(r.status).toBe(503);
  });
});

describe('collection CRUD', () => {
  it('POST adds and GET lists', async () => {
    const post = await fetch(`${baseUrl}/api/eleven/collection`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        voice_id: 'v1', public_owner_id: 'o1', name: 'Noir', preview_url: 'https://cdn/p.mp3',
        category: 'professional', description: 'gravelly',
        labels: { gender: 'male', age: 'old', accent: 'american', language: 'en' },
      }),
    });
    expect(post.status).toBe(200);
    const list = await (await fetch(`${baseUrl}/api/eleven/collection`)).json();
    expect(list.voices).toHaveLength(1);
    expect(list.voices[0].voice_id).toBe('v1');
    expect(list.voices[0].labels.gender).toBe('male');
  });

  it('POST without voice_id is a 400', async () => {
    const r = await fetch(`${baseUrl}/api/eleven/collection`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'nope' }),
    });
    expect(r.status).toBe(400);
  });

  it('DELETE removes; unknown id 404s', async () => {
    await addVoiceToCollection(PID, { voice_id: 'v1', name: 'X' });
    expect((await fetch(`${baseUrl}/api/eleven/collection/v1`, { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/eleven/collection/v1`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('POST /enhance', () => {
  it('returns enhanced text', async () => {
    enhanceMock.enhanceWithAudioTags.mockResolvedValueOnce('[excited] Hi!');
    const r = await fetch(`${baseUrl}/api/eleven/enhance`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Hi!' }),
    });
    expect((await r.json()).text).toBe('[excited] Hi!');
  });

  it('empty text is a 400', async () => {
    const r = await fetch(`${baseUrl}/api/eleven/enhance`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '  ' }),
    });
    expect(r.status).toBe(400);
  });

  it('text over the max length is a 400', async () => {
    const r = await fetch(`${baseUrl}/api/eleven/enhance`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'a'.repeat(10_001) }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('text too long (max 10000 characters)');
    expect(enhanceMock.enhanceWithAudioTags).not.toHaveBeenCalled();
  });
});

describe('POST /tts', () => {
  it('generates with an account-ready voice and persists the output', async () => {
    await addVoiceToCollection(PID, { voice_id: 'v1', name: 'X', source: 'clone', added_to_account: true });
    elevenMock.textToSpeech.mockResolvedValueOnce({ buffer: Buffer.from([9]), contentType: 'audio/mpeg' });
    const r = await fetch(`${baseUrl}/api/eleven/tts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice_id: 'v1', text: 'hello' }),
    });
    const body = await r.json();
    expect(elevenMock.addSharedVoice).not.toHaveBeenCalled();
    expect(elevenMock.textToSpeech).toHaveBeenCalledWith({ voiceId: 'v1', text: 'hello', modelId: 'eleven_v3' });
    expect(body.outputs).toEqual([{ kind: 'audio', file_id: 'file123' }]);
    const upload = attachmentsMock.uploadAttachmentBuffer.mock.calls[0][1];
    expect(upload.ownerType).toBe('playground');
    expect(upload.generatedBy).toBe('elevenlabs/tts');
  });

  it('lazily adds a library voice to the account first, and marks it', async () => {
    await addVoiceToCollection(PID, { voice_id: 'v1', public_owner_id: 'o1', name: 'Lib', source: 'library' });
    elevenMock.addSharedVoice.mockResolvedValueOnce({ voice_id: 'v1' });
    elevenMock.textToSpeech.mockResolvedValueOnce({ buffer: Buffer.from([9]), contentType: 'audio/mpeg' });
    const r = await fetch(`${baseUrl}/api/eleven/tts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice_id: 'v1', text: 'hello' }),
    });
    expect(r.status).toBe(200);
    expect(elevenMock.addSharedVoice).toHaveBeenCalledWith({ publicOwnerId: 'o1', voiceId: 'v1', newName: 'Lib' });
    expect((await getCollectionVoice(PID, 'v1')).added_to_account).toBe(true);
  });

  it('treats an "already added" add-failure as success', async () => {
    await addVoiceToCollection(PID, { voice_id: 'v1', public_owner_id: 'o1', name: 'Lib', source: 'library' });
    elevenMock.addSharedVoice.mockRejectedValueOnce(new Error('Voice already exists in your collection'));
    elevenMock.textToSpeech.mockResolvedValueOnce({ buffer: Buffer.from([9]), contentType: 'audio/mpeg' });
    const r = await fetch(`${baseUrl}/api/eleven/tts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice_id: 'v1', text: 'hello' }),
    });
    expect(r.status).toBe(200);
    expect((await getCollectionVoice(PID, 'v1')).added_to_account).toBe(true);
  });

  it('rejects non-"already" addSharedVoice errors without marking voice added', async () => {
    await addVoiceToCollection(PID, { voice_id: 'v1', public_owner_id: 'o1', name: 'Lib', source: 'library' });
    elevenMock.addSharedVoice.mockRejectedValueOnce(new Error('Voice does not exist'));
    const r = await fetch(`${baseUrl}/api/eleven/tts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice_id: 'v1', text: 'hello' }),
    });
    expect(r.status).toBe(502);
    expect((await r.json()).error).toBe('Voice does not exist');
    expect(elevenMock.textToSpeech).not.toHaveBeenCalled();
    expect((await getCollectionVoice(PID, 'v1')).added_to_account).not.toBe(true);
  });

  it('voice not in the project collection is a 404; missing text a 400', async () => {
    expect((await fetch(`${baseUrl}/api/eleven/tts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice_id: 'ghost', text: 'x' }),
    })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/eleven/tts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice_id: 'v1' }),
    })).status).toBe(400);
  });

  it('surfaces ElevenApiError status + message', async () => {
    const { ElevenApiError } = await import('../src/eleven/client.js');
    await addVoiceToCollection(PID, { voice_id: 'v1', name: 'X', added_to_account: true, source: 'clone' });
    elevenMock.textToSpeech.mockRejectedValueOnce(new ElevenApiError('Voice slots full', { status: 400 }));
    const r = await fetch(`${baseUrl}/api/eleven/tts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice_id: 'v1', text: 'x' }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('Voice slots full');
  });
});

describe('audio-ref endpoints', () => {
  it('isolate loads a project playground ref and returns the persisted output', async () => {
    attachmentsMock.readAttachmentBuffer.mockResolvedValueOnce(playgroundRef());
    elevenMock.isolateAudio.mockResolvedValueOnce({ buffer: Buffer.from([7]), contentType: 'audio/mpeg' });
    const r = await fetch(`${baseUrl}/api/eleven/isolate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: { file_id: 'abc' } }),
    });
    expect((await r.json()).outputs[0].kind).toBe('audio');
  });

  it('cross-project and non-playground refs behave as not-found', async () => {
    attachmentsMock.readAttachmentBuffer.mockResolvedValueOnce(playgroundRef({ projectId: 'other' }));
    expect((await fetch(`${baseUrl}/api/eleven/isolate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: { file_id: 'abc' } }),
    })).status).toBe(404);
    attachmentsMock.readAttachmentBuffer.mockResolvedValueOnce(playgroundRef({ ownerType: 'beat' }));
    expect((await fetch(`${baseUrl}/api/eleven/isolate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: { file_id: 'abc' } }),
    })).status).toBe(404);
  });

  it('stt returns the transcript and persists a txt attachment', async () => {
    attachmentsMock.readAttachmentBuffer.mockResolvedValueOnce(playgroundRef());
    elevenMock.speechToText.mockResolvedValueOnce({ text: 'hello world', language_code: 'en' });
    const r = await fetch(`${baseUrl}/api/eleven/stt`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: { file_id: 'abc' } }),
    });
    const body = await r.json();
    expect(body.transcript).toBe('hello world');
    expect(body.language).toBe('en');
    expect(body.outputs[0].kind).toBe('text');
    const upload = attachmentsMock.uploadAttachmentBuffer.mock.calls[0][1];
    expect(upload.contentType).toBe('text/plain');
    expect(upload.buffer.toString('utf8')).toBe('hello world');
  });

  it('voice-changer requires both voice and ref', async () => {
    const r = await fetch(`${baseUrl}/api/eleven/voice-changer`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: { file_id: 'abc' } }),
    });
    expect(r.status).toBe(400);
  });
});

describe('clone + design', () => {
  it('clone creates the voice and auto-adds it to the collection', async () => {
    attachmentsMock.readAttachmentBuffer.mockResolvedValue(playgroundRef());
    elevenMock.createIvcVoice.mockResolvedValueOnce({ voice_id: 'cloned1' });
    const r = await fetch(`${baseUrl}/api/eleven/clone`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Me', remove_noise: true, refs: [{ file_id: 'a' }, { file_id: 'b' }] }),
    });
    const body = await r.json();
    expect(body.voice.voice_id).toBe('cloned1');
    expect(body.voice.source).toBe('clone');
    expect(body.voice.added_to_account).toBe(true);
    expect(elevenMock.createIvcVoice.mock.calls[0][0].samples).toHaveLength(2);
    expect(await listCollectionVoices(PID)).toHaveLength(1);
  });

  it('clone without name or refs is a 400', async () => {
    expect((await fetch(`${baseUrl}/api/eleven/clone`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refs: [] }),
    })).status).toBe(400);
  });

  it('clone with more than 10 refs is a 400 without calling createIvcVoice', async () => {
    const refs = Array.from({ length: 11 }, (_, i) => ({ file_id: `f${i}` }));
    const r = await fetch(`${baseUrl}/api/eleven/clone`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Me', refs }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('too many audio samples (max 10)');
    expect(elevenMock.createIvcVoice).not.toHaveBeenCalled();
  });

  it('clone dedupes repeated file_ids into a single sample', async () => {
    attachmentsMock.readAttachmentBuffer.mockResolvedValue(playgroundRef());
    elevenMock.createIvcVoice.mockResolvedValueOnce({ voice_id: 'cloned2' });
    const r = await fetch(`${baseUrl}/api/eleven/clone`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Me', refs: [{ file_id: 'a' }, { file_id: 'a' }, { file_id: 'a' }] }),
    });
    expect(r.status).toBe(200);
    expect(elevenMock.createIvcVoice.mock.calls[0][0].samples).toHaveLength(1);
  });

  it('design returns previews as data urls; design/save persists to the collection', async () => {
    elevenMock.designVoice.mockResolvedValueOnce({
      previews: [{ generated_voice_id: 'g1', audio_base_64: 'QUJD', media_type: 'audio/mpeg', duration_secs: 2 }],
    });
    const d = await (await fetch(`${baseUrl}/api/eleven/design`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice_description: 'a gravelly noir detective from brooklyn' }),
    })).json();
    expect(d.previews[0].audio_data_url).toBe('data:audio/mpeg;base64,QUJD');

    elevenMock.createVoiceFromPreview.mockResolvedValueOnce({ voice_id: 'designed1' });
    const s = await (await fetch(`${baseUrl}/api/eleven/design/save`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice_name: 'Noir', voice_description: 'a gravelly noir detective', generated_voice_id: 'g1' }),
    })).json();
    expect(s.voice.voice_id).toBe('designed1');
    expect(s.voice.source).toBe('design');
  });
});
