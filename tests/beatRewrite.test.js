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
// beatRewrite → gateway pulls in the announce helpers; stub them (same as the
// route tests) so importing the gateway tree is side-effect-free.
vi.mock('../src/web/announceHelpers.js', () => ({
  announceBeatMedia: vi.fn(), announceCharacterMedia: vi.fn(), announceNoteMedia: vi.fn(),
  announceStoryboardMedia: vi.fn(), announceLibraryMedia: vi.fn(), announceBatchSummary: vi.fn(),
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const C = await import('../src/mongo/critiques.js');
const { _setAnthropicClientForTests } = await import('../src/anthropic/client.js');
const R = await import('../src/web/beatRewrite.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('P'))._id.toString();
  // Stub Anthropic: analyzeText returns the text content.
  _setAnthropicClientForTests({
    messages: { create: async () => ({ content: [{ type: 'text', text: 'REWRITTEN' }] }) },
  });
});
afterEach(() => { _setAnthropicClientForTests(null); });

describe('normalizeBeat', () => {
  it('stashes the old body and writes the rewrite', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'prose body' });
    const res = await R.normalizeBeat(projectId, beat._id.toString());
    expect(res.body).toBe('REWRITTEN');
    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.body).toBe('REWRITTEN');
    expect(await C.getPreviousBody(projectId, beat._id.toString())).toBe('prose body');
  });
});

describe('regenerateBeat', () => {
  it('rejects with 409 when there is no critique', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    await expect(R.regenerateBeat(projectId, beat._id.toString())).rejects.toMatchObject({ status: 409 });
  });

  it('rewrites from an existing critique and stashes the old body', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'old body' });
    await C.setCritiquePending(projectId, beat._id.toString(), {
      model: 'm',
      facets: [{ key: 'pacing', label: 'Pacing', scope: 'focused', score: 4, comments: 'slow', status: 'done', error_message: null }],
    });
    await C.finalizeCritique(projectId, beat._id.toString(), { status: 'done', overall: 4 });
    const res = await R.regenerateBeat(projectId, beat._id.toString());
    expect(res.body).toBe('REWRITTEN');
    expect(await C.getPreviousBody(projectId, beat._id.toString())).toBe('old body');
  });
});

describe('restoreBeatBody', () => {
  it('restores the stashed body and clears the slot', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'orig' });
    await R.normalizeBeat(projectId, beat._id.toString()); // body -> REWRITTEN, prev -> orig
    const res = await R.restoreBeatBody(projectId, beat._id.toString());
    expect(res).toMatchObject({ restored: true, body: 'orig' });
    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.body).toBe('orig');
    expect(await C.getPreviousBody(projectId, beat._id.toString())).toBeNull();
  });

  it('is a safe no-op when nothing is stashed', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    const res = await R.restoreBeatBody(projectId, beat._id.toString());
    expect(res).toEqual({ restored: false });
  });
});
