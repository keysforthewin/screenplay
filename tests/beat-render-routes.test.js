// REST surface for the beat renderer: preview, start (202/409/400/503), poll,
// SSE snapshot, and discarding the assembled video. beatRender.js is mocked so
// this exercises the route mapping, not the pipeline.
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
vi.mock('../src/mongo/auth.js', () => ({
  getSession: vi.fn(async (sid) => (sid === 'good' ? { session_id: 'good', username: 'tester' } : null)),
  touchSession: vi.fn(async () => {}),
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/web/hocuspocus.js', () => ({
  getRoomDocument: () => null,
  withDirectDocument: vi.fn(),
  broadcastRoomStateless: vi.fn(),
  isHocuspocusRunning: () => false,
}));
const deletedAttachments = [];
vi.mock('../src/mongo/attachments.js', async () => {
  const actual = await vi.importActual('../src/mongo/attachments.js');
  return { ...actual, deleteAttachment: vi.fn(async (id) => { deletedAttachments.push(String(id)); }) };
});

const renderStubs = { start: null, preview: null, jobs: new Map(), listeners: new Map() };
vi.mock('../src/web/beatRender.js', () => {
  class BeatRenderBusyError extends Error { constructor() { super('busy'); this.code = 'BEAT_BUSY'; } }
  class BeatRenderEmptyError extends Error { constructor(m = 'empty') { super(m); this.code = 'BEAT_RENDER_EMPTY'; } }
  return {
    BeatRenderBusyError,
    BeatRenderEmptyError,
    buildBeatRenderPreview: vi.fn(async (args) => renderStubs.preview(args)),
    startBeatRenderJob: vi.fn(async (args) => renderStubs.start(args)),
    getBeatRenderJob: vi.fn((id) => renderStubs.jobs.get(id) || null),
    serializeBeatJob: vi.fn((job) => ({ ...job })),
    subscribeToBeatJob: vi.fn((id, cb) => renderStubs.listeners.set(id, cb)),
    unsubscribeFromBeatJob: vi.fn((id) => renderStubs.listeners.delete(id)),
  };
});

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server;
let baseUrl;
let projectId;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter());
  await new Promise((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(() => resolve()));
});
beforeEach(async () => {
  fakeDb.reset();
  deletedAttachments.length = 0;
  renderStubs.jobs.clear();
  renderStubs.listeners.clear();
  renderStubs.preview = async ({ beatId, overrides, skipRendered }) => ({
    beat: { _id: String(beatId) }, overrides, skip_rendered: skipRendered, shots: [], counts: { to_render: 0 }, will_assemble: false,
  });
  renderStubs.start = async () => ({ job_id: 'beat-1', planned: 2, skipped: 1 });
  projectId = (await createProject('Routes Project'))._id.toString();
});

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

describe('beat render routes', () => {
  it('POST /beat/:id/render/preview forwards overrides + skip flag; 404 for an unknown beat', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Diner' });
    const r = await call('POST', `/beat/${beat.order}/render/preview`, { overrides: { video_direct: 'x/y' }, skip_rendered: false });
    expect(r.status).toBe(200);
    expect(r.json.beat._id).toBe(String(beat._id));
    expect(r.json.overrides).toEqual({ video_direct: 'x/y' });
    expect(r.json.skip_rendered).toBe(false);
    expect((await call('POST', '/beat/999/render/preview', {})).status).toBe(404);
  });

  it('rejects a non-string override with 400', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Diner' });
    const r = await call('POST', `/beat/${beat._id}/render`, { overrides: { lipsync: 42 } });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/overrides\.lipsync/);
  });

  it('POST /beat/:id/render → 202 with the job summary; busy → 409; empty → 400', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Diner' });
    const ok = await call('POST', `/beat/${beat._id}/render`, { skip_rendered: true });
    expect(ok.status).toBe(202);
    expect(ok.json).toEqual({ job_id: 'beat-1', planned: 2, skipped: 1 });

    const { BeatRenderBusyError, BeatRenderEmptyError } = await import('../src/web/beatRender.js');
    renderStubs.start = async () => { throw new BeatRenderBusyError(); };
    expect((await call('POST', `/beat/${beat._id}/render`, {})).status).toBe(409);
    renderStubs.start = async () => { throw new BeatRenderEmptyError('Nothing to render: plan shots first.'); };
    const empty = await call('POST', `/beat/${beat._id}/render`, {});
    expect(empty.status).toBe(400);
    expect(empty.json.error).toMatch(/plan shots/);
  });

  it('GET /beat/:id/render-job/:jobId polls; SSE stream sends the snapshot and closes on a terminal job', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Diner' });
    renderStubs.jobs.set('beat-9', { job_id: 'beat-9', status: 'done', shots: [{ order: 0, status: 'done' }] });
    const poll = await call('GET', `/beat/${beat._id}/render-job/beat-9`);
    expect(poll.status).toBe(200);
    expect(poll.json.job.status).toBe('done');
    expect((await call('GET', `/beat/${beat._id}/render-job/nope`)).status).toBe(404);

    const unauth = await fetch(`${baseUrl}/api/beat/${beat._id}/render-job/beat-9/events`);
    expect(unauth.status).toBe(401);
    const res = await fetch(`${baseUrl}/api/beat/${beat._id}/render-job/beat-9/events?session_id=good`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const text = await res.text();
    expect(text).toContain('event: snapshot');
    expect(text).toContain('"job_id":"beat-9"');
  });

  it('DELETE /beat/:id/video clears the pointer and deletes the file', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Diner' });
    const fid = new ObjectId();
    await Plots.setBeatVideo(projectId, beat._id, { fileId: fid, durationSeconds: 3 });
    const r = await call('DELETE', `/beat/${beat._id}/video`);
    expect(r.status).toBe(200);
    expect(r.json.beat.video_file_id).toBeNull();
    expect(deletedAttachments).toEqual([fid.toString()]);
    expect((await Plots.getBeat(projectId, beat._id)).video_file_id).toBeNull();
    expect((await call('DELETE', '/beat/999/video')).status).toBe(404);
  });
});
