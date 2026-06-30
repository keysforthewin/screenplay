// --- add these mocks at the very top of the file, before any import of gateway ---
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/rag/queue.js', () => ({ enqueueReindex: () => {} }));
vi.mock('../src/rag/indexer.js', () => ({ deleteEntity: () => Promise.resolve() }));

const announceCalls = [];
vi.mock('../src/discord/announcer.js', () => ({
  announceMediaEvent: async (payload) => { announceCalls.push(payload); },
  announceText: async () => {},
}));

const Gateway = await import('../src/web/gateway.js');

const { runAsEditor, currentEditor } = await import('../src/web/editAttribution.js');

import { ObjectId } from 'mongodb';
const Projects = await import('../src/mongo/projects.js');

describe('editAttribution', () => {
  it('currentEditor is null outside any scope', () => {
    expect(currentEditor()).toBe(null);
  });

  it('exposes the editor name inside runAsEditor', () => {
    const seen = runAsEditor('Steve', () => currentEditor());
    expect(seen).toBe('Steve');
    expect(currentEditor()).toBe(null); // scope ends after fn returns
  });

  it('trims the name and treats blank/falsy as no scope', () => {
    expect(runAsEditor('  Ada  ', () => currentEditor())).toBe('Ada');
    expect(runAsEditor('', () => currentEditor())).toBe(null);
    expect(runAsEditor(undefined, () => currentEditor())).toBe(null);
    expect(runAsEditor(null, () => currentEditor())).toBe(null);
  });

  it('propagates the scope across awaits and returns the promise value', async () => {
    const result = await runAsEditor('Grace', async () => {
      await Promise.resolve();
      return currentEditor();
    });
    expect(result).toBe('Grace');
  });

  it('nested scopes shadow the outer one', () => {
    const out = runAsEditor('Outer', () =>
      runAsEditor('Inner', () => currentEditor()));
    expect(out).toBe('Inner');
  });
});

describe('gatewayEditContext', () => {
  it('returns the bot actor outside an editor scope', () => {
    expect(Gateway.gatewayEditContext()).toEqual({ actor: 'bot' });
  });

  it('returns a web-user actor inside an editor scope', () => {
    const ctx = runAsEditor('Steve', () => Gateway.gatewayEditContext());
    expect(ctx).toEqual({ actor: 'web-user', user: { name: 'Steve' } });
  });
});

describe('updateBeatViaGateway cast announcement', () => {
  let projectId;
  let beatId;

  beforeEach(async () => {
    fakeDb.reset();
    announceCalls.length = 0;
    const proj = await Projects.createProject('Film');
    projectId = proj._id.toString();
    beatId = new ObjectId();
    await fakeDb.collection('plots').insertOne({
      _id: new ObjectId(),
      project_id: projectId,
      title: 'Film',
      beats: [{ _id: beatId, order: 1, name: 'Scene One', body: '', desc: '',
                characters: ['Alice'], images: [], attachments: [] }],
    });
  });

  it('announces a cast change when an editor scope is active', async () => {
    await runAsEditor('Steve', () =>
      Gateway.updateBeatViaGateway(projectId, beatId.toString(), { characters: ['Alice', 'Bob'] }));
    // The cast announce is fire-and-forget (its own throttle check round-trips
    // through Mongo after updateBeatViaGateway has already returned) — flush
    // pending microtasks, matching the established pattern in
    // tests/beat-cast-patch-route.test.js.
    await new Promise((r) => setTimeout(r, 0));
    expect(announceCalls).toHaveLength(1);
    expect(announceCalls[0].username).toBe('Steve');
    expect(announceCalls[0].verb).toContain('added');
    expect(announceCalls[0].verb).toContain('Bob');
  });

  it('does NOT announce a cast change with no editor scope (bot edit)', async () => {
    await Gateway.updateBeatViaGateway(projectId, beatId.toString(), { characters: ['Alice', 'Bob'] });
    expect(announceCalls).toHaveLength(0);
  });

  it('does NOT announce when the cast is unchanged', async () => {
    await runAsEditor('Steve', () =>
      Gateway.updateBeatViaGateway(projectId, beatId.toString(), { characters: ['Alice'] }));
    expect(announceCalls).toHaveLength(0);
  });
});
