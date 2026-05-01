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

const Attachments = await import('../src/mongo/attachments.js');
const Characters = await import('../src/mongo/characters.js');
const Plots = await import('../src/mongo/plots.js');
const DirectorNotes = await import('../src/mongo/directorNotes.js');

beforeEach(() => {
  fakeDb.reset();
});

function seedLibraryAttachment(extra = {}) {
  const doc = {
    _id: new ObjectId(),
    filename: 'cue.mp3',
    contentType: 'audio/mpeg',
    length: 5000,
    uploadDate: new Date(),
    metadata: {
      owner_type: null,
      owner_id: null,
      source: 'upload',
      content_type: 'audio/mpeg',
    },
    ...extra,
  };
  fakeDb.collection('attachments.files')._docs.push(doc);
  return doc;
}

describe('listLibraryAttachments', () => {
  it('returns only files with owner_type null', async () => {
    seedLibraryAttachment();
    seedLibraryAttachment({
      metadata: { owner_type: 'beat', owner_id: new ObjectId() },
    });
    seedLibraryAttachment();

    const lib = await Attachments.listLibraryAttachments();
    expect(lib).toHaveLength(2);
    for (const f of lib) expect(f.metadata.owner_type).toBeNull();
  });
});

describe('attachExistingAttachmentToCharacter', () => {
  it('moves a library attachment to a character', async () => {
    const c = await Characters.createCharacter({ name: 'Bronze Leopard' });
    const file = seedLibraryAttachment();

    const res = await Attachments.attachExistingAttachmentToCharacter({
      character: 'Bronze Leopard',
      attachmentId: file._id,
      caption: 'theme music',
    });

    expect(res.character).toBe('Bronze Leopard');
    expect(res.filename).toBe('cue.mp3');

    const updated = await fakeDb.collection('characters').findOne({ _id: c._id });
    expect(updated.attachments).toHaveLength(1);
    expect(updated.attachments[0].caption).toBe('theme music');

    const fileAfter = await fakeDb.collection('attachments.files').findOne({ _id: file._id });
    expect(fileAfter.metadata.owner_type).toBe('character');
    expect(fileAfter.metadata.owner_id.equals(c._id)).toBe(true);
  });

  it('is idempotent on re-attach to same character', async () => {
    await Characters.createCharacter({ name: 'Polly' });
    const file = seedLibraryAttachment();

    await Attachments.attachExistingAttachmentToCharacter({
      character: 'Polly',
      attachmentId: file._id,
    });
    const second = await Attachments.attachExistingAttachmentToCharacter({
      character: 'Polly',
      attachmentId: file._id,
    });
    expect(second.already_attached).toBe(true);
  });

  it('throws when the attachment is owned elsewhere', async () => {
    await Characters.createCharacter({ name: 'Bronze Leopard' });
    const file = seedLibraryAttachment({
      metadata: { owner_type: 'beat', owner_id: new ObjectId() },
    });
    await expect(
      Attachments.attachExistingAttachmentToCharacter({
        character: 'Bronze Leopard',
        attachmentId: file._id,
      }),
    ).rejects.toThrow(/attached to a beat/);
  });

  it('throws when the attachment_id does not exist', async () => {
    await Characters.createCharacter({ name: 'Bronze Leopard' });
    await expect(
      Attachments.attachExistingAttachmentToCharacter({
        character: 'Bronze Leopard',
        attachmentId: new ObjectId(),
      }),
    ).rejects.toThrow(/Attachment not found/);
  });
});

describe('attachExistingAttachmentToBeat', () => {
  it('moves a library attachment to a beat by name', async () => {
    const beat = await Plots.createBeat({ name: 'Diner Showdown', desc: 'tense' });
    const file = seedLibraryAttachment();

    const res = await Attachments.attachExistingAttachmentToBeat({
      beat: 'Diner Showdown',
      attachmentId: file._id,
    });

    expect(res.beat.name).toBe('Diner Showdown');

    const plot = await Plots.getPlot();
    const updated = plot.beats.find((b) => b._id.equals(beat._id));
    expect(updated.attachments).toHaveLength(1);
    expect(updated.attachments[0]._id.equals(file._id)).toBe(true);

    const fileAfter = await fakeDb.collection('attachments.files').findOne({ _id: file._id });
    expect(fileAfter.metadata.owner_type).toBe('beat');
    expect(fileAfter.metadata.owner_id.equals(beat._id)).toBe(true);
  });

  it('throws when beat is unknown', async () => {
    const file = seedLibraryAttachment();
    await expect(
      Attachments.attachExistingAttachmentToBeat({
        beat: 'Nonexistent',
        attachmentId: file._id,
      }),
    ).rejects.toThrow(/Beat not found/);
  });
});

describe('attachExistingAttachmentToDirectorNote', () => {
  it('moves a library attachment to a director note', async () => {
    const note = await DirectorNotes.addDirectorNote({ text: 'keep dialect Appalachian' });
    const file = seedLibraryAttachment();

    const res = await Attachments.attachExistingAttachmentToDirectorNote({
      noteId: note._id.toString(),
      attachmentId: file._id,
    });
    expect(res.note_id.equals(note._id)).toBe(true);

    const dn = await DirectorNotes.getDirectorNotes();
    const updated = dn.notes.find((n) => n._id.equals(note._id));
    expect(updated.attachments).toHaveLength(1);
    expect(updated.attachments[0]._id.equals(file._id)).toBe(true);

    const fileAfter = await fakeDb.collection('attachments.files').findOne({ _id: file._id });
    expect(fileAfter.metadata.owner_type).toBe('director_note');
    expect(fileAfter.metadata.owner_id.equals(note._id)).toBe(true);
  });

  it('throws when note_id is unknown', async () => {
    const file = seedLibraryAttachment();
    await expect(
      Attachments.attachExistingAttachmentToDirectorNote({
        noteId: new ObjectId().toString(),
        attachmentId: file._id,
      }),
    ).rejects.toThrow(/Director note not found/);
  });
});

describe('handler: list_library_attachments and attach_library_attachment_to_character', () => {
  it('lists library attachments and dispatches the character attach', async () => {
    const { HANDLERS } = await import('../src/agent/handlers.js');
    await Characters.createCharacter({ name: 'Bronze Leopard' });
    const file = seedLibraryAttachment();

    const list = await HANDLERS.list_library_attachments();
    const parsed = JSON.parse(list);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]._id).toBe(file._id.toString());

    const out = await HANDLERS.attach_library_attachment_to_character({
      attachment_id: file._id.toString(),
      character: 'Bronze Leopard',
    });
    expect(out).toMatch(/Attached attachment to character "Bronze Leopard"/);
  });
});
