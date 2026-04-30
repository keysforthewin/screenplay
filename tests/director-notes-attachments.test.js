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

function fakeImageMeta(suffix = '') {
  return {
    _id: new ObjectId(),
    filename: `pic${suffix}.png`,
    content_type: 'image/png',
    size: 100,
    source: 'upload',
    prompt: null,
    generated_by: null,
    caption: null,
    uploaded_at: new Date(),
  };
}

function fakeAttachmentMeta(suffix = '') {
  return {
    _id: new ObjectId(),
    filename: `file${suffix}.pdf`,
    content_type: 'application/pdf',
    size: 5000,
    caption: null,
    uploaded_at: new Date(),
  };
}

describe('director note image lifecycle', () => {
  it('new notes have empty images/attachments arrays and null main_image_id', async () => {
    const a = await Notes.addDirectorNote({ text: 'first rule' });
    expect(a.images).toEqual([]);
    expect(a.attachments).toEqual([]);
    expect(a.main_image_id).toBe(null);
  });

  it('pushDirectorNoteImage appends and auto-promotes the first image to main', async () => {
    const a = await Notes.addDirectorNote({ text: 'rule a' });
    const m1 = fakeImageMeta('1');
    const { is_main, note } = await Notes.pushDirectorNoteImage(a._id.toString(), m1);
    expect(is_main).toBe(true);
    expect(note.images).toHaveLength(1);
    expect(note.main_image_id.equals(m1._id)).toBe(true);

    const doc = await Notes.getDirectorNotes();
    expect(doc.notes[0].images).toHaveLength(1);
    expect(doc.notes[0].main_image_id.equals(m1._id)).toBe(true);
  });

  it('pushDirectorNoteImage with set_as_main:true overrides existing main', async () => {
    const a = await Notes.addDirectorNote({ text: 'rule a' });
    const m1 = fakeImageMeta('1');
    const m2 = fakeImageMeta('2');
    await Notes.pushDirectorNoteImage(a._id.toString(), m1);
    const { is_main } = await Notes.pushDirectorNoteImage(a._id.toString(), m2, true);
    expect(is_main).toBe(true);

    const doc = await Notes.getDirectorNotes();
    expect(doc.notes[0].images).toHaveLength(2);
    expect(doc.notes[0].main_image_id.equals(m2._id)).toBe(true);
  });

  it('pullDirectorNoteImage promotes the next remaining image when removing main', async () => {
    const a = await Notes.addDirectorNote({ text: 'rule a' });
    const m1 = fakeImageMeta('1');
    const m2 = fakeImageMeta('2');
    await Notes.pushDirectorNoteImage(a._id.toString(), m1);
    await Notes.pushDirectorNoteImage(a._id.toString(), m2);
    const { removed } = await Notes.pullDirectorNoteImage(a._id.toString(), m1._id);
    expect(removed.equals(m1._id)).toBe(true);

    const doc = await Notes.getDirectorNotes();
    expect(doc.notes[0].images).toHaveLength(1);
    expect(doc.notes[0].main_image_id.equals(m2._id)).toBe(true);
  });

  it('pullDirectorNoteImage clears main_image_id when last image is pulled', async () => {
    const a = await Notes.addDirectorNote({ text: 'rule a' });
    const m1 = fakeImageMeta('1');
    await Notes.pushDirectorNoteImage(a._id.toString(), m1);
    await Notes.pullDirectorNoteImage(a._id.toString(), m1._id);

    const doc = await Notes.getDirectorNotes();
    expect(doc.notes[0].images).toHaveLength(0);
    expect(doc.notes[0].main_image_id).toBe(null);
  });

  it('setDirectorNoteMainImage rejects an unattached id', async () => {
    const a = await Notes.addDirectorNote({ text: 'rule a' });
    const stranger = new ObjectId();
    await expect(
      Notes.setDirectorNoteMainImage(a._id.toString(), stranger),
    ).rejects.toThrow(/not attached/);
  });

  it('setDirectorNoteMainImage promotes an attached image', async () => {
    const a = await Notes.addDirectorNote({ text: 'rule a' });
    const m1 = fakeImageMeta('1');
    const m2 = fakeImageMeta('2');
    await Notes.pushDirectorNoteImage(a._id.toString(), m1);
    await Notes.pushDirectorNoteImage(a._id.toString(), m2);
    const next = await Notes.setDirectorNoteMainImage(a._id.toString(), m2._id);
    expect(next.main_image_id.equals(m2._id)).toBe(true);
  });

  it('pushDirectorNoteAttachment / pullDirectorNoteAttachment round-trip', async () => {
    const a = await Notes.addDirectorNote({ text: 'rule a' });
    const att = fakeAttachmentMeta('1');
    await Notes.pushDirectorNoteAttachment(a._id.toString(), att);

    let doc = await Notes.getDirectorNotes();
    expect(doc.notes[0].attachments).toHaveLength(1);
    expect(doc.notes[0].attachments[0]._id.equals(att._id)).toBe(true);

    const { removed } = await Notes.pullDirectorNoteAttachment(a._id.toString(), att._id);
    expect(removed.equals(att._id)).toBe(true);

    doc = await Notes.getDirectorNotes();
    expect(doc.notes[0].attachments).toHaveLength(0);
  });

  it('pullDirectorNoteAttachment rejects an unattached id', async () => {
    const a = await Notes.addDirectorNote({ text: 'rule a' });
    const stranger = new ObjectId();
    await expect(
      Notes.pullDirectorNoteAttachment(a._id.toString(), stranger),
    ).rejects.toThrow(/not attached/);
  });

  it('helpers reject an unknown note_id', async () => {
    const stranger = new ObjectId();
    await expect(
      Notes.pushDirectorNoteImage(stranger.toString(), fakeImageMeta()),
    ).rejects.toThrow(/note not found/);
    await expect(
      Notes.pushDirectorNoteAttachment(stranger.toString(), fakeAttachmentMeta()),
    ).rejects.toThrow(/note not found/);
  });

  it('legacy notes (no images/attachments fields) read back as empty arrays', async () => {
    // Insert a legacy doc directly, mirroring what an older bot version may have stored.
    await fakeDb.collection('prompts').insertOne({
      _id: 'director_notes',
      notes: [{ _id: new ObjectId(), text: 'old rule', created_at: new Date() }],
      updated_at: new Date(),
    });
    const doc = await Notes.getDirectorNotes();
    expect(doc.notes).toHaveLength(1);
    expect(doc.notes[0].images).toEqual([]);
    expect(doc.notes[0].attachments).toEqual([]);
    expect(doc.notes[0].main_image_id).toBe(null);
  });

  it('getDirectorNote helper resolves an attached note by hex id and rejects garbage', () => {
    const id = new ObjectId();
    const notes = [{ _id: id, text: 'a' }];
    expect(Notes.getDirectorNote(notes, id.toString())?.text).toBe('a');
    expect(Notes.getDirectorNote(notes, 'not-an-oid')).toBe(null);
    expect(Notes.getDirectorNote(notes, new ObjectId().toString())).toBe(null);
  });
});
