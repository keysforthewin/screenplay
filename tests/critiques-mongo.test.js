import { describe, it, expect, beforeEach, vi } from 'vitest';
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

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('P'))._id.toString();
});

const STUBS = [
  { key: 'format', label: 'Screenplay format', scope: 'focused', score: null, comments: '', status: 'pending', error_message: null },
  { key: 'pacing', label: 'Pacing', scope: 'focused', score: null, comments: '', status: 'pending', error_message: null },
];

describe('critiques mongo helpers', () => {
  it('sets a pending critique then reads it back', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    await C.setCritiquePending(projectId, beat._id.toString(), { model: 'claude-opus-4-8', facets: STUBS });
    const c = await C.getBeatCritique(projectId, beat._id.toString());
    expect(c.status).toBe('pending');
    expect(c.model).toBe('claude-opus-4-8');
    expect(c.facets).toHaveLength(2);
    expect(c.facets[0].key).toBe('format');
  });

  it('updates a single facet by key', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    await C.setCritiquePending(projectId, beat._id.toString(), { model: 'm', facets: STUBS });
    await C.updateCritiqueFacet(projectId, beat._id.toString(), 'pacing', { score: 7, comments: 'tight', status: 'done' });
    const c = await C.getBeatCritique(projectId, beat._id.toString());
    const pacing = c.facets.find((f) => f.key === 'pacing');
    expect(pacing.score).toBe(7);
    expect(pacing.comments).toBe('tight');
    expect(pacing.status).toBe('done');
    expect(c.facets.find((f) => f.key === 'format').status).toBe('pending');
  });

  it('finalizes status + overall', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    await C.setCritiquePending(projectId, beat._id.toString(), { model: 'm', facets: STUBS });
    await C.finalizeCritique(projectId, beat._id.toString(), { status: 'done', overall: 6 });
    const c = await C.getBeatCritique(projectId, beat._id.toString());
    expect(c.status).toBe('done');
    expect(c.overall).toBe(6);
  });

  it('initializes strategy to null on a pending critique', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    await C.setCritiquePending(projectId, beat._id.toString(), { model: 'm', facets: STUBS });
    const c = await C.getBeatCritique(projectId, beat._id.toString());
    expect(c.strategy).toBeNull();
  });

  it('sets the rewrite strategy on the critique', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    await C.setCritiquePending(projectId, beat._id.toString(), { model: 'm', facets: STUBS });
    await C.setCritiqueStrategy(projectId, beat._id.toString(), '1. Tighten the open.');
    const c = await C.getBeatCritique(projectId, beat._id.toString());
    expect(c.strategy).toBe('1. Tighten the open.');
  });

  it('stashes, reads, and clears previous_body', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'orig' });
    await C.stashPreviousBody(projectId, beat._id.toString(), 'orig');
    expect(await C.getPreviousBody(projectId, beat._id.toString())).toBe('orig');
    await C.clearPreviousBody(projectId, beat._id.toString());
    expect(await C.getPreviousBody(projectId, beat._id.toString())).toBeNull();
  });

  it('returns null for a beat in another project', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    const otherProjectId = (await createProject('Other'))._id.toString();
    expect(await C.getBeatCritique(otherProjectId, beat._id.toString())).toBeNull();
  });
});
