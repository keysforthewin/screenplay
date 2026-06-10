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

const { createProject } = await import('../src/mongo/projects.js');
const Characters = await import('../src/mongo/characters.js');
const Plots = await import('../src/mongo/plots.js');
const { HANDLERS } = await import('../src/agent/handlers.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

describe('SPA edit links in handler output', () => {
  it('create_beat appends a beat URL using the new beat order', async () => {
    const out = await HANDLERS.create_beat({
      name: 'Opening',
      desc: 'opening scene',
    }, { projectId });
    expect(out).toMatch(/Created beat "Opening"/);
    expect(out).toMatch(/Edit in browser: http:\/\/localhost:3000\/beat\/1$/m);
  });

  it('edit (character) appends a character URL using the stripped name', async () => {
    await Characters.createCharacter({ projectId, name: 'Alice', fields: {} });
    const out = await HANDLERS.edit({
      collection: 'character',
      identifier: 'Alice',
      field: 'fields.role',
      edits: [{ find: '', replace: 'lead' }],
    }, { projectId });
    expect(out).toMatch(/Replaced Alice\.fields\.role/);
    expect(out).toMatch(/Edit in browser: http:\/\/localhost:3000\/character\/Alice$/m);
  });

  it('add_director_note appends the shared notes URL', async () => {
    const out = await HANDLERS.add_director_note({ text: 'Try a slow zoom.' }, { projectId });
    expect(out).toMatch(/Added director's note/);
    expect(out).toMatch(/Edit in browser: http:\/\/localhost:3000\/notes$/m);
  });
});
