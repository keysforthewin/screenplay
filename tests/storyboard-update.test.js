// Route-level tests for PATCH /api/storyboard/:id. Validates that the route
// exposes the new shot-metadata fields, surfaces clamp/validation errors with
// human-readable messages, and broadcasts the gateway's fields_updated ping.

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

const { createProject } = await import('../src/mongo/projects.js');
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

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

const beatId = new ObjectId();

async function patch(sbId, body) {
  const res = await fetch(`${baseUrl}/api/storyboard/${sbId}`, {
    method: 'PATCH',
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

describe('PATCH /api/storyboard/:id', () => {
  it('updates shot_type, duration_seconds, transition_in, characters_in_scene', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId });
    const { status, json } = await patch(sb._id.toString(), {
      shot_type: 'cinematic_wide',
      duration_seconds: 8,
      transition_in: 'Picks up after the door slam.',
      characters_in_scene: ['Alice'],
    });
    expect(status).toBe(200);
    expect(json.storyboard.shot_type).toBe('cinematic_wide');
    expect(json.storyboard.duration_seconds).toBe(8);
    expect(json.storyboard.transition_in).toBe('Picks up after the door slam.');
    expect(json.storyboard.characters_in_scene).toEqual(['Alice']);
  });

  it('clamps duration when shot_type is more restrictive', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId });
    const { status, json } = await patch(sb._id.toString(), {
      shot_type: 'close_up',
      duration_seconds: 12,
    });
    expect(status).toBe(200);
    expect(json.storyboard.shot_type).toBe('close_up');
    expect(json.storyboard.duration_seconds).toBe(5);
  });

  it('returns 400 with a useful message on invalid shot_type', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId });
    const { status, json } = await patch(sb._id.toString(), {
      shot_type: 'epic_montage',
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/shot_type must be one of/);
  });

  it('returns 400 on empty patch body', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId });
    const { status, json } = await patch(sb._id.toString(), {});
    expect(status).toBe(400);
    expect(json.error).toMatch(/no patch fields/);
  });

  it('returns 404 when the storyboard does not exist', async () => {
    const fakeId = new ObjectId().toString();
    const { status, json } = await patch(fakeId, { shot_type: 'close_up' });
    expect(status).toBe(404);
    expect(json.error).toMatch(/storyboard not found/);
  });

  it('ignores unknown fields and only persists recognized ones', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId });
    const { status, json } = await patch(sb._id.toString(), {
      shot_type: 'medium',
      vibes: 'noir',
    });
    expect(status).toBe(200);
    expect(json.storyboard.shot_type).toBe('medium');
    expect(json.storyboard.vibes).toBeUndefined();
  });

  it('accepts null to clear duration_seconds', async () => {
    const sb = await Storyboards.createStoryboard({ projectId,
      beatId,
      shotType: 'close_up',
      durationSeconds: 5,
    });
    const { status, json } = await patch(sb._id.toString(), {
      duration_seconds: null,
    });
    expect(status).toBe(200);
    expect(json.storyboard.duration_seconds).toBe(null);
    expect(json.storyboard.shot_type).toBe('close_up');
  });
});
