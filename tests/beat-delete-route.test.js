import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/web/auth.js', () => ({
  requireSession: () => (req, _res, next) => { req.session = undefined; next(); },
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Dialogs = await import('../src/mongo/dialogs.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server, baseUrl, projectId;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter());
  await new Promise((r) => { server = app.listen(0, r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Route Beat Delete'))._id.toString();
});

async function del(path, pid = projectId) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: { 'X-Project-Id': pid },
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe('DELETE /api/beat/:id', () => {
  it('removes the beat, renumbers the rest, and cascades to storyboards + dialogs', async () => {
    const A = await Plots.createBeat({ projectId, name: 'A', body: 'x' });
    const B = await Plots.createBeat({ projectId, name: 'B', body: 'x' });
    const C = await Plots.createBeat({ projectId, name: 'C', body: 'x' });
    await Storyboards.createStoryboard({ projectId, beatId: B._id, description: 'shot 1' });
    await Storyboards.createStoryboard({ projectId, beatId: B._id, description: 'shot 2' });
    await Storyboards.createStoryboard({ projectId, beatId: C._id, description: 'keep me' });
    await Dialogs.createDialog({ projectId, beatId: B._id, character: 'Steve', body: 'hi' });

    const { status, json } = await del(`/api/beat/${B._id.toString()}`);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.deleted.name).toBe('B');
    expect(json.deleted.storyboards_removed).toBe(2);
    expect(json.deleted.dialogs_removed).toBe(1);

    const plot = await Plots.getPlot(projectId);
    expect(plot.beats.map((b) => [b.name, b.order])).toEqual([['A', 1], ['C', 2]]);
    expect(await Storyboards.listStoryboards({ projectId, beatId: B._id })).toEqual([]);
    expect(await Storyboards.listStoryboards({ projectId, beatId: C._id })).toHaveLength(1);
    expect(await Dialogs.listDialogs({ projectId, beatId: B._id })).toEqual([]);
    void A;
  });

  it('accepts the beat order as the identifier', async () => {
    await Plots.createBeat({ projectId, name: 'A', body: 'x' });
    await Plots.createBeat({ projectId, name: 'B', body: 'x' });
    const { status, json } = await del('/api/beat/1');
    expect(status).toBe(200);
    expect(json.deleted.name).toBe('A');
    const plot = await Plots.getPlot(projectId);
    expect(plot.beats.map((b) => b.name)).toEqual(['B']);
  });

  it('404s for an unknown id and for a beat in another project', async () => {
    const other = (await createProject('Other'))._id.toString();
    const foreign = await Plots.createBeat({ projectId: other, name: 'Foreign', body: 'x' });
    const unknown = await del('/api/beat/0123456789abcdef01234567');
    expect(unknown.status).toBe(404);
    const cross = await del(`/api/beat/${foreign._id.toString()}`);
    expect(cross.status).toBe(404);
    const otherPlot = await Plots.getPlot(other);
    expect(otherPlot.beats).toHaveLength(1);
  });
});
