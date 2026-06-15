// Tests for PATCH /api/beat/:id/text — the endpoint the AI-chat undo/redo
// buttons call to restore a beat's text fields. With Hocuspocus not running
// (as in tests), the gateway falls back to writing Mongo directly.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
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
vi.mock('../src/web/announceHelpers.js', () => ({
  announceBeatMedia: vi.fn(),
  announceCharacterMedia: vi.fn(),
  announceNoteMedia: vi.fn(),
  announceStoryboardMedia: vi.fn(),
  announceLibraryMedia: vi.fn(),
  announceBatchSummary: vi.fn(),
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
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

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

async function patch(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe('PATCH /api/beat/:id/text', () => {
  it('restores all three text fields and persists to Mongo', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Old', desc: 'old d', body: 'old b' });
    const { status, json } = await patch(`/api/beat/${beat._id}/text`, {
      name: 'New name',
      desc: 'New desc',
      body: 'New body',
    });
    expect(status).toBe(200);
    expect(json.beat.name).toBe('New name');
    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.name).toBe('New name');
    expect(fresh.desc).toBe('New desc');
    expect(fresh.body).toBe('New body');
  });

  it('accepts a partial patch (body only) without touching other fields', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Keep', desc: 'keep d', body: 'old b' });
    const { status } = await patch(`/api/beat/${beat._id}/text`, { body: 'just body' });
    expect(status).toBe(200);
    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.name).toBe('Keep');
    expect(fresh.desc).toBe('keep d');
    expect(fresh.body).toBe('just body');
  });

  it('resolves a beat by order number in the URL', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Ordered', body: 'b' });
    const order = beat.order;
    const { status } = await patch(`/api/beat/${order}/text`, { name: 'By order' });
    expect(status).toBe(200);
    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.name).toBe('By order');
  });

  it('returns 400 when no text fields are provided', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'X', body: 'b' });
    const { status, json } = await patch(`/api/beat/${beat._id}/text`, { foo: 'bar' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/no text fields/);
  });

  it('returns 404 for an unknown beat', async () => {
    const { status } = await patch(`/api/beat/999/text`, { name: 'nope' });
    expect(status).toBe(404);
  });
});
