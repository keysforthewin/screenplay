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

  it('synthesizes a strategy first, persists it, and returns it alongside the body', async () => {
    // Call-counting stub: 1st call (synthesis) -> STRATEGY, 2nd (rewrite) -> REWRITTEN.
    let n = 0;
    _setAnthropicClientForTests({
      messages: { create: async () => ({ content: [{ type: 'text', text: ++n === 1 ? 'STRATEGY' : 'REWRITTEN' }] }) },
    });
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'old body' });
    await C.setCritiquePending(projectId, beat._id.toString(), {
      model: 'm',
      facets: [{ key: 'pacing', label: 'Pacing', scope: 'focused', score: 4, comments: 'slow', status: 'done', error_message: null }],
    });
    await C.finalizeCritique(projectId, beat._id.toString(), { status: 'done', overall: 4 });
    const res = await R.regenerateBeat(projectId, beat._id.toString());
    expect(res.strategy).toBe('STRATEGY'); // first call = synthesis pass
    expect(res.body).toBe('REWRITTEN'); // second call = rewrite from the strategy
    const c = await C.getBeatCritique(projectId, beat._id.toString());
    expect(c.strategy).toBe('STRATEGY'); // persisted on the critique for the UI
    expect(await C.getPreviousBody(projectId, beat._id.toString())).toBe('old body');
  });
});

describe('formatCritiqueForRewrite', () => {
  it('renders ranked issues most severe first, then facet summaries with criterion scores', () => {
    const text = R.formatCritiqueForRewrite({
      facets: [
        {
          key: 'pacing', label: 'Pacing & momentum', status: 'done', score: 5.5, summary: 'Slack middle.',
          criteria: [{ key: 'entry', label: 'Entry', applicable: true, score: 7 }, { key: 'proportion', label: 'Length vs. weight', applicable: false, score: null }],
          issues: [{ severity: 'should_fix', criterion: 'escalation', quote: 'They talk.', problem: 'Flat.', fix: 'Cut the second exchange.' }],
        },
        {
          key: 'format', label: 'Screenplay format', status: 'done', score: 6, summary: 'No slug.', criteria: [],
          issues: [{ severity: 'must_fix', criterion: 'geography', quote: 'in the minivan', problem: 'Which seat?', fix: 'Add BACK SEAT.' }],
        },
        { key: 'voice', label: 'Character voice', status: 'error', issues: [{ severity: 'must_fix', criterion: 'x', quote: '', problem: 'ignored', fix: '' }] },
      ],
    });
    expect(text.indexOf('## MUST FIX')).toBeLessThan(text.indexOf('## SHOULD FIX'));
    expect(text).toContain('[Screenplay format / geography] "in the minivan" — Which seat? → FIX: Add BACK SEAT.');
    expect(text).toContain('Cut the second exchange.');
    expect(text).not.toContain('ignored');
    expect(text).toContain('## Pacing & momentum (score 5.5/10)');
    expect(text).toContain('- Entry: 7/10');
    expect(text).toContain('- Length vs. weight: n/a');
    expect(text).toContain('Slack middle.');
  });

  it('falls back to the legacy score + comments rendering when no facet has issues', () => {
    const text = R.formatCritiqueForRewrite({
      facets: [{ key: 'pacing', label: 'Pacing', status: 'done', score: 4, comments: 'slow' }],
    });
    expect(text).toBe('## Pacing (score 4/10)\nslow');
  });

  it('sends the ranked issues to the strategist', async () => {
    const prompts = [];
    _setAnthropicClientForTests({
      messages: { create: async (req) => { prompts.push(req.messages[0].content); return { content: [{ type: 'text', text: 'X' }] }; } },
    });
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'old body' });
    await C.setCritiquePending(projectId, beat._id.toString(), {
      model: 'm',
      facets: [{ key: 'format', label: 'Screenplay format', scope: 'focused', score: 5, comments: 'c', status: 'done', error_message: null,
        criteria: [], issues: [{ severity: 'must_fix', criterion: 'geography', quote: 'LINE-Q', problem: 'PROB', fix: 'FIX-IT' }] }],
    });
    await C.finalizeCritique(projectId, beat._id.toString(), { status: 'done', overall: 5 });
    await R.regenerateBeat(projectId, beat._id.toString());
    const synth = typeof prompts[0] === 'string' ? prompts[0] : JSON.stringify(prompts[0]);
    expect(synth).toContain('MUST FIX');
    expect(synth).toContain('LINE-Q');
    expect(synth).toContain('FIX-IT');
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
