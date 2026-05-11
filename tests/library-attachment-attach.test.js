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

  it('moves the attachment off a real prior beat when reattaching to a character', async () => {
    const c = await Characters.createCharacter({ name: 'Bronze Leopard' });
    const beat = await Plots.createBeat({ name: 'Diner Showdown' });
    const file = seedLibraryAttachment({
      metadata: { owner_type: 'beat', owner_id: beat._id },
    });
    await Plots.pushBeatAttachment(beat._id.toString(), {
      _id: file._id,
      filename: file.filename,
      content_type: file.contentType,
      size: file.length,
      uploaded_at: file.uploadDate,
    });

    const res = await Attachments.attachExistingAttachmentToCharacter({
      character: 'Bronze Leopard',
      attachmentId: file._id,
    });
    expect(res.character).toBe('Bronze Leopard');
    expect(res.moved_from?.prior_owner_type).toBe('beat');
    expect(res.moved_from?.prior_owner_name).toBe('Diner Showdown');

    const plot = await Plots.getPlot();
    const updatedBeat = plot.beats.find((b) => b._id.equals(beat._id));
    expect(updatedBeat.attachments || []).toHaveLength(0);

    const updated = await fakeDb.collection('characters').findOne({ _id: c._id });
    expect(updated.attachments).toHaveLength(1);

    const fileAfter = await fakeDb.collection('attachments.files').findOne({ _id: file._id });
    expect(fileAfter.metadata.owner_type).toBe('character');
  });

  it('succeeds with stale prior-owner metadata pointing at a deleted beat', async () => {
    await Characters.createCharacter({ name: 'Bronze Leopard' });
    const file = seedLibraryAttachment({
      metadata: { owner_type: 'beat', owner_id: new ObjectId() },
    });
    const res = await Attachments.attachExistingAttachmentToCharacter({
      character: 'Bronze Leopard',
      attachmentId: file._id,
    });
    expect(res.moved_from?.prior_owner_type).toBe('beat');
    expect(res.moved_from?.prior_owner_name).toBeNull();
    const fileAfter = await fakeDb.collection('attachments.files').findOne({ _id: file._id });
    expect(fileAfter.metadata.owner_type).toBe('character');
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

describe('attachment move-on-attach across owner types', () => {
  it('moves an attachment from one character to another', async () => {
    const cA = await Characters.createCharacter({ name: 'Bronze Leopard' });
    const cB = await Characters.createCharacter({ name: 'Silver Wolf' });
    const file = seedLibraryAttachment();

    await Attachments.attachExistingAttachmentToCharacter({
      character: 'Bronze Leopard',
      attachmentId: file._id,
    });
    const res = await Attachments.attachExistingAttachmentToCharacter({
      character: 'Silver Wolf',
      attachmentId: file._id,
    });

    expect(res.moved_from?.prior_owner_type).toBe('character');
    expect(res.moved_from?.prior_owner_name).toBe('Bronze Leopard');

    const wolf = await fakeDb.collection('characters').findOne({ _id: cB._id });
    expect(wolf.attachments).toHaveLength(1);
    const leopard = await fakeDb.collection('characters').findOne({ _id: cA._id });
    expect(leopard.attachments || []).toHaveLength(0);
  });

  it('moves an attachment from a note onto a beat', async () => {
    const note = await DirectorNotes.addDirectorNote({ text: 'lighting cues' });
    const beat = await Plots.createBeat({ name: 'Climax' });
    const file = seedLibraryAttachment({
      metadata: { owner_type: 'director_note', owner_id: note._id },
    });
    await fakeDb.collection('prompts').updateOne(
      { _id: 'director_notes' },
      {
        $set: {
          notes: [
            {
              ...(await DirectorNotes.getDirectorNotes()).notes[0],
              attachments: [
                {
                  _id: file._id,
                  filename: file.filename,
                  content_type: file.contentType,
                  size: file.length,
                  uploaded_at: file.uploadDate,
                },
              ],
            },
          ],
        },
      },
    );

    const res = await Attachments.attachExistingAttachmentToBeat({
      beat: 'Climax',
      attachmentId: file._id,
    });
    expect(res.moved_from?.prior_owner_type).toBe('director_note');

    const dn = await DirectorNotes.getDirectorNotes();
    const updatedNote = dn.notes.find((n) => n._id.equals(note._id));
    expect(updatedNote.attachments || []).toHaveLength(0);

    const plot = await Plots.getPlot();
    const updatedBeat = plot.beats.find((b) => b._id.equals(beat._id));
    expect(updatedBeat.attachments).toHaveLength(1);
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

  it('surfaces a "(moved from beat ...)" suffix in the handler message', async () => {
    const { HANDLERS } = await import('../src/agent/handlers.js');
    await Characters.createCharacter({ name: 'Bronze Leopard' });
    const beat = await Plots.createBeat({ name: 'Diner Showdown' });
    const file = seedLibraryAttachment({
      metadata: { owner_type: 'beat', owner_id: beat._id },
    });
    await Plots.pushBeatAttachment(beat._id.toString(), {
      _id: file._id,
      filename: file.filename,
      content_type: file.contentType,
      size: file.length,
      uploaded_at: file.uploadDate,
    });

    const out = await HANDLERS.attach_library_attachment_to_character({
      attachment_id: file._id.toString(),
      character: 'Bronze Leopard',
    });
    expect(out).toMatch(/moved from beat "Diner Showdown"/);
  });
});
