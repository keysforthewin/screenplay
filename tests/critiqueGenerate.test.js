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

  it('persists criteria, issues and a derived score from the rich shape; overall is weighted', async () => {
    const beat = await seedBeat();
    G._setFacetGeneratorForTests(async (facet) => {
      if (facet.key !== 'format') {
        return {
          criteria: facet.criteria.map((c) => ({ key: c.key, applicable: true, score: 8, evidence: [], rationale: '', to_raise: `raise ${c.key}` })),
          issues: [],
          strengths: ['tight'],
          summary: `sum-${facet.key}`,
        };
      }
      return {
        criteria: [
          { key: 'sluglines', applicable: true, score: 10, evidence: [{ quote: 'INT. ROOM — DAY', note: 'correct heading' }], rationale: 'ok' },
          { key: 'action_lines', applicable: true, score: 10, evidence: [], rationale: '' },
          { key: 'screen_text', applicable: true, score: 10, evidence: [], rationale: '' },
          { key: 'dialogue_format', applicable: false, score: 1, evidence: [], rationale: 'no dialogue' },
        ],
        issues: [{ severity: 'must_fix', criterion: 'screen_text', quote: 'She waits.', problem: 'Where?', fix: 'Add AT THE WINDOW.' }],
        strengths: [],
        summary: 'Heading fine, geography missing.',
      };
    });
    const job = G.createCritiqueJob(beat._id.toString());
    const done = await G.runCritique({ projectId, job });
    expect(done.status).toBe('done');
    const c = await C.getBeatCritique(projectId, beat._id.toString());
    expect(c.version).toBe(2);
    const fmt = c.facets.find((f) => f.key === 'format');
    expect(fmt.score).toBe(7); // (10+10+6)/3 = 8.7 → capped to 7 by the must_fix
    expect(fmt.comments).toBe('Heading fine, geography missing.');
    expect(fmt.summary).toBe(fmt.comments);
    expect(fmt.criteria).toHaveLength(4);
    expect(fmt.criteria[0].evidence[0].quote).toBe('INT. ROOM — DAY');
    expect(fmt.criteria.find((x) => x.key === 'dialogue_format').applicable).toBe(false);
    expect(fmt.issues[0]).toMatchObject({ severity: 'must_fix', criterion: 'screen_text', fix: 'Add AT THE WINDOW.' });
    expect(c.facets.find((f) => f.key === 'pacing').score).toBe(8);
    expect(c.facets.find((f) => f.key === 'pacing').criteria.map((x) => x.to_raise)).toContain('raise exit');
    expect(fmt.criteria[0].to_raise).toBe(''); // a 10 has nothing to raise
    // (7*1.5 + 8*1.5 + 8*5) / 8 = 62.5 / 8 = 7.8
    expect(c.overall).toBe(7.8);
    expect(done.overall).toBe(7.8);
  });

  it('a facet whose critic reports every criterion not applicable is "na", not an error', async () => {
    const beat = await seedBeat();
    G._setFacetGeneratorForTests(async (facet) => (facet.key === 'voice'
      ? { criteria: [{ key: 'distinctness', applicable: false, score: 5, evidence: [], rationale: '' }], issues: [], strengths: [], summary: 'A title crawl: no characters speak or act.' }
      : { score: 7, comments: 'ok' }));
    const job = G.createCritiqueJob(beat._id.toString());
    const done = await G.runCritique({ projectId, job });
    expect(done.status).toBe('done');
    expect(done.overall).toBe(7);
    const c = await C.getBeatCritique(projectId, beat._id.toString());
    const voice = c.facets.find((f) => f.key === 'voice');
    expect(voice).toMatchObject({ status: 'na', score: null, error_message: null, summary: 'A title crawl: no characters speak or act.' });
    expect(c.status).toBe('done');
  });

  it('errors a facet whose answer has no usable criteria at all', async () => {
    const beat = await seedBeat();
    G._setFacetGeneratorForTests(async (facet) => (facet.key === 'voice'
      ? { criteria: [{ key: 'distinctness', applicable: true, evidence: [], rationale: '' }], issues: [], strengths: [], summary: '' }
      : { score: 7, comments: 'ok' }));
    const job = G.createCritiqueJob(beat._id.toString());
    const done = await G.runCritique({ projectId, job });
    expect(done.status).toBe('partial');
    expect(done.facets.find((f) => f.key === 'voice').error_message).toMatch(/no applicable/);
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

describe('clearing', () => {
  const finish = async (id) => {
    for (let i = 0; i < 100; i++) {
      const j = G.getCritiqueJob(id);
      if (!j || ['done', 'partial', 'error'].includes(j.status)) return;
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  it('a manual critique clears the last climb status; clearCritique removes both and 409s while a run is going', async () => {
    const Climbs = await import('../src/mongo/climbs.js');
    const beat = await seedBeat();
    const id = beat._id.toString();
    await Climbs.setBeatClimb(projectId, id, 'writing', { kind: 'writing', status: 'done', stop_reason: 'stalled' });
    let release;
    const gate = new Promise((r) => { release = r; });
    G._setFacetGeneratorForTests(async () => { await gate; return { score: 5, comments: 'x' }; });
    const jobId = await G.startCritiqueJob({ projectId, beatId: id });
    expect(await Climbs.getBeatClimb(projectId, id, 'writing')).toBeNull();
    await expect(G.clearCritique({ projectId, beatId: id })).rejects.toMatchObject({ status: 409 });
    release();
    await finish(jobId);
    await new Promise((r) => setTimeout(r, 10));
    expect((await C.getBeatCritique(projectId, id)).status).toBe('done');

    await Climbs.setBeatClimb(projectId, id, 'writing', { kind: 'writing', status: 'done' });
    await G.clearCritique({ projectId, beatId: id });
    expect(await C.getBeatCritique(projectId, id)).toBeNull();
    expect(await Climbs.getBeatClimb(projectId, id, 'writing')).toBeNull();
  });
});
