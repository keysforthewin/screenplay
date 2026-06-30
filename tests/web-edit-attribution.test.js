// --- add these mocks at the very top of the file, before any import of gateway ---
import { describe, it, expect, vi } from 'vitest';
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
