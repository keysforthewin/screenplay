import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { HANDLERS } = await import('../src/agent/handlers.js');
const { createProject } = await import('../src/mongo/projects.js');
const { getCurrentProjectId } = await import('../src/mongo/channelState.js');

beforeEach(() => {
  fakeDb.reset();
});

function makeContext(overrides = {}) {
  return {
    discordUser: { id: 'u1', displayName: 'Steve' },
    channelId: 'chan-1',
    projectId: 'a'.repeat(24),
    projectTitle: 'Old Project',
    ...overrides,
  };
}

describe('set_project handler', () => {
  it('switches to a known project (case-insensitive) and reports the title', async () => {
    await createProject('Heist Movie');
    const ctx = makeContext();
    const out = await HANDLERS.set_project({ title: 'heist movie' }, ctx);
    expect(out).toBe('Switched to project "Heist Movie".');
  });

  it('mutates context in place so later same-turn tools see the new project', async () => {
    const p = await createProject('Heist Movie');
    const ctx = makeContext();
    await HANDLERS.set_project({ title: 'Heist Movie' }, ctx);
    expect(ctx.projectId).toBe(p._id.toString());
    expect(ctx.projectTitle).toBe('Heist Movie');
  });

  it('persists the switch to channel_state', async () => {
    const p = await createProject('Heist Movie');
    await HANDLERS.set_project({ title: 'Heist Movie' }, makeContext());
    expect(await getCurrentProjectId('chan-1')).toBe(p._id.toString());
  });

  it('unknown title returns an error listing all available titles', async () => {
    await createProject('Alpha');
    await createProject('Beta');
    const ctx = makeContext();
    const out = await HANDLERS.set_project({ title: 'Gamma' }, ctx);
    expect(out).toMatch(/^Tool error \(set_project\)/);
    expect(out).toContain('"Alpha"');
    expect(out).toContain('"Beta"');
    // and nothing was switched or persisted
    expect(ctx.projectId).toBe('a'.repeat(24));
    expect(await getCurrentProjectId('chan-1')).toBeNull();
  });

  it('requires a title', async () => {
    const out = await HANDLERS.set_project({}, makeContext());
    expect(out).toMatch(/`title` is required/);
  });

  it('web runs are refused: no switch, no persistence, context unchanged', async () => {
    await createProject('Heist Movie');
    const ctx = makeContext({ webRun: true });
    const out = await HANDLERS.set_project({ title: 'Heist Movie' }, ctx);
    expect(out).toMatch(/disabled in the web chat/);
    expect(out).toMatch(/project picker/);
    // Web runs carry the real Discord channelId — the refusal must come
    // before any channel_state write or context mutation.
    expect(ctx.projectId).toBe('a'.repeat(24));
    expect(ctx.projectTitle).toBe('Old Project');
    expect(await getCurrentProjectId('chan-1')).toBeNull();
  });

  it('no-channel context: returns success with not-persisted qualifier and does not write channel_state', async () => {
    await createProject('Heist Movie');
    // Pass null context (missing channelId) — handler must not throw and must
    // not call setCurrentProjectId.
    const out = await HANDLERS.set_project({ title: 'Heist Movie' }, null);
    expect(out).toBe('Switched to project "Heist Movie". (not persisted — no channel context)');
    // Nothing should have been written to channel_state.
    expect(await getCurrentProjectId('chan-1')).toBeNull();
  });
});
