// REST surface of the wardrobe lock: the plate setter on a character, the
// per-beat overrides on PATCH /beat/:id, and the cast listing that carries
// both for the critique tab's wardrobe strip.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({ getDb: () => fakeDb, connectMongo: async () => fakeDb }));
vi.mock('../src/web/auth.js', () => ({ requireSession: () => (_req, _res, next) => next() }));
vi.mock('../src/log.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/rag/queue.js', () => ({ enqueueReindex: () => {} }));
vi.mock('../src/rag/indexer.js', () => ({ deleteEntity: async () => {}, deleteProjectChunks: async () => {} }));
vi.mock('../src/discord/announcer.js', () => ({ announceMediaEvent: async () => {}, announceText: async () => {} }));

const Projects = await import('../src/mongo/projects.js');
const Characters = await import('../src/mongo/characters.js');
const Plots = await import('../src/mongo/plots.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server;
let baseUrl;
let p1;

beforeAll(async () => {
  const app = express();
  app.use('/api', buildApiRouter());
  await new Promise((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(() => r())); });
beforeEach(async () => {
  fakeDb.reset();
  p1 = (await Projects.createProject('Alpha'))._id.toString();
});

const get = (path) => fetch(`${baseUrl}/api${path}`, { headers: { 'X-Project-Id': p1 } });
const send = (method) => (path, body) =>
  fetch(`${baseUrl}/api${path}`, { method, headers: { 'content-type': 'application/json', 'X-Project-Id': p1 }, body: JSON.stringify(body) });
const post = send('POST');
const patch = send('PATCH');

describe('POST /character/:id/wardrobe-image', () => {
  it('sets, rejects a foreign image, and clears on null', async () => {
    const c = await Characters.createCharacter({ projectId: p1, name: 'Sarah' });
    const cid = c._id.toString();
    const img = new ObjectId();
    await Characters.pushCharacterImage(p1, cid, { _id: img, filename: 'g.png' }, false);
    let r = await post(`/character/${cid}/wardrobe-image`, { image_id: img.toString() });
    expect(r.status).toBe(200);
    expect(String((await r.json()).wardrobe_image_id)).toBe(img.toString());
    expect((await Characters.getCharacter(p1, cid)).wardrobe_image_id.equals(img)).toBe(true);

    r = await post(`/character/${cid}/wardrobe-image`, { image_id: 'nope' });
    expect(r.status).toBe(400);
    r = await post(`/character/${cid}/wardrobe-image`, { image_id: new ObjectId().toString() });
    expect(r.status).toBeGreaterThanOrEqual(400);

    r = await post(`/character/${cid}/wardrobe-image`, { image_id: null });
    expect(r.status).toBe(200);
    expect((await Characters.getCharacter(p1, cid)).wardrobe_image_id).toBeNull();
    expect((await post(`/character/${new ObjectId()}/wardrobe-image`, { image_id: null })).status).toBeGreaterThanOrEqual(400);
  });
});

describe('beat wardrobe overrides', () => {
  it('PATCH /beat/:id merges overrides and GET /beat/:id/characters returns them with each plate', async () => {
    const c = await Characters.createCharacter({ projectId: p1, name: 'Sarah', fields: { wardrobe: 'grey coat' } });
    const cid = c._id.toString();
    const plate = new ObjectId();
    await Characters.pushCharacterImage(p1, cid, { _id: plate, filename: 'p.png' }, false);
    await post(`/character/${cid}/wardrobe-image`, { image_id: plate.toString() });
    const beat = await Plots.createBeat({ projectId: p1, name: 'B', characters: ['Sarah'] });
    const bid = beat._id.toString();

    let r = await patch(`/beat/${bid}`, { wardrobe_overrides: { [cid]: ' coat off ' } });
    expect(r.status).toBe(200);
    expect((await r.json()).beat.wardrobe_overrides).toEqual({ [cid]: 'coat off' });

    r = await get(`/beat/${bid}/characters`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.wardrobe_overrides).toEqual({ [cid]: 'coat off' });
    expect(body.characters[0]).toMatchObject({ _id: cid, name: 'Sarah', wardrobe_image_id: plate.toString() });
    expect(body.characters[0].fields.wardrobe).toBe('grey coat');

    r = await patch(`/beat/${bid}`, { wardrobe_overrides: { [cid]: '' } });
    expect((await r.json()).beat.wardrobe_overrides).toEqual({});
    expect((await patch(`/beat/${bid}`, { wardrobe_overrides: 'x' })).status).toBe(400);
  });
});
