import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

const Characters = await import('../src/mongo/characters.js');
const Plots = await import('../src/mongo/plots.js');
const { HANDLERS } = await import('../src/agent/handlers.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('SPA edit links in handler output', () => {
  it('create_beat appends a beat URL using the new beat order', async () => {
    const out = await HANDLERS.create_beat({
      name: 'Opening',
      desc: 'opening scene',
    });
    expect(out).toMatch(/Created beat "Opening"/);
    expect(out).toMatch(/Edit in browser: http:\/\/localhost:3000\/beat\/1$/m);
  });

  it('update_character appends a character URL using the stripped name', async () => {
    await Characters.createCharacter({ name: 'Alice', fields: {} });
    const out = await HANDLERS.update_character({
      identifier: 'Alice',
      patch: { fields: { role: 'lead' } },
    });
    expect(out).toMatch(/Updated Alice/);
    expect(out).toMatch(/Edit in browser: http:\/\/localhost:3000\/character\/Alice$/m);
  });

  it('add_director_note appends the shared notes URL', async () => {
    const out = await HANDLERS.add_director_note({ text: 'Try a slow zoom.' });
    expect(out).toMatch(/Added director's note/);
    expect(out).toMatch(/Edit in browser: http:\/\/localhost:3000\/notes$/m);
  });
});
