// Tests for the load_writing_context handler and the hard gate it unlocks on
// beat-body edits.

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
const Characters = await import('../src/mongo/characters.js');
const { HANDLERS } = await import('../src/agent/handlers.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

function turnContext() {
  return { projectId, writingContextBeats: new Set() };
}

describe('load_writing_context handler', () => {
  it('returns the scoped context block and marks the beat as loaded', async () => {
    await Characters.createCharacter({ projectId, name: 'Alice', fields: { bio: 'Former courier.' } });
    const beat = await Plots.createBeat({
      projectId, name: 'Standoff', desc: 'd', body: 'b', characters: ['Alice'],
    });
    const ctx = turnContext();

    const out = await HANDLERS.load_writing_context(
      { beat: beat._id.toString(), characters: ['Alice'] },
      ctx,
    );

    expect(out).toContain('## Alice');
    expect(out).toContain('Former courier.');
    expect(ctx.writingContextBeats.has(beat._id.toString())).toBe(true);
  });
});

describe('beat-body edit gate', () => {
  it('blocks a beat body edit when context was not loaded this turn', async () => {
    const b = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'hello world' });
    const out = await HANDLERS.edit({
      collection: 'beat', identifier: b._id.toString(), field: 'body',
      edits: [{ find: 'world', replace: 'mars' }],
    }, turnContext());

    expect(out).toMatch(/Tool error \(edit\)/);
    expect(out).toMatch(/load_writing_context/);
    // body must be untouched
    expect((await Plots.getBeat(projectId, b._id.toString())).body).toBe('hello world');
  });

  it('allows the body edit after load_writing_context ran this turn', async () => {
    const b = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'hello world' });
    const ctx = turnContext();
    await HANDLERS.load_writing_context({ beat: b._id.toString(), characters: [] }, ctx);

    const out = await HANDLERS.edit({
      collection: 'beat', identifier: b._id.toString(), field: 'body',
      edits: [{ find: 'world', replace: 'mars' }],
    }, ctx);

    expect(out).toMatch(/Applied 1 edit/);
    expect((await Plots.getBeat(projectId, b._id.toString())).body).toBe('hello mars');
  });

  it('does not gate beat name/desc edits', async () => {
    const b = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'x' });
    const out = await HANDLERS.edit({
      collection: 'beat', identifier: b._id.toString(), field: 'name',
      edits: [{ find: '', replace: 'Renamed' }],
    }, turnContext());
    expect(out).toMatch(/Replaced beat "B"\.name/);
  });

  it('does not gate when no per-turn set is present (non-loop callers)', async () => {
    const b = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'hello world' });
    const out = await HANDLERS.edit({
      collection: 'beat', identifier: b._id.toString(), field: 'body',
      edits: [{ find: 'world', replace: 'mars' }],
    }, { projectId });
    expect(out).toMatch(/Applied 1 edit/);
  });
});
