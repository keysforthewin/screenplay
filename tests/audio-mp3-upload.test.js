// The audio upload routes normalize non-MP3 uploads (browser webm/m4a) to MP3
// before storing them in GridFS, and fail loudly when ffmpeg is unavailable.
// The ffmpeg spawn is faked via the audioTranscode seam; GridFS is an in-memory
// stand-in.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/web/auth.js', () => ({
  requireSession: () => (_req, _res, next) => next(),
}));

vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// In-memory attachments bucket. The audio routes call uploadAttachmentBuffer;
// the gateway's duration probe reads it back via readAttachmentBuffer.
const uploaded = [];
const stored = new Map();
vi.mock('../src/mongo/attachments.js', () => ({
  uploadAttachmentBuffer: vi.fn(async ({ buffer, filename, contentType, ownerType, ownerId }) => {
    const id = new ObjectId();
    uploaded.push({ id, buffer, filename, contentType, ownerType, ownerId });
    stored.set(id.toString(), { buffer, contentType });
    return {
      _id: id,
      filename,
      content_type: contentType,
      size: buffer?.length || 0,
      uploaded_at: new Date(),
    };
  }),
  readAttachmentBuffer: vi.fn(async (id) => {
    const rec = stored.get(String(id));
    if (!rec) return null;
    return { buffer: rec.buffer, file: { _id: id, contentType: rec.contentType } };
  }),
}));

const Storyboards = await import('../src/mongo/storyboards.js');
const AudioTranscode = await import('../src/web/audioTranscode.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter());
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(() => resolve()));
  AudioTranscode.__setAudioFfmpegImplForTests(null);
});

let ffmpegCalls;
beforeEach(() => {
  fakeDb.reset();
  uploaded.length = 0;
  stored.clear();
  ffmpegCalls = 0;
  // Default fake ffmpeg: write recognizable "mp3" bytes to the output path.
  AudioTranscode.__setAudioFfmpegImplForTests(async ({ outputPath }) => {
    ffmpegCalls += 1;
    fs.writeFileSync(outputPath, Buffer.from('ID3-converted'));
  });
});

async function postAudio(path, { bytes, type, name }) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), name);
  const res = await fetch(`${baseUrl}/api${path}`, { method: 'POST', body: fd });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

describe('POST /storyboard/:id/audio MP3 normalization', () => {
  const beatId = new ObjectId();

  it('transcodes a webm recording to MP3 before storing', async () => {
    const sb = await Storyboards.createStoryboard({ beatId, order: 1 });
    const { status } = await postAudio(`/storyboard/${sb._id}/audio`, {
      bytes: Buffer.from('webm-opus-bytes'),
      type: 'audio/webm',
      name: 'recording-123.webm',
    });
    expect(status).toBe(200);
    expect(ffmpegCalls).toBe(1);
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].contentType).toBe('audio/mpeg');
    expect(uploaded[0].filename).toMatch(/\.mp3$/);
    expect(uploaded[0].buffer.toString()).toBe('ID3-converted');
  });

  it('stores an already-MP3 upload unchanged (no transcode)', async () => {
    const sb = await Storyboards.createStoryboard({ beatId, order: 1 });
    const { status } = await postAudio(`/storyboard/${sb._id}/audio`, {
      bytes: Buffer.from('real-mp3-bytes'),
      type: 'audio/mpeg',
      name: 'voice.mp3',
    });
    expect(status).toBe(200);
    expect(ffmpegCalls).toBe(0);
    expect(uploaded[0].contentType).toBe('audio/mpeg');
    expect(uploaded[0].filename).toBe('voice.mp3');
    expect(uploaded[0].buffer.toString()).toBe('real-mp3-bytes');
  });

  it('returns 503 when ffmpeg is not installed', async () => {
    AudioTranscode.__setAudioFfmpegImplForTests(async () => {
      throw new AudioTranscode.FfmpegMissingError();
    });
    const sb = await Storyboards.createStoryboard({ beatId, order: 1 });
    const { status, json } = await postAudio(`/storyboard/${sb._id}/audio`, {
      bytes: Buffer.from('webm-opus-bytes'),
      type: 'audio/webm',
      name: 'recording-123.webm',
    });
    expect(status).toBe(503);
    expect(json.error).toMatch(/ffmpeg/i);
    expect(uploaded).toHaveLength(0);
  });

  it('returns 422 when transcoding fails', async () => {
    AudioTranscode.__setAudioFfmpegImplForTests(async () => {
      throw new AudioTranscode.AudioTranscodeError('bad input');
    });
    const sb = await Storyboards.createStoryboard({ beatId, order: 1 });
    const { status, json } = await postAudio(`/storyboard/${sb._id}/audio`, {
      bytes: Buffer.from('garbage'),
      type: 'audio/webm',
      name: 'recording-123.webm',
    });
    expect(status).toBe(422);
    expect(json.error).toMatch(/MP3/i);
    expect(uploaded).toHaveLength(0);
  });
});
