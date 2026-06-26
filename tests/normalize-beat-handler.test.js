// Handler-level test for the `normalize_beat` agent tool: it reformats a beat
// body to screenplay format (via beatRewrite.normalizeBeat), stashing the old
// body for undo. The LLM is stubbed; the underlying normalizeBeat behavior is
// covered separately in beatRewrite.test.js — here we verify the handler wiring
// (beat resolution, current-beat default, confirmation message).

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
// handlers → gateway → announce helpers; stub them so importing the tree is
// side-effect-free (same pattern as the route/beatRewrite tests).
vi.mock('../src/web/announceHelpers.js', () => ({
  announceBeatMedia: vi.fn(), announceCharacterMedia: vi.fn(), announceNoteMedia: vi.fn(),
  announceStoryboardMedia: vi.fn(), announceLibraryMedia: vi.fn(), announceBatchSummary: vi.fn(),
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const C = await import('../src/mongo/critiques.js');
const { _setAnthropicClientForTests } = await import('../src/anthropic/client.js');
const { HANDLERS } = await import('../src/agent/handlers.js');

let projectId;
let context;
beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('P'))._id.toString();
  context = { projectId, projectTitle: 'P' };
  _setAnthropicClientForTests({
    messages: { create: async () => ({ content: [{ type: 'text', text: 'REWRITTEN' }] }) },
  });
});
afterEach(() => { _setAnthropicClientForTests(null); });

describe('normalize_beat handler', () => {
  it('reformats the named beat, stashes the old body, and confirms', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Heist', body: 'prose body' });
    const out = await HANDLERS.normalize_beat({ beat: beat._id.toString() }, context);

    expect(out).toContain('Heist');
    expect(out).toContain('screenplay format');

    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.body).toBe('REWRITTEN');
    expect(await C.getPreviousBody(projectId, beat._id.toString())).toBe('prose body');
  });

  it('defaults to the current beat when `beat` is omitted', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Solo', body: 'old' });
    await Plots.setCurrentBeat(projectId, beat._id.toString());

    const out = await HANDLERS.normalize_beat({}, context);
    expect(out).toContain('Solo');

    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.body).toBe('REWRITTEN');
  });

  it('throws when no beat is given and no current beat is set', async () => {
    await expect(HANDLERS.normalize_beat({}, context)).rejects.toThrow(/current beat/i);
  });
});
