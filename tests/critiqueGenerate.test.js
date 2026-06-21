import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const C = await import('../src/mongo/critiques.js');
const G = await import('../src/web/critiqueGenerate.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('P'))._id.toString();
  await Plots.updatePlot(projectId, { synopsis: 'S' });
});
afterEach(() => {
  G._setFacetGeneratorForTests(null);
});

async function seedBeat() {
  await Plots.createBeat({ projectId, name: 'A', body: 'a', order: 1 });
  const b = await Plots.createBeat({ projectId, name: 'B', body: 'INT. ROOM — DAY\nShe waits.', order: 2 });
  await Plots.createBeat({ projectId, name: 'C', body: 'c', order: 3 });
  return b;
}

describe('runCritique', () => {
  it('scores every facet, persists, and sets overall', async () => {
    const beat = await seedBeat();
    G._setFacetGeneratorForTests(async (facet) => ({ score: 8, comments: `c-${facet.key}` }));
    const job = G.createCritiqueJob(beat._id.toString());
    const done = await G.runCritique({ projectId, job });
    expect(done.status).toBe('done');
    expect(done.overall).toBe(8);
    const c = await C.getBeatCritique(projectId, beat._id.toString());
    expect(c.status).toBe('done');
    expect(c.overall).toBe(8);
    expect(c.facets).toHaveLength(7);
    expect(c.facets.every((f) => f.status === 'done' && f.score === 8)).toBe(true);
  });

  it('marks a single failing facet error and the run partial', async () => {
    const beat = await seedBeat();
    G._setFacetGeneratorForTests(async (facet) => {
      if (facet.key === 'pacing') throw new Error('model boom');
      return { score: 6, comments: 'ok' };
    });
    const job = G.createCritiqueJob(beat._id.toString());
    const done = await G.runCritique({ projectId, job });
    expect(done.status).toBe('partial');
    const c = await C.getBeatCritique(projectId, beat._id.toString());
    const pacing = c.facets.find((f) => f.key === 'pacing');
    expect(pacing.status).toBe('error');
    expect(pacing.score).toBeNull();
    expect(pacing.error_message).toMatch(/boom/);
    expect(c.overall).toBe(6); // mean of the 6 successful 6s
  });

  it('marks the run error when every facet fails', async () => {
    const beat = await seedBeat();
    G._setFacetGeneratorForTests(async () => { throw new Error('all down'); });
    const job = G.createCritiqueJob(beat._id.toString());
    const done = await G.runCritique({ projectId, job });
    expect(done.status).toBe('error');
    const c = await C.getBeatCritique(projectId, beat._id.toString());
    expect(c.overall).toBeNull();
  });

  it('publishes snapshots to SSE subscribers', async () => {
    const beat = await seedBeat();
    G._setFacetGeneratorForTests(async () => ({ score: 5, comments: 'x' }));
    const job = G.createCritiqueJob(beat._id.toString());
    const snaps = [];
    G.subscribeToCritiqueJob(job.job_id, (s) => snaps.push(s));
    await G.runCritique({ projectId, job });
    expect(snaps.length).toBeGreaterThan(0);
    const last = snaps[snaps.length - 1];
    expect(last.status).toBe('done');
    expect(last.facets).toHaveLength(7);
  });
});

describe('startCritiqueJob busy guard', () => {
  it('rejects a second concurrent run on the same beat with 409', async () => {
    const beat = await seedBeat();
    let release;
    const gate = new Promise((r) => { release = r; });
    G._setFacetGeneratorForTests(async () => { await gate; return { score: 5, comments: 'x' }; });
    const id1 = await G.startCritiqueJob({ projectId, beatId: beat._id.toString() });
    expect(id1).toBeTruthy();
    await expect(
      G.startCritiqueJob({ projectId, beatId: beat._id.toString() }),
    ).rejects.toMatchObject({ status: 409 });
    // Let the first (gated) run finish so its background work can't leak into
    // the next test, which clears the facet-generator override in afterEach.
    release();
    const terminal = (s) => ['done', 'partial', 'error'].includes(s);
    for (let i = 0; i < 100; i++) {
      const j = G.getCritiqueJob(id1);
      if (!j || terminal(j.status)) break;
      await new Promise((r) => setTimeout(r, 5));
    }
  });
});
