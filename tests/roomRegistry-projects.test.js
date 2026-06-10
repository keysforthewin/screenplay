// Project-scoped singleton rooms (notes/library/plot become notes:<projectId>
// etc.), entity rooms unchanged, and project verification for room access.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));
vi.mock('../src/rag/queue.js', () => ({ enqueueReindex: () => {} }));
vi.mock('../src/rag/indexer.js', () => ({}));

const { buildRoomName, parseRoomName, resolveRoom, assertRoomProjectKnown } =
  await import('../src/web/roomRegistry.js');
const Projects = await import('../src/mongo/projects.js');
const DirectorNotes = await import('../src/mongo/directorNotes.js');

beforeEach(() => fakeDb.reset());

describe('project-scoped room names', () => {
  it('buildRoomName/parseRoomName round-trip the three singleton rooms', () => {
    const pid = new ObjectId().toString();
    for (const type of ['notes', 'library', 'plot']) {
      const name = buildRoomName(type, pid);
      expect(name).toBe(`${type}:${pid}`);
      expect(parseRoomName(name)).toEqual({ type, projectId: pid });
    }
  });

  it('bare legacy singleton names are no longer managed rooms', () => {
    expect(parseRoomName('notes')).toBeNull();
    expect(parseRoomName('library')).toBeNull();
    expect(parseRoomName('plot')).toBeNull();
  });

  it('buildRoomName throws for a singleton room without a valid project id', () => {
    expect(() => buildRoomName('notes')).toThrow(/project/i);
    expect(() => buildRoomName('library', 'not-hex')).toThrow(/project/i);
  });

  it('entity rooms are unchanged', () => {
    const id = new ObjectId().toString();
    expect(buildRoomName('beat', id)).toBe(`beat:${id}`);
    expect(parseRoomName(`character:${id}`)).toEqual({ type: 'character', id });
    expect(parseRoomName(`storyboards:${id}`)).toEqual({ type: 'storyboards', id });
  });

  it('assertRoomProjectKnown accepts known projects and rejects unknown ones', async () => {
    const p = await Projects.createProject('Western');
    await expect(
      assertRoomProjectKnown(`notes:${p._id.toString()}`),
    ).resolves.toMatchObject({ type: 'notes', projectId: p._id.toString() });
    await expect(
      assertRoomProjectKnown(`notes:${new ObjectId().toString()}`),
    ).rejects.toThrow(/unknown project/i);
    await expect(assertRoomProjectKnown('garbage-room')).rejects.toThrow(/unknown room/i);
  });

  it('resolveRoom returns null for a singleton room of an unknown project', async () => {
    expect(await resolveRoom(`library:${new ObjectId().toString()}`)).toBeNull();
    expect(await resolveRoom(`notes:${new ObjectId().toString()}`)).toBeNull();
    expect(await resolveRoom(`plot:${new ObjectId().toString()}`)).toBeNull();
  });

  it('notes rooms are independent per project and persist to the composite prompts _id', async () => {
    const a = await Projects.createProject('A');
    const b = await Projects.createProject('B');
    const aid = a._id.toString();
    const bid = b._id.toString();
    const noteA = await DirectorNotes.addDirectorNote({ projectId: aid, text: 'alpha' });

    const descA = await resolveRoom(`notes:${aid}`);
    expect(descA.fields).toEqual([`note:${noteA._id.toString()}:text`]);
    const descB = await resolveRoom(`notes:${bid}`);
    expect(descB.fields).toEqual([]);

    const result = await descA.persistFields({
      [`note:${noteA._id.toString()}:text`]: 'alpha v2',
    });
    expect(result.changed).toBe(true);
    expect((await DirectorNotes.getDirectorNotes(aid)).notes[0].text).toBe('alpha v2');
    expect((await DirectorNotes.getDirectorNotes(bid)).notes || []).toHaveLength(0);
    // The write landed on the composite-keyed doc, not the legacy singleton.
    const prompts = fakeDb.collection('prompts')._docs;
    expect(prompts.some((d) => d._id === `${aid}:director_notes`)).toBe(true);
    expect(prompts.some((d) => d._id === 'director_notes')).toBe(false);
  });
});
