// Tests for PATCH /api/beat/:id — the endpoint the SPA calls to update a
// beat's cast (characters array) and/or order. Cast-change announcing was
// centralized into updateBeatViaGateway and now fires only inside an active
// currentEditor() scope (see tests/web-edit-attribution.test.js for the
// positive case). This file mocks requireSession() as a pass-through that
// never sets req.session, so the router's attribution middleware always
// calls runAsEditor(undefined, ...) here and activates no editor scope —
// that's why a plain PATCH stays silent below. In production this route DOES
// announce, attributed to the logged-in user.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
// Mutable module-level session, read by the requireSession mock below. Tests
// that want a logged-in user set sessionState.current and must reset it
// (e.g. in afterEach) so the other tests' "no session" assumption holds.
const sessionState = vi.hoisted(() => ({ current: undefined }));

vi.mock('../src/web/auth.js', () => ({
  requireSession: () => (req, _res, next) => {
    req.session = sessionState.current;
    next();
  },
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
vi.mock('../src/web/editAnnounce.js', () => ({
  diffCast: (oldNames, newNames) => {
    const norm = (s) => String(s).trim().toLowerCase();
    const oldSet = new Set((oldNames || []).map(norm));
    const newSet = new Set((newNames || []).map(norm));
    return {
      added: (newNames || []).filter((n) => !oldSet.has(norm(n))),
      removed: (oldNames || []).filter((n) => !newSet.has(norm(n))),
    };
  },
  maybeAnnounceCast: vi.fn(),
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');
const { maybeAnnounceCast } = await import('../src/web/editAnnounce.js');

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
  vi.clearAllMocks();
  sessionState.current = undefined;
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

describe('PATCH /api/beat/:id (cast)', () => {
  it('returns 200 with the updated beat when adding a character', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Scene 1', body: 'body' });
    const { status, json } = await patch(`/api/beat/${beat._id}`, {
      characters: ['Alice'],
    });
    expect(status).toBe(200);
    expect(json.beat.characters).toContain('Alice');
  });

  it('does NOT call maybeAnnounceCast when characters change but no editor scope is active', async () => {
    // Announcing now happens inside updateBeatViaGateway, gated on
    // currentEditor() (AsyncLocalStorage). This test mocks out requireSession
    // and never sets a session, so the attribution middleware activates no
    // editor scope and the cast change stays silent. In production this
    // route DOES announce, attributed to the logged-in user.
    const beat = await Plots.createBeat({
      projectId,
      name: 'Scene 1',
      body: 'body',
      characters: ['Alice'],
    });
    await patch(`/api/beat/${beat._id}`, { characters: ['Alice', 'Bob'] });
    // Allow the event loop to finish any fire-and-forget call.
    await new Promise((r) => setTimeout(r, 0));
    expect(maybeAnnounceCast).not.toHaveBeenCalled();
  });

  it('does NOT call maybeAnnounceCast when characters are unchanged', async () => {
    const beat = await Plots.createBeat({
      projectId,
      name: 'Scene 1',
      body: 'body',
      characters: ['Alice'],
    });
    await patch(`/api/beat/${beat._id}`, { characters: ['Alice'] });
    await new Promise((r) => setTimeout(r, 0));
    expect(maybeAnnounceCast).not.toHaveBeenCalled();
  });

  it('does NOT call maybeAnnounceCast when patching only order', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Scene 1', body: 'body' });
    await patch(`/api/beat/${beat._id}`, { order: beat.order });
    await new Promise((r) => setTimeout(r, 0));
    expect(maybeAnnounceCast).not.toHaveBeenCalled();
  });

  it('calls maybeAnnounceCast attributed to the logged-in user when a real session is present', async () => {
    // Exercises the production chain: requireSession -> attribution
    // middleware -> req.session.username -> runAsEditor scope ->
    // updateBeatViaGateway -> maybeAnnounceCast. The other tests in this file
    // leave sessionState.current undefined (no session); this is the one
    // positive case.
    sessionState.current = { username: 'Steve' };
    const beat = await Plots.createBeat({
      projectId,
      name: 'Scene 1',
      body: 'body',
      characters: ['Alice'],
    });
    await patch(`/api/beat/${beat._id}`, { characters: ['Alice', 'Bob'] });
    // Allow the event loop to finish the fire-and-forget maybeAnnounceCast call.
    await new Promise((r) => setTimeout(r, 0));
    expect(maybeAnnounceCast).toHaveBeenCalledTimes(1);
    expect(maybeAnnounceCast).toHaveBeenCalledWith(
      expect.objectContaining({
        editor: 'Steve',
        added: ['Bob'],
        removed: [],
      }),
    );
    sessionState.current = undefined;
  });

  it('returns 400 when no recognized fields provided', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Scene 1', body: 'body' });
    const { status, json } = await patch(`/api/beat/${beat._id}`, { foo: 'bar' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/no patch fields/);
  });

  it('returns 404 for an unknown beat', async () => {
    const { status } = await patch(`/api/beat/999`, { characters: ['Alice'] });
    expect(status).toBe(404);
  });
});
