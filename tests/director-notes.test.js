import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Notes = await import('../src/mongo/directorNotes.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('director notes singleton', () => {
  it('getDirectorNotes returns an empty notes array when the doc does not exist', async () => {
    const doc = await Notes.getDirectorNotes();
    expect(doc._id).toBe('director_notes');
    expect(doc.notes).toEqual([]);
    // and does not write the empty doc
    expect(fakeDb.collection('prompts')._docs).toHaveLength(0);
  });

  it('addDirectorNote appends to the end and returns the new note with an ObjectId', async () => {
    const a = await Notes.addDirectorNote({ text: 'No anachronisms unless flagged.' });
    const b = await Notes.addDirectorNote({ text: 'Unnamed extras are Feral Ewoks.' });

    expect(a._id).toBeInstanceOf(ObjectId);
    expect(a.text).toBe('No anachronisms unless flagged.');
    expect(a.created_at).toBeInstanceOf(Date);

    const doc = await Notes.getDirectorNotes();
    expect(doc.notes).toHaveLength(2);
    expect(doc.notes[0]._id.equals(a._id)).toBe(true);
    expect(doc.notes[1]._id.equals(b._id)).toBe(true);
  });

  it('addDirectorNote with a position inserts at that index', async () => {
    const a = await Notes.addDirectorNote({ text: 'first' });
    const c = await Notes.addDirectorNote({ text: 'third' });
    const b = await Notes.addDirectorNote({ text: 'second', position: 1 });

    const doc = await Notes.getDirectorNotes();
    expect(doc.notes.map((n) => n.text)).toEqual(['first', 'second', 'third']);
    expect(doc.notes[0]._id.equals(a._id)).toBe(true);
    expect(doc.notes[1]._id.equals(b._id)).toBe(true);
    expect(doc.notes[2]._id.equals(c._id)).toBe(true);
  });

  it('addDirectorNote requires non-empty text', async () => {
    await expect(Notes.addDirectorNote({ text: '' })).rejects.toThrow(/text/);
    await expect(Notes.addDirectorNote({ text: '   ' })).rejects.toThrow(/text/);
    await expect(Notes.addDirectorNote({})).rejects.toThrow(/text/);
  });

  it('editDirectorNote updates the right note and bumps updated_at', async () => {
    const a = await Notes.addDirectorNote({ text: 'one' });
    const b = await Notes.addDirectorNote({ text: 'two' });
    const before = (await Notes.getDirectorNotes()).updated_at;
    // ensure clock advances — the in-memory write is sub-ms otherwise
    await new Promise((r) => setTimeout(r, 5));

    await Notes.editDirectorNote({ noteId: b._id.toString(), text: 'TWO' });

    const doc = await Notes.getDirectorNotes();
    expect(doc.notes[0].text).toBe('one');
    expect(doc.notes[1].text).toBe('TWO');
    expect(doc.notes[1]._id.equals(b._id)).toBe(true);
    expect(doc.updated_at.getTime()).toBeGreaterThan(before.getTime());
    // unchanged note should still be there with its original id
    expect(doc.notes[0]._id.equals(a._id)).toBe(true);
  });

  it('editDirectorNote throws on bad id and on missing id', async () => {
    await Notes.addDirectorNote({ text: 'x' });
    await expect(
      Notes.editDirectorNote({ noteId: 'not-an-oid', text: 'y' }),
    ).rejects.toThrow(/invalid note_id/);
    const stranger = new ObjectId();
    await expect(
      Notes.editDirectorNote({ noteId: stranger.toString(), text: 'y' }),
    ).rejects.toThrow(/note not found/);
  });

  it('editDirectorNote requires non-empty text', async () => {
    const a = await Notes.addDirectorNote({ text: 'x' });
    await expect(
      Notes.editDirectorNote({ noteId: a._id.toString(), text: '' }),
    ).rejects.toThrow(/text/);
  });

  it('removeDirectorNote pulls the matching note', async () => {
    const a = await Notes.addDirectorNote({ text: 'a' });
    const b = await Notes.addDirectorNote({ text: 'b' });
    const c = await Notes.addDirectorNote({ text: 'c' });

    await Notes.removeDirectorNote({ noteId: b._id.toString() });

    const doc = await Notes.getDirectorNotes();
    expect(doc.notes).toHaveLength(2);
    expect(doc.notes[0]._id.equals(a._id)).toBe(true);
    expect(doc.notes[1]._id.equals(c._id)).toBe(true);
  });

  it('removeDirectorNote throws on bad or missing id', async () => {
    await Notes.addDirectorNote({ text: 'x' });
    await expect(
      Notes.removeDirectorNote({ noteId: 'not-an-oid' }),
    ).rejects.toThrow(/invalid note_id/);
    const stranger = new ObjectId();
    await expect(
      Notes.removeDirectorNote({ noteId: stranger.toString() }),
    ).rejects.toThrow(/note not found/);
  });

  it('reorderDirectorNotes reorders to match the supplied id array', async () => {
    const a = await Notes.addDirectorNote({ text: 'a' });
    const b = await Notes.addDirectorNote({ text: 'b' });
    const c = await Notes.addDirectorNote({ text: 'c' });

    await Notes.reorderDirectorNotes({
      noteIds: [c._id.toString(), a._id.toString(), b._id.toString()],
    });

    const doc = await Notes.getDirectorNotes();
    expect(doc.notes.map((n) => n.text)).toEqual(['c', 'a', 'b']);
  });

  it('reorderDirectorNotes rejects partial, extra, or duplicate ids', async () => {
    const a = await Notes.addDirectorNote({ text: 'a' });
    const b = await Notes.addDirectorNote({ text: 'b' });

    // missing one
    await expect(
      Notes.reorderDirectorNotes({ noteIds: [a._id.toString()] }),
    ).rejects.toThrow(/length/);

    // extra (stranger)
    const stranger = new ObjectId();
    await expect(
      Notes.reorderDirectorNotes({
        noteIds: [a._id.toString(), b._id.toString(), stranger.toString()],
      }),
    ).rejects.toThrow(/length/);

    // duplicate
    await expect(
      Notes.reorderDirectorNotes({
        noteIds: [a._id.toString(), a._id.toString()],
      }),
    ).rejects.toThrow(/duplicate/);

    // bad id
    await expect(
      Notes.reorderDirectorNotes({ noteIds: ['nope', b._id.toString()] }),
    ).rejects.toThrow(/invalid note_id/);
  });

  it('mutators bump updated_at on the singleton doc', async () => {
    await Notes.addDirectorNote({ text: 'first' });
    const t1 = (await Notes.getDirectorNotes()).updated_at;
    expect(t1).toBeInstanceOf(Date);

    await new Promise((r) => setTimeout(r, 5));
    await Notes.addDirectorNote({ text: 'second' });
    const t2 = (await Notes.getDirectorNotes()).updated_at;
    expect(t2.getTime()).toBeGreaterThan(t1.getTime());
  });
});
