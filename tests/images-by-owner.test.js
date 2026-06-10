// Tests for the new GET /images/by-owner/characters and /images/by-owner/beats
// endpoints used by the EntityImagePickerModal's "Character" and "Beats" tabs.

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

const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
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

let pid;

beforeEach(async () => {
  fakeDb.reset();
  const Projects = await import('../src/mongo/projects.js');
  pid = (await Projects.getDefaultProject())._id.toString();
});

function seedImageFile({ ownerType, ownerId, kind, name, description, prompt }) {
  const doc = {
    _id: new ObjectId(),
    filename: `${ownerType || 'lib'}-${Date.now()}.png`,
    contentType: 'image/png',
    length: 4096,
    uploadDate: new Date(),
    metadata: {
      project_id: pid,
      owner_type: ownerType ?? null,
      owner_id: ownerId ?? null,
      source: 'generated',
      prompt: prompt || null,
      generated_by: 'gemini-2.5-flash-image',
      name: name || '',
      description: description || '',
      ...(kind ? { kind } : {}),
    },
  };
  fakeDb.collection('images.files')._docs.push(doc);
  return doc;
}

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, json: await res.json() };
}

describe('GET /api/images/by-owner/characters', () => {
  it('returns every character-owned image joined with owner_name', async () => {
    const a = await Characters.createCharacter({ name: 'Bronze Leopard' });
    const b = await Characters.createCharacter({ name: 'Silver Wolf' });
    const img1 = seedImageFile({ ownerType: 'character', ownerId: a._id, name: 'portrait' });
    const img2 = seedImageFile({ ownerType: 'character', ownerId: b._id, name: 'closeup' });
    // an unrelated library image and a beat image — neither should appear
    seedImageFile({ ownerType: null, ownerId: null, name: 'lib' });
    seedImageFile({ ownerType: 'beat', ownerId: new ObjectId() });

    const { status, json } = await get('/api/images/by-owner/characters');
    expect(status).toBe(200);
    expect(json.images).toHaveLength(2);
    const byId = new Map(json.images.map((i) => [String(i._id), i]));
    expect(byId.get(String(img1._id)).owner_name).toBe('Bronze Leopard');
    expect(byId.get(String(img2._id)).owner_name).toBe('Silver Wolf');
    expect(byId.get(String(img1._id)).owner_id).toBe(a._id.toString());
  });

  it('filters out the excluded character', async () => {
    const a = await Characters.createCharacter({ name: 'Bronze Leopard' });
    const b = await Characters.createCharacter({ name: 'Silver Wolf' });
    const keep = seedImageFile({ ownerType: 'character', ownerId: b._id });
    seedImageFile({ ownerType: 'character', ownerId: a._id });

    const { json } = await get(`/api/images/by-owner/characters?exclude_id=${a._id}`);
    expect(json.images).toHaveLength(1);
    expect(String(json.images[0]._id)).toBe(String(keep._id));
    expect(json.images[0].owner_name).toBe('Silver Wolf');
  });

  it('skips thumbnail-kind images', async () => {
    const a = await Characters.createCharacter({ name: 'Bronze Leopard' });
    const real = seedImageFile({ ownerType: 'character', ownerId: a._id });
    seedImageFile({ ownerType: 'character', ownerId: a._id, kind: 'thumbnail' });

    const { json } = await get('/api/images/by-owner/characters');
    expect(json.images).toHaveLength(1);
    expect(String(json.images[0]._id)).toBe(String(real._id));
  });

  it('returns an empty list when no character images exist', async () => {
    await Characters.createCharacter({ name: 'Bronze Leopard' });
    seedImageFile({ ownerType: null, ownerId: null });

    const { status, json } = await get('/api/images/by-owner/characters');
    expect(status).toBe(200);
    expect(json.images).toEqual([]);
  });
});

describe('GET /api/images/by-owner/beats', () => {
  it('returns every beat-owned image joined with owner_name and owner_order', async () => {
    const beat1 = await Plots.createBeat({ name: 'Cold open' });
    const beat2 = await Plots.createBeat({ name: 'Climax' });
    const img1 = seedImageFile({ ownerType: 'beat', ownerId: beat1._id, name: 'wide shot' });
    const img2 = seedImageFile({ ownerType: 'beat', ownerId: beat2._id, name: 'closeup' });
    seedImageFile({ ownerType: null, ownerId: null });
    seedImageFile({ ownerType: 'character', ownerId: new ObjectId() });

    const { status, json } = await get('/api/images/by-owner/beats');
    expect(status).toBe(200);
    expect(json.images).toHaveLength(2);
    const byId = new Map(json.images.map((i) => [String(i._id), i]));
    expect(byId.get(String(img1._id)).owner_name).toBe('Cold open');
    expect(byId.get(String(img1._id)).owner_order).toBe(1);
    expect(byId.get(String(img2._id)).owner_name).toBe('Climax');
    expect(byId.get(String(img2._id)).owner_order).toBe(2);
  });

  it('filters out the excluded beat', async () => {
    const beat1 = await Plots.createBeat({ name: 'Cold open' });
    const beat2 = await Plots.createBeat({ name: 'Climax' });
    seedImageFile({ ownerType: 'beat', ownerId: beat1._id });
    const keep = seedImageFile({ ownerType: 'beat', ownerId: beat2._id });

    const { json } = await get(`/api/images/by-owner/beats?exclude_id=${beat1._id}`);
    expect(json.images).toHaveLength(1);
    expect(String(json.images[0]._id)).toBe(String(keep._id));
    expect(json.images[0].owner_name).toBe('Climax');
  });

  it('skips thumbnail-kind images', async () => {
    const beat = await Plots.createBeat({ name: 'Diner' });
    const real = seedImageFile({ ownerType: 'beat', ownerId: beat._id });
    seedImageFile({ ownerType: 'beat', ownerId: beat._id, kind: 'thumbnail' });

    const { json } = await get('/api/images/by-owner/beats');
    expect(json.images).toHaveLength(1);
    expect(String(json.images[0]._id)).toBe(String(real._id));
  });
});
