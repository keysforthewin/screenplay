import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Characters = await import('../src/mongo/characters.js');
const Projects = await import('../src/mongo/projects.js');

let p1;
let p2;

beforeEach(async () => {
  fakeDb.reset();
  p1 = (await Projects.createProject('Alpha'))._id.toString();
  p2 = (await Projects.createProject('Beta'))._id.toString();
});

describe('multi-project characters', () => {
  it('the same name resolves independently per project', async () => {
    const a = await Characters.createCharacter({ projectId: p1, name: 'Steve' });
    const b = await Characters.createCharacter({ projectId: p2, name: 'Steve' });
    expect(a.project_id).toBe(p1);
    expect(b.project_id).toBe(p2);
    const got1 = await Characters.getCharacter(p1, 'steve');
    const got2 = await Characters.getCharacter(p2, 'steve');
    expect(got1._id.toString()).toBe(a._id.toString());
    expect(got2._id.toString()).toBe(b._id.toString());
  });

  it('id lookup verifies project_id — mismatch is not-found', async () => {
    const a = await Characters.createCharacter({ projectId: p1, name: 'Steve' });
    expect(await Characters.getCharacter(p2, a._id.toString())).toBe(null);
    expect((await Characters.getCharacter(p1, a._id.toString()))._id.toString()).toBe(
      a._id.toString(),
    );
  });

  it('listCharacters / findAllCharacters / searchCharacters are scoped', async () => {
    await Characters.createCharacter({ projectId: p1, name: 'Steve' });
    await Characters.createCharacter({ projectId: p2, name: 'Wendy' });
    expect((await Characters.listCharacters(p1)).map((c) => c.name)).toEqual(['Steve']);
    expect((await Characters.findAllCharacters(p2)).map((c) => c.name)).toEqual(['Wendy']);
    expect(await Characters.searchCharacters(p1, 'wendy')).toEqual([]);
    expect((await Characters.searchCharacters(p2, 'wendy'))[0].name).toBe('Wendy');
  });

  it('the stripMarkdown fallback scan stays inside the project', async () => {
    await Characters.createCharacter({ projectId: p1, name: '**Bold Bob**' });
    await Characters.createCharacter({ projectId: p2, name: '**Bold Bob**' });
    // Corrupt p1's name_lower so the direct lookup misses and the scan runs.
    await fakeDb.collection('characters').updateOne(
      { project_id: p1 },
      { $set: { name_lower: '**bold bob**' } },
    );
    const found = await Characters.getCharacter(p1, 'Bold Bob');
    expect(found.project_id).toBe(p1);
  });

  it('legacy docs without project_id are visible (lenient until migration)', async () => {
    await fakeDb.collection('characters').insertOne({
      name: 'Legacy', name_lower: 'legacy', fields: {},
      created_at: new Date(), updated_at: new Date(),
    });
    expect(await Characters.getCharacter(p1, 'legacy')).toBeTruthy();
    expect((await Characters.listCharacters(p1)).map((c) => c.name)).toContain('Legacy');
  });
});
