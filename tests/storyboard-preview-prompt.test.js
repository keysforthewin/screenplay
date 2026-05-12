// Tests for POST /api/storyboards/preview-prompt — the read-only endpoint
// that returns the exact Stage A (outline) system + user messages that
// would be sent to the planner. Deterministic; no LLM call.

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

vi.mock('../src/mongo/images.js', () => ({
  readImageBuffer: vi.fn(async () => null),
  uploadGeneratedImage: vi.fn(async () => ({})),
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

beforeEach(() => {
  fakeDb.reset();
});

async function postJson(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

describe('POST /api/storyboards/preview-prompt', () => {
  it('returns the Stage A system + user messages for a beat', async () => {
    await Characters.createCharacter({
      name: 'Alice',
      fields: { role: 'protagonist' },
    });
    await Characters.createCharacter({ name: 'Bob' });
    const beat = await Plots.createBeat({
      name: 'Diner reunion',
      desc: 'Alice meets Bob at the diner.',
      body: 'Alice arrives at the diner. She finds Bob in the back booth.',
      characters: ['Alice', 'Bob'],
    });

    const { status, json } = await postJson('/api/storyboards/preview-prompt', {
      beat_id: beat._id.toString(),
      count: 9,
    });
    expect(status).toBe(200);
    expect(typeof json.system).toBe('string');
    expect(json.system).toMatch(/Hollywood storyboard artist/);
    expect(typeof json.user).toBe('string');
    expect(json.user).toMatch(/Diner reunion/);
    expect(json.user).toMatch(/Alice meets Bob at the diner/);
    expect(json.user).toMatch(/Alice arrives at the diner/);
    expect(json.user).toMatch(/- Alice — protagonist/);
    expect(json.user).toMatch(/- Bob/);
    expect(json.user).toMatch(/EXACTLY 9 frames/);
    expect(json.user).toMatch(/Produce 9 cinematic storyboard frames/);
    // Without `direction` the user message must not advertise an empty block.
    expect(json.user).not.toMatch(/Director's direction:/);
  });

  it('includes the director direction when provided', async () => {
    const beat = await Plots.createBeat({
      name: 'B',
      desc: 'd',
      body: 'b',
      characters: [],
    });
    const { status, json } = await postJson('/api/storyboards/preview-prompt', {
      beat_id: beat._id.toString(),
      count: 5,
      direction: 'lean handheld and dirty over-the-shoulders',
    });
    expect(status).toBe(200);
    expect(json.user).toMatch(/Director's direction:/);
    expect(json.user).toMatch(/lean handheld and dirty over-the-shoulders/);
  });

  it('defaults to DEFAULT_TARGET_COUNT (11) when count is omitted', async () => {
    const beat = await Plots.createBeat({
      name: 'B',
      desc: 'd',
      body: 'b',
      characters: [],
    });
    const { status, json } = await postJson('/api/storyboards/preview-prompt', {
      beat_id: beat._id.toString(),
    });
    expect(status).toBe(200);
    expect(json.user).toMatch(/EXACTLY 11 frames/);
  });

  it('returns 400 when beat_id is missing', async () => {
    const { status } = await postJson('/api/storyboards/preview-prompt', {});
    expect(status).toBe(400);
  });

  it('returns 404 when the beat does not exist', async () => {
    const { status } = await postJson('/api/storyboards/preview-prompt', {
      beat_id: '0000aaaa0000aaaa0000aaaa',
    });
    expect(status).toBe(404);
  });
});
