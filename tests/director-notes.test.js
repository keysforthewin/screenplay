import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { createProject } = await import('../src/mongo/projects.js');
const Notes = await import('../src/mongo/directorNotes.js');
const Projects = await import('../src/mongo/projects.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

describe('director notes singleton', () => {
  it('getDirectorNotes returns an empty notes array when the doc does not exist', async () => {
    const doc = await Notes.getDirectorNotes(projectId);
    const def = await Projects.getDefaultProject();
    expect(doc._id).toBe(`${def._id.toString()}:director_notes`);
    expect(doc.notes).toEqual([]);
    // and does not write the empty doc
    expect(fakeDb.collection('prompts')._docs).toHaveLength(0);
  });

  it('addDirectorNote appends to the end and returns the new note with an ObjectId', async () => {
    const a = await Notes.addDirectorNote({ projectId, text: 'No anachronisms unless flagged.' });
    const b = await Notes.addDirectorNote({ projectId, text: 'Unnamed extras are Feral Ewoks.' });

    expect(a._id).toBeInstanceOf(ObjectId);
    expect(a.text).toBe('No anachronisms unless flagged.');
    expect(a.created_at).toBeInstanceOf(Date);

    const doc = await Notes.getDirectorNotes(projectId);
    expect(doc.notes).toHaveLength(2);
    expect(doc.notes[0]._id.equals(a._id)).toBe(true);
    expect(doc.notes[1]._id.equals(b._id)).toBe(true);
  });

  it('addDirectorNote with a position inserts at that index', async () => {
    const a = await Notes.addDirectorNote({ projectId, text: 'first' });
    const c = await Notes.addDirectorNote({ projectId, text: 'third' });
    const b = await Notes.addDirectorNote({ projectId, text: 'second', position: 1 });

    const doc = await Notes.getDirectorNotes(projectId);
    expect(doc.notes.map((n) => n.text)).toEqual(['first', 'second', 'third']);
    expect(doc.notes[0]._id.equals(a._id)).toBe(true);
    expect(doc.notes[1]._id.equals(b._id)).toBe(true);
    expect(doc.notes[2]._id.equals(c._id)).toBe(true);
  });

  it('addDirectorNote requires non-empty text', async () => {
    await expect(Notes.addDirectorNote({ projectId, text: '' })).rejects.toThrow(/text/);
    await expect(Notes.addDirectorNote({ projectId, text: '   ' })).rejects.toThrow(/text/);
    await expect(Notes.addDirectorNote({ projectId,})).rejects.toThrow(/text/);
  });

  it('editDirectorNote updates the right note and bumps updated_at', async () => {
    const a = await Notes.addDirectorNote({ projectId, text: 'one' });
    const b = await Notes.addDirectorNote({ projectId, text: 'two' });
    const before = (await Notes.getDirectorNotes(projectId)).updated_at;
    // ensure clock advances — the in-memory write is sub-ms otherwise
    await new Promise((r) => setTimeout(r, 5));

    await Notes.editDirectorNote({ projectId, noteId: b._id.toString(), text: 'TWO' });

    const doc = await Notes.getDirectorNotes(projectId);
    expect(doc.notes[0].text).toBe('one');
    expect(doc.notes[1].text).toBe('TWO');
    expect(doc.notes[1]._id.equals(b._id)).toBe(true);
    expect(doc.updated_at.getTime()).toBeGreaterThan(before.getTime());
    // unchanged note should still be there with its original id
    expect(doc.notes[0]._id.equals(a._id)).toBe(true);
  });

  it('editDirectorNote throws on bad id and on missing id', async () => {
    await Notes.addDirectorNote({ projectId, text: 'x' });
    await expect(
      Notes.editDirectorNote({ projectId, noteId: 'not-an-oid', text: 'y' }),
    ).rejects.toThrow(/invalid note_id/);
    const stranger = new ObjectId();
    await expect(
      Notes.editDirectorNote({ projectId, noteId: stranger.toString(), text: 'y' }),
    ).rejects.toThrow(/note not found/);
  });

  it('editDirectorNote requires non-empty text', async () => {
    const a = await Notes.addDirectorNote({ projectId, text: 'x' });
    await expect(
      Notes.editDirectorNote({ projectId, noteId: a._id.toString(), text: '' }),
    ).rejects.toThrow(/text/);
  });

  it('removeDirectorNote pulls the matching note', async () => {
    const a = await Notes.addDirectorNote({ projectId, text: 'a' });
    const b = await Notes.addDirectorNote({ projectId, text: 'b' });
    const c = await Notes.addDirectorNote({ projectId, text: 'c' });

    await Notes.removeDirectorNote({ projectId, noteId: b._id.toString() });

    const doc = await Notes.getDirectorNotes(projectId);
    expect(doc.notes).toHaveLength(2);
    expect(doc.notes[0]._id.equals(a._id)).toBe(true);
    expect(doc.notes[1]._id.equals(c._id)).toBe(true);
  });

  it('removeDirectorNote throws on bad or missing id', async () => {
    await Notes.addDirectorNote({ projectId, text: 'x' });
    await expect(
      Notes.removeDirectorNote({ projectId, noteId: 'not-an-oid' }),
    ).rejects.toThrow(/invalid note_id/);
    const stranger = new ObjectId();
    await expect(
      Notes.removeDirectorNote({ projectId, noteId: stranger.toString() }),
    ).rejects.toThrow(/note not found/);
  });

  it('reorderDirectorNotes reorders to match the supplied id array', async () => {
    const a = await Notes.addDirectorNote({ projectId, text: 'a' });
    const b = await Notes.addDirectorNote({ projectId, text: 'b' });
    const c = await Notes.addDirectorNote({ projectId, text: 'c' });

    await Notes.reorderDirectorNotes({ projectId,
      noteIds: [c._id.toString(), a._id.toString(), b._id.toString()],
    });

    const doc = await Notes.getDirectorNotes(projectId);
    expect(doc.notes.map((n) => n.text)).toEqual(['c', 'a', 'b']);
  });

  it('reorderDirectorNotes rejects partial, extra, or duplicate ids', async () => {
    const a = await Notes.addDirectorNote({ projectId, text: 'a' });
    const b = await Notes.addDirectorNote({ projectId, text: 'b' });

    // missing one
    await expect(
      Notes.reorderDirectorNotes({ projectId, noteIds: [a._id.toString()] }),
    ).rejects.toThrow(/length/);

    // extra (stranger)
    const stranger = new ObjectId();
    await expect(
      Notes.reorderDirectorNotes({ projectId,
        noteIds: [a._id.toString(), b._id.toString(), stranger.toString()],
      }),
    ).rejects.toThrow(/length/);

    // duplicate
    await expect(
      Notes.reorderDirectorNotes({ projectId,
        noteIds: [a._id.toString(), a._id.toString()],
      }),
    ).rejects.toThrow(/duplicate/);

    // bad id
    await expect(
      Notes.reorderDirectorNotes({ projectId, noteIds: ['nope', b._id.toString()] }),
    ).rejects.toThrow(/invalid note_id/);
  });

  it('mutators bump updated_at on the singleton doc', async () => {
    await Notes.addDirectorNote({ projectId, text: 'first' });
    const t1 = (await Notes.getDirectorNotes(projectId)).updated_at;
    expect(t1).toBeInstanceOf(Date);

    await new Promise((r) => setTimeout(r, 5));
    await Notes.addDirectorNote({ projectId, text: 'second' });
    const t2 = (await Notes.getDirectorNotes(projectId)).updated_at;
    expect(t2.getTime()).toBeGreaterThan(t1.getTime());
  });
});

describe('multi-project director notes', () => {
  it('keeps notes per project under composite _ids', async () => {
    const p1 = (await Projects.createProject('Alpha'))._id.toString();
    const p2 = (await Projects.createProject('Beta'))._id.toString();
    await Notes.addDirectorNote({ projectId: p1, text: 'alpha note' });
    const d1 = await Notes.getDirectorNotes(p1);
    const d2 = await Notes.getDirectorNotes(p2);
    expect(d1._id).toBe(`${p1}:director_notes`);
    expect(d1.notes.map((n) => n.text)).toEqual(['alpha note']);
    expect(d2.notes).toEqual([]);
  });

  it('writeDirectorNotesArray persists into the project-keyed doc', async () => {
    const p1 = (await Projects.createProject('Alpha'))._id.toString();
    const note = await Notes.addDirectorNote({ projectId: p1, text: 'before' });
    await Notes.writeDirectorNotesArray(p1, [{ ...note, text: 'after' }]);
    const d1 = await Notes.getDirectorNotes(p1);
    expect(d1.notes[0].text).toBe('after');
  });
});
