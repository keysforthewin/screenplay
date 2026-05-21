// Per-frame reference picker: when the user adds the OPPOSITE frame slot's
// current image (the "sibling") as a reference for *this* frame's regen, the
// server must snapshot the sibling's bytes into a fresh GridFS image and
// store the copy's id in the reference list — not the live sibling id. This
// decouples the reference from the sibling slot and avoids any same-id dedup
// the image model might do internally.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
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

const uploadCalls = [];

vi.mock('../src/mongo/images.js', async () => {
  const real = await vi.importActual('../src/mongo/images.js');
  return {
    ...real,
    readImageBuffer: async (id) => {
      const key = String(id);
      const docs = fakeDb.collection('images.files')._docs;
      const found = docs.find((d) => String(d._id) === key);
      if (!found) return null;
      return { buffer: Buffer.from(`bytes-${key}`), file: found };
    },
    findImageFile: async (id) => {
      const key = String(id);
      const docs = fakeDb.collection('images.files')._docs;
      return docs.find((d) => String(d._id) === key) || null;
    },
    uploadGeneratedImage: async (args) => {
      const id = new ObjectId();
      uploadCalls.push({
        filename: args.filename,
        ownerType: args.ownerType,
        ownerId: args.ownerId ? String(args.ownerId) : null,
      });
      // Persist so subsequent findImageFile / readImageBuffer can resolve it.
      fakeDb.collection('images.files')._docs.push({
        _id: id,
        filename: args.filename || 'copy.png',
        contentType: args.contentType,
        length: args.buffer?.length || 0,
        uploadDate: new Date(),
        metadata: {
          owner_type: args.ownerType,
          owner_id: args.ownerId,
          source: 'generated',
          prompt: args.prompt ?? null,
          generated_by: args.generatedBy ?? null,
          name: args.name ?? '',
          description: args.description ?? '',
        },
      });
      return {
        _id: id,
        filename: args.filename || 'copy.png',
        content_type: args.contentType,
        size: args.buffer?.length || 0,
        metadata: {},
        uploaded_at: new Date(),
      };
    },
  };
});

const Plots = await import('../src/mongo/plots.js');
const Storyboards = await import('../src/mongo/storyboards.js');
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
});

beforeEach(() => {
  fakeDb.reset();
  uploadCalls.length = 0;
});

function seedImage({ ownerType = 'beat', ownerId, name = '' } = {}) {
  const doc = {
    _id: new ObjectId(),
    filename: `${name || 'img'}.png`,
    contentType: 'image/png',
    length: 12,
    uploadDate: new Date(),
    metadata: {
      owner_type: ownerType ?? null,
      owner_id: ownerId ?? null,
      source: 'generated',
      prompt: null,
      generated_by: null,
      name,
      description: '',
    },
  };
  fakeDb.collection('images.files')._docs.push(doc);
  return doc;
}

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, json };
}

describe('per-frame reference set: sibling frame is snapshotted as a copy', () => {
  it('replaces the sibling image_id with a fresh copy when added via /reference/set', async () => {
    const beat = await Plots.createBeat({ name: 'Diner' });
    const sb = await Storyboards.createStoryboard({
      beatId: beat._id,
      textPrompt: 'Wide shot',
    });
    const endFrameFile = seedImage({ ownerId: beat._id, name: 'end' });
    const beatRefFile = seedImage({ ownerId: beat._id, name: 'beat-ref' });
    await Storyboards.updateStoryboard(sb._id, {
      end_frame_id: endFrameFile._id,
    });

    const { status, json } = await post(
      `/api/storyboard/${sb._id}/frame/start_frame/reference/set`,
      {
        image_ids: [String(beatRefFile._id), String(endFrameFile._id)],
      },
    );

    expect(status).toBe(200);
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].ownerType).toBe('beat');
    expect(uploadCalls[0].ownerId).toBe(String(beat._id));
    expect(uploadCalls[0].filename).toMatch(/from-end_frame/);

    const fresh = await Storyboards.getStoryboard(sb._id);
    const stored = (fresh.start_frame_reference_ids || []).map(String);
    expect(stored).toHaveLength(2);
    expect(stored).toContain(String(beatRefFile._id));
    // The end_frame image_id MUST NOT be stored directly — it should be the
    // copy's id (which is freshly allocated and not equal to endFrameFile._id).
    expect(stored).not.toContain(String(endFrameFile._id));
  });

  it('does NOT re-copy a sibling id that was already in the existing list (idempotent set)', async () => {
    // If a previous (pre-fix) Apply persisted the live sibling id, calling
    // set again with the same list shouldn't multiply copies — only newly-
    // added sibling references get snapshotted.
    const beat = await Plots.createBeat({ name: 'Diner' });
    const endFrameFile = seedImage({ ownerId: beat._id, name: 'end' });
    const sb = await Storyboards.createStoryboard({
      beatId: beat._id,
      textPrompt: 'Wide shot',
    });
    await Storyboards.updateStoryboard(sb._id, {
      end_frame_id: endFrameFile._id,
    });
    // Pretend an old client had already saved the sibling id directly.
    await Storyboards.setFrameReferenceImages(sb._id, 'start_frame', [
      endFrameFile._id,
    ]);

    const { status } = await post(
      `/api/storyboard/${sb._id}/frame/start_frame/reference/set`,
      { image_ids: [String(endFrameFile._id)] },
    );

    expect(status).toBe(200);
    expect(uploadCalls).toHaveLength(0); // already in existing list — pass-through
    const fresh = await Storyboards.getStoryboard(sb._id);
    expect((fresh.start_frame_reference_ids || []).map(String)).toEqual([
      String(endFrameFile._id),
    ]);
  });

  it('does NOT copy non-sibling reference ids', async () => {
    const beat = await Plots.createBeat({ name: 'Diner' });
    const sb = await Storyboards.createStoryboard({
      beatId: beat._id,
      textPrompt: 'Wide shot',
    });
    // No end_frame_id set on this storyboard.
    const refA = seedImage({ ownerId: beat._id, name: 'a' });
    const refB = seedImage({ ownerId: beat._id, name: 'b' });

    const { status } = await post(
      `/api/storyboard/${sb._id}/frame/start_frame/reference/set`,
      { image_ids: [String(refA._id), String(refB._id)] },
    );

    expect(status).toBe(200);
    expect(uploadCalls).toHaveLength(0);
    const fresh = await Storyboards.getStoryboard(sb._id);
    expect((fresh.start_frame_reference_ids || []).map(String)).toEqual([
      String(refA._id),
      String(refB._id),
    ]);
  });

  it('mirrors the behavior for end_frame regen with start_frame as sibling', async () => {
    const beat = await Plots.createBeat({ name: 'Diner' });
    const startFile = seedImage({ ownerId: beat._id, name: 'start' });
    const sb = await Storyboards.createStoryboard({
      beatId: beat._id,
      textPrompt: 'Wide shot',
    });
    await Storyboards.updateStoryboard(sb._id, {
      start_frame_id: startFile._id,
    });

    const { status } = await post(
      `/api/storyboard/${sb._id}/frame/end_frame/reference/set`,
      { image_ids: [String(startFile._id)] },
    );

    expect(status).toBe(200);
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].filename).toMatch(/from-start_frame/);
    const fresh = await Storyboards.getStoryboard(sb._id);
    const stored = (fresh.end_frame_reference_ids || []).map(String);
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toBe(String(startFile._id));
  });
});

describe('per-frame reference attach: sibling frame is snapshotted as a copy', () => {
  it('makes a copy when attaching the sibling via /reference/attach', async () => {
    const beat = await Plots.createBeat({ name: 'Diner' });
    const endFrameFile = seedImage({ ownerId: beat._id, name: 'end' });
    const sb = await Storyboards.createStoryboard({
      beatId: beat._id,
      textPrompt: 'Wide shot',
    });
    await Storyboards.updateStoryboard(sb._id, {
      end_frame_id: endFrameFile._id,
    });

    const { status, json } = await post(
      `/api/storyboard/${sb._id}/frame/start_frame/reference/attach`,
      { image_id: String(endFrameFile._id) },
    );

    expect(status).toBe(200);
    expect(uploadCalls).toHaveLength(1);
    expect(String(json?.image?._id)).not.toBe(String(endFrameFile._id));
    const fresh = await Storyboards.getStoryboard(sb._id);
    const stored = (fresh.start_frame_reference_ids || []).map(String);
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toBe(String(endFrameFile._id));
  });
});
