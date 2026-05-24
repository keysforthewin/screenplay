// Tests for the "Grab last frame from previous storyboard's video" path.
// Covers the previous-shot helper, the module that orchestrates ffmpeg +
// GridFS, and the HTTP route that surfaces friendly errors when the previous
// shot has no video.

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

// Mock the GridFS-touching helpers so we don't need a real bucket. The grab
// module reads `streamAttachmentToTmp` for the video and `uploadGeneratedImage`
// for the extracted frame.
vi.mock('../src/mongo/attachments.js', () => ({
  streamAttachmentToTmp: vi.fn(async (id) => ({
    path: `/tmp/fake-video-${id}.mp4`,
    file: { _id: id, filename: 'fake.mp4', contentType: 'video/mp4' },
  })),
}));

const uploadedImages = [];
vi.mock('../src/mongo/images.js', () => ({
  uploadGeneratedImage: vi.fn(async ({ buffer, contentType, ownerType, ownerId, filename }) => {
    const id = new ObjectId();
    uploadedImages.push({ id, buffer, contentType, ownerType, ownerId, filename });
    return {
      _id: id,
      filename,
      content_type: contentType,
      size: buffer?.length || 0,
      uploaded_at: new Date(),
    };
  }),
}));

vi.mock('../src/mongo/imageBytes.js', () => ({
  validateImageBuffer: vi.fn(() => 'image/jpeg'),
}));

const Storyboards = await import('../src/mongo/storyboards.js');
const GrabFrame = await import('../src/web/storyboardGrabFrame.js');
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
  GrabFrame.__setExtractLastFrameImplForTests(null);
});

beforeEach(() => {
  fakeDb.reset();
  uploadedImages.length = 0;
  // Default: fake ffmpeg succeeds by writing a tiny JPEG to outputPath. Each
  // test can override by calling __setExtractLastFrameImplForTests directly.
  GrabFrame.__setExtractLastFrameImplForTests(async ({ outputPath }) => {
    // Minimal valid-looking JPEG header bytes; validateImageBuffer is mocked
    // so the actual content doesn't matter, just that the file exists with
    // some bytes.
    fs.writeFileSync(outputPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
  });
});

async function post(path, body) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

describe('getPreviousStoryboardInBeat', () => {
  const beatId = new ObjectId();

  it('returns the shot with the next-lower order in the same beat', async () => {
    const a = await Storyboards.createStoryboard({ beatId, order: 1 });
    const b = await Storyboards.createStoryboard({ beatId, order: 2 });
    const c = await Storyboards.createStoryboard({ beatId, order: 3 });
    const prevOfC = await Storyboards.getPreviousStoryboardInBeat(beatId, c.order);
    expect(prevOfC._id.toString()).toBe(b._id.toString());
    const prevOfB = await Storyboards.getPreviousStoryboardInBeat(beatId, b.order);
    expect(prevOfB._id.toString()).toBe(a._id.toString());
  });

  it('returns null when current is the first shot in the beat', async () => {
    const a = await Storyboards.createStoryboard({ beatId, order: 1 });
    const prev = await Storyboards.getPreviousStoryboardInBeat(beatId, a.order);
    expect(prev).toBe(null);
  });

  it('ignores shots from other beats', async () => {
    const otherBeat = new ObjectId();
    await Storyboards.createStoryboard({ beatId: otherBeat, order: 1 });
    const a = await Storyboards.createStoryboard({ beatId, order: 1 });
    const prev = await Storyboards.getPreviousStoryboardInBeat(beatId, a.order);
    expect(prev).toBe(null);
  });
});

describe('POST /storyboard/:id/grab-frame-from-previous', () => {
  const beatId = new ObjectId();

  it('returns 400 when there is no previous shot', async () => {
    const only = await Storyboards.createStoryboard({ beatId, order: 1 });
    const { status, json } = await post(
      `/storyboard/${only._id}/grab-frame-from-previous`,
    );
    expect(status).toBe(400);
    expect(json.error).toMatch(/no previous storyboard/);
  });

  it('returns 400 when the previous shot has no generated video', async () => {
    const prev = await Storyboards.createStoryboard({ beatId, order: 1 });
    expect(prev.frames).toEqual([]); // sanity
    const cur = await Storyboards.createStoryboard({ beatId, order: 2 });
    const { status, json } = await post(
      `/storyboard/${cur._id}/grab-frame-from-previous`,
    );
    expect(status).toBe(400);
    expect(json.error).toMatch(/no generated video/);
  });

  it('adds a new frame holding the grabbed image on success', async () => {
    const prevVideoId = new ObjectId();
    const prev = await Storyboards.createStoryboard({ beatId, order: 1 });
    await Storyboards.updateStoryboard(prev._id, {
      video_file_id: prevVideoId,
    });
    const cur = await Storyboards.createStoryboard({ beatId, order: 2 });

    const { status, json } = await post(
      `/storyboard/${cur._id}/grab-frame-from-previous`,
    );
    expect(status).toBe(200);
    expect(json.image._id).toBeDefined();
    expect(json.image.content_type).toBe('image/jpeg');
    expect(json.frame_id).toBeDefined();

    // The gateway should have added a frame holding the grabbed image.
    const fresh = await Storyboards.getStoryboard(cur._id);
    expect(fresh.frames).toHaveLength(1);
    expect(fresh.frames[0].image_id.toString()).toBe(json.image._id.toString());
    expect(fresh.frames[0]._id.toString()).toBe(json.frame_id);

    // And we should have one upload, owned by the beat.
    expect(uploadedImages).toHaveLength(1);
    expect(uploadedImages[0].ownerType).toBe('beat');
    expect(uploadedImages[0].ownerId.toString()).toBe(beatId.toString());
    expect(uploadedImages[0].contentType).toBe('image/jpeg');
  });

  it('surfaces ffmpeg failures as 500 with a readable message', async () => {
    GrabFrame.__setExtractLastFrameImplForTests(async () => {
      throw new GrabFrame.FfmpegFailedError('codec not supported');
    });
    const prevVideoId = new ObjectId();
    const prev = await Storyboards.createStoryboard({ beatId, order: 1 });
    await Storyboards.updateStoryboard(prev._id, { video_file_id: prevVideoId });
    const cur = await Storyboards.createStoryboard({ beatId, order: 2 });
    const { status, json } = await post(
      `/storyboard/${cur._id}/grab-frame-from-previous`,
    );
    expect(status).toBe(500);
    expect(json.error).toMatch(/ffmpeg failed/i);
  });
});
