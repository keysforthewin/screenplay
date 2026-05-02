import { describe, it, expect, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';
import { TOOLS } from '../src/agent/tools.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { HANDLERS } = await import('../src/agent/handlers.js');

describe('tools', () => {
  it('every tool has name + description + input_schema', () => {
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.input_schema.type).toBe('object');
    }
  });
  it('names are unique', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
  it('every dispatchable tool has a matching handler', () => {
    // metaTool entries (e.g. tool_search) are intercepted by the agent loop
    // and have no entry in HANDLERS — they are intentionally excluded.
    for (const t of TOOLS) {
      if (t.metaTool) continue;
      expect(HANDLERS[t.name], `missing handler for ${t.name}`).toBeTypeOf('function');
    }
  });
  it('meta tools are not in HANDLERS (intercepted by the loop instead)', () => {
    const meta = TOOLS.filter((t) => t.metaTool);
    expect(meta.length).toBeGreaterThan(0);
    for (const t of meta) {
      expect(HANDLERS[t.name]).toBeUndefined();
    }
  });
});
