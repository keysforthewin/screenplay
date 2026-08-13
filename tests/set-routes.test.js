// REST surface for sets: reads, create/delete, character create, media
// routes, picker source listing, and the TOC's sets array.
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
vi.mock('../src/rag/queue.js', () => ({ enqueueReindex: () => {} }));
vi.mock('../src/rag/indexer.js', () => ({
  deleteEntity: async () => {},
  deleteProjectChunks: async () => {},
}));
const deleteImage = vi.fn(async () => {});
const deleteImages = vi.fn(async () => {});
vi.mock('../src/mongo/images.js', async (importOriginal) => ({
  ...(await importOriginal()),
  deleteImage: (...a) => deleteImage(...a),
  deleteImages: (...a) => deleteImages(...a),
}));
vi.mock('../src/discord/announcer.js', () => ({
  announceMediaEvent: async () => {},
  announceText: async () => {},
}));

const Projects = await import('../src/mongo/projects.js');
const Sets = await import('../src/mongo/sets.js');
const Characters = await import('../src/mongo/characters.js');
const Plots = await import('../src/mongo/plots.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server;
let baseUrl;
let p1;

beforeAll(async () => {
  const app = express();
  app.use('/api', buildApiRouter());
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(() => r()));
});
beforeEach(async () => {
  fakeDb.reset();
  deleteImage.mockClear();
  deleteImages.mockClear();
  p1 = (await Projects.createProject('Alpha'))._id.toString();
});

const get = (path) => fetch(`${baseUrl}/api${path}`, { headers: { 'X-Project-Id': p1 } });
const post = (path, body) =>
  fetch(`${baseUrl}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Project-Id': p1 },
    body: JSON.stringify(body),
  });
const del = (path) =>
  fetch(`${baseUrl}/api${path}`, { method: 'DELETE', headers: { 'X-Project-Id': p1 } });

describe('set reads', () => {
  it('GET /set?name= resolves by name and 404s on a miss', async () => {
    const s = await Sets.createSet({ projectId: p1, name: '**Kitchen**' });
    const r = await get('/set?name=kitchen');
    expect(r.status).toBe(200);
    expect((await r.json()).set._id).toBe(s._id.toString());
    expect((await get('/set?name=nope')).status).toBe(404);
    expect((await get('/set')).status).toBe(400);
  });

  it('GET /set/:id/images filters artwork results out', async () => {
    const s = await Sets.createSet({ projectId: p1, name: 'Kitchen' });
    const galleryId = new ObjectId();
    const artId = new ObjectId();
    for (const [id, extra] of [
      [galleryId, {}],
      [artId, {}],
    ]) {
      await fakeDb.collection('images.files').insertOne({
        _id: id,
        filename: `${id}.png`,
        length: 5,
        uploadDate: new Date(),
        metadata: { project_id: p1, owner_type: 'set', owner_id: s._id, ...extra },
      });
    }
    await Sets.pushSetImage(p1, s._id.toString(), { _id: galleryId });
    await Sets.pushSetArtwork(p1, s._id.toString(), {
      _id: new ObjectId(),
      status: 'done',
      result_image_id: artId,
    });
    const r = await get(`/set/${s._id.toString()}/images`);
    expect(r.status).toBe(200);
    const { images } = await r.json();
    expect(images.map((i) => i._id)).toEqual([galleryId.toString()]);
  });

  it('GET /images/by-owner/sets joins the owning set name', async () => {
    const s = await Sets.createSet({ projectId: p1, name: 'Kitchen' });
    const imgId = new ObjectId();
    await fakeDb.collection('images.files').insertOne({
      _id: imgId,
      filename: 'k.png',
      length: 5,
      uploadDate: new Date(),
      metadata: { project_id: p1, owner_type: 'set', owner_id: s._id },
    });
    const r = await get('/images/by-owner/sets');
    expect(r.status).toBe(200);
    const { images } = await r.json();
    expect(images).toHaveLength(1);
    expect(images[0].owner_name).toBe('Kitchen');
  });

  it('GET /toc includes sets with reverse-linked beats', async () => {
    await Sets.createSet({ projectId: p1, name: '**Kitchen**' });
    await Plots.createBeat({ projectId: p1, desc: 'One', sets: ['Kitchen'] });
    const r = await get('/toc');
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.sets).toHaveLength(1);
    expect(body.sets[0].plain_name).toBe('Kitchen');
    expect(body.sets[0].beats).toEqual([{ order: 1, plain_name: 'One' }]);
    expect(body.sets[0].search_text).toContain('kitchen');
  });
});

describe('set create/delete + character create', () => {
  it('POST /set creates (201), rejects empty (400) and duplicates (409)', async () => {
    const r = await post('/set', { name: 'Kitchen', description: 'Greasy.' });
    expect(r.status).toBe(201);
    const { set } = await r.json();
    expect(set.name).toBe('Kitchen');
    expect((await post('/set', { name: '   ' })).status).toBe(400);
    expect((await post('/set', {})).status).toBe(400);
    expect((await post('/set', { name: '**KITCHEN**' })).status).toBe(409);
  });

  it('DELETE /set/:id is gone — set deletion is agent-only (gateway)', async () => {
    const s = await Sets.createSet({ projectId: p1, name: 'Kitchen' });
    const r = await del(`/set/${s._id.toString()}`);
    expect(r.status).toBe(404);
    expect(await Sets.getSet(p1, 'kitchen')).not.toBe(null);
  });

  it('POST /character creates (201) and rejects duplicates (409)', async () => {
    const r = await post('/character', { name: 'Steve', hollywood_actor: 'Actor' });
    expect(r.status).toBe(201);
    expect((await r.json()).character.name).toBe('Steve');
    expect((await Characters.getCharacter(p1, 'steve')).hollywood_actor).toBe('Actor');
    expect((await post('/character', { name: 'steve' })).status).toBe(409);
    expect((await post('/character', { name: '' })).status).toBe(400);
  });
});

describe('storyboard readiness routes', () => {
  it('POST /storyboards/readiness 202s and the job becomes pollable', async () => {
    const Readiness = await import('../src/web/storyboardReadiness.js');
    Readiness._setGapReporterForTests(async () => ({ gaps: [], summary: '' }));
    try {
      const beat = await Plots.createBeat({ projectId: p1, desc: 'One' });
      const r = await post('/storyboards/readiness', { beat_id: beat._id.toString() });
      expect(r.status).toBe(202);
      const { job_id } = await r.json();
      let job;
      for (let i = 0; i < 100; i++) {
        const jr = await get(`/storyboards/readiness/${job_id}`);
        expect(jr.status).toBe(200);
        ({ job } = await jr.json());
        if (['done', 'error'].includes(job.status)) break;
        await new Promise((res) => setTimeout(res, 10));
      }
      expect(job.status).toBe('done');
      expect(Array.isArray(job.report.checks)).toBe(true);
      expect((await post('/storyboards/readiness', { beat_id: 'nope' })).status).toBe(400);
      expect((await get('/storyboards/readiness/unknown-job')).status).toBe(404);
    } finally {
      Readiness._setGapReporterForTests(null);
    }
  });
});

describe('set media routes', () => {
  it('POST /set/:id/main-image switches main; image attach/remove round-trips', async () => {
    const s = await Sets.createSet({ projectId: p1, name: 'Kitchen' });
    const sid = s._id.toString();
    const a = new ObjectId();
    const b = new ObjectId();
    await Sets.pushSetImage(p1, sid, { _id: a });
    await Sets.pushSetImage(p1, sid, { _id: b });
    const r = await post(`/set/${sid}/main-image`, { image_id: b.toString() });
    expect(r.status).toBe(200);
    expect((await Sets.getSet(p1, sid)).main_image_id.equals(b)).toBe(true);

    const rd = await del(`/set/${sid}/image/${a.toString()}`);
    expect(rd.status).toBe(200);
    expect(deleteImage).toHaveBeenCalled();
    expect((await Sets.getSet(p1, sid)).images).toHaveLength(1);
  });

  it('POST /set/:id/image/attach claims a library image', async () => {
    const s = await Sets.createSet({ projectId: p1, name: 'Kitchen' });
    const imgId = new ObjectId();
    await fakeDb.collection('images.files').insertOne({
      _id: imgId,
      filename: 'lib.png',
      contentType: 'image/png',
      length: 9,
      uploadDate: new Date(),
      metadata: { project_id: p1, owner_type: null, owner_id: null },
    });
    const r = await post(`/set/${s._id.toString()}/image/attach`, {
      image_id: imgId.toString(),
    });
    expect(r.status).toBe(200);
    const file = await fakeDb.collection('images.files').findOne({ _id: imgId });
    expect(file.metadata.owner_type).toBe('set');
    expect((await Sets.getSet(p1, 'kitchen')).images).toHaveLength(1);
  });

  it('DELETE /set/:id/orphan-image/:imageId only deletes non-gallery set images', async () => {
    const s = await Sets.createSet({ projectId: p1, name: 'Kitchen' });
    const orphan = new ObjectId();
    await fakeDb.collection('images.files').insertOne({
      _id: orphan,
      filename: 'o.png',
      length: 3,
      uploadDate: new Date(),
      metadata: { project_id: p1, owner_type: 'set', owner_id: s._id },
    });
    const r = await del(`/set/${s._id.toString()}/orphan-image/${orphan.toString()}`);
    expect(r.status).toBe(200);
    expect(deleteImage).toHaveBeenCalled();
    // A gallery image is refused.
    const inGallery = new ObjectId();
    await fakeDb.collection('images.files').insertOne({
      _id: inGallery,
      filename: 'g.png',
      length: 3,
      uploadDate: new Date(),
      metadata: { project_id: p1, owner_type: 'set', owner_id: s._id },
    });
    await Sets.pushSetImage(p1, s._id.toString(), { _id: inGallery });
    const r2 = await del(`/set/${s._id.toString()}/orphan-image/${inGallery.toString()}`);
    expect(r2.status).toBe(409);
  });

  it('set artwork routes are registered (from-image import works)', async () => {
    const s = await Sets.createSet({ projectId: p1, name: 'Kitchen' });
    const imgId = new ObjectId();
    await fakeDb.collection('images.files').insertOne({
      _id: imgId,
      filename: 'art.png',
      contentType: 'image/png',
      length: 9,
      uploadDate: new Date(),
      metadata: { project_id: p1, owner_type: 'set', owner_id: s._id },
    });
    const r = await post(`/set/${s._id.toString()}/artwork/from-image`, {
      image_id: imgId.toString(),
      name: 'Imported plate',
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.artwork.status).toBe('done');
    expect((await Sets.getSet(p1, 'kitchen')).artworks).toHaveLength(1);
  });
});
