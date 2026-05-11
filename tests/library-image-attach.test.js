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

const Files = await import('../src/mongo/files.js');
const Characters = await import('../src/mongo/characters.js');
const Plots = await import('../src/mongo/plots.js');
const DirectorNotes = await import('../src/mongo/directorNotes.js');

beforeEach(() => {
  fakeDb.reset();
});

function seedLibraryImage(extra = {}) {
  const doc = {
    _id: new ObjectId(),
    filename: 'lib.png',
    contentType: 'image/png',
    length: 1234,
    uploadDate: new Date(),
    metadata: {
      owner_type: null,
      owner_id: null,
      source: 'generated',
      prompt: 'a leopard',
      generated_by: 'gemini-2.5-flash-image',
    },
    ...extra,
  };
  fakeDb.collection('images.files')._docs.push(doc);
  return doc;
}

async function seedCharacter(name) {
  const c = await Characters.createCharacter({ name });
  return c;
}

describe('attach_library_image_to_character', () => {
  it('attaches a library image to a character and promotes it as main when first', async () => {
    const c = await seedCharacter('Bronze Leopard');
    const file = seedLibraryImage();

    const res = await Files.attachExistingImageToCharacter({
      character: 'Bronze Leopard',
      imageId: file._id,
    });

    expect(res.is_main).toBe(true);
    expect(res.character).toBe('Bronze Leopard');

    const updated = await fakeDb.collection('characters').findOne({ _id: c._id });
    expect(updated.images).toHaveLength(1);
    expect(updated.images[0].filename).toBe('lib.png');
    expect(updated.main_image_id.equals(file._id)).toBe(true);

    const fileAfter = await fakeDb.collection('images.files').findOne({ _id: file._id });
    expect(fileAfter.metadata.owner_type).toBe('character');
    expect(fileAfter.metadata.owner_id.equals(c._id)).toBe(true);
  });

  it('does not promote to main when there is already a main and set_as_main is false', async () => {
    const existingMainId = new ObjectId();
    const c = await seedCharacter('Iris');
    await fakeDb.collection('characters').updateOne(
      { _id: c._id },
      {
        $set: {
          images: [
            {
              _id: existingMainId,
              filename: 'first.png',
              content_type: 'image/png',
              size: 100,
              uploaded_at: new Date(),
              caption: null,
            },
          ],
          main_image_id: existingMainId,
        },
      },
    );
    const file = seedLibraryImage();

    const res = await Files.attachExistingImageToCharacter({
      character: 'Iris',
      imageId: file._id,
    });

    expect(res.is_main).toBe(false);

    const updated = await fakeDb.collection('characters').findOne({ _id: c._id });
    expect(updated.images).toHaveLength(2);
    expect(updated.main_image_id.equals(existingMainId)).toBe(true);
  });

  it('promotes to main when set_as_main is true even with existing images', async () => {
    const existingMainId = new ObjectId();
    const c = await seedCharacter('Owen');
    await fakeDb.collection('characters').updateOne(
      { _id: c._id },
      {
        $set: {
          images: [
            {
              _id: existingMainId,
              filename: 'first.png',
              content_type: 'image/png',
              size: 100,
              uploaded_at: new Date(),
              caption: null,
            },
          ],
          main_image_id: existingMainId,
        },
      },
    );
    const file = seedLibraryImage();

    const res = await Files.attachExistingImageToCharacter({
      character: 'Owen',
      imageId: file._id,
      setAsMain: true,
    });

    expect(res.is_main).toBe(true);
    const updated = await fakeDb.collection('characters').findOne({ _id: c._id });
    expect(updated.main_image_id.equals(file._id)).toBe(true);
  });

  it('is idempotent when re-attaching to the same character', async () => {
    const c = await seedCharacter('Polly');
    const file = seedLibraryImage();

    await Files.attachExistingImageToCharacter({
      character: 'Polly',
      imageId: file._id,
    });

    const second = await Files.attachExistingImageToCharacter({
      character: 'Polly',
      imageId: file._id,
    });

    expect(second.already_attached).toBe(true);
    const updated = await fakeDb.collection('characters').findOne({ _id: c._id });
    expect(updated.images).toHaveLength(1);
  });

  it('moves the image off the prior character when reattaching to a different one', async () => {
    const cA = await seedCharacter('Bronze Leopard');
    const cB = await seedCharacter('Silver Wolf');
    const file = seedLibraryImage();

    await Files.attachExistingImageToCharacter({
      character: 'Bronze Leopard',
      imageId: file._id,
    });

    const res = await Files.attachExistingImageToCharacter({
      character: 'Silver Wolf',
      imageId: file._id,
    });

    expect(res.character).toBe('Silver Wolf');
    expect(res.moved_from?.prior_owner_type).toBe('character');
    expect(res.moved_from?.prior_owner_name).toBe('Bronze Leopard');

    const wolf = await fakeDb.collection('characters').findOne({ _id: cB._id });
    expect(wolf.images).toHaveLength(1);
    expect(wolf.main_image_id.equals(file._id)).toBe(true);

    const leopard = await fakeDb.collection('characters').findOne({ _id: cA._id });
    expect(leopard.images || []).toHaveLength(0);
    expect(leopard.main_image_id).toBeNull();

    const fileAfter = await fakeDb.collection('images.files').findOne({ _id: file._id });
    expect(fileAfter.metadata.owner_type).toBe('character');
    expect(fileAfter.metadata.owner_id.equals(cB._id)).toBe(true);
  });

  it('moves the image off a real beat when attaching to a character', async () => {
    const c = await seedCharacter('Bronze Leopard');
    const beat = await Plots.createBeat({ name: 'Diner Showdown' });
    const file = seedLibraryImage({
      metadata: { owner_type: 'beat', owner_id: beat._id },
    });
    await Plots.pushBeatImage(beat._id.toString(), {
      _id: file._id,
      filename: file.filename,
      content_type: file.contentType,
      size: file.length,
      uploaded_at: file.uploadDate,
    });

    const res = await Files.attachExistingImageToCharacter({
      character: 'Bronze Leopard',
      imageId: file._id,
    });

    expect(res.moved_from?.prior_owner_type).toBe('beat');
    expect(res.moved_from?.prior_owner_name).toBe('Diner Showdown');

    const plot = await Plots.getPlot();
    const updatedBeat = plot.beats.find((b) => b._id.equals(beat._id));
    expect(updatedBeat.images || []).toHaveLength(0);

    const updatedChar = await fakeDb.collection('characters').findOne({ _id: c._id });
    expect(updatedChar.images).toHaveLength(1);
  });

  it('moves the image off a real director note when attaching to a character', async () => {
    await seedCharacter('Bronze Leopard');
    const note = await DirectorNotes.addDirectorNote({ text: 'noir tone' });
    const file = seedLibraryImage({
      metadata: { owner_type: 'director_note', owner_id: note._id },
    });
    await DirectorNotes.pushDirectorNoteImage(note._id.toString(), {
      _id: file._id,
      filename: file.filename,
      content_type: file.contentType,
      size: file.length,
      uploaded_at: file.uploadDate,
    });

    const res = await Files.attachExistingImageToCharacter({
      character: 'Bronze Leopard',
      imageId: file._id,
    });

    expect(res.moved_from?.prior_owner_type).toBe('director_note');

    const dn = await DirectorNotes.getDirectorNotes();
    const updatedNote = dn.notes.find((n) => n._id.equals(note._id));
    expect(updatedNote.images || []).toHaveLength(0);
  });

  it('succeeds when prior owner metadata points at a deleted entity', async () => {
    await seedCharacter('Bronze Leopard');
    const file = seedLibraryImage({
      metadata: { owner_type: 'beat', owner_id: new ObjectId() },
    });

    const res = await Files.attachExistingImageToCharacter({
      character: 'Bronze Leopard',
      imageId: file._id,
    });

    expect(res.character).toBe('Bronze Leopard');
    expect(res.moved_from?.prior_owner_type).toBe('beat');
    expect(res.moved_from?.prior_owner_name).toBeNull();

    const fileAfter = await fakeDb.collection('images.files').findOne({ _id: file._id });
    expect(fileAfter.metadata.owner_type).toBe('character');
  });

  it('throws when the image_id does not exist', async () => {
    await seedCharacter('Bronze Leopard');
    await expect(
      Files.attachExistingImageToCharacter({
        character: 'Bronze Leopard',
        imageId: new ObjectId(),
      }),
    ).rejects.toThrow(/Image not found/);
  });

  it('throws when the character does not exist', async () => {
    const file = seedLibraryImage();
    await expect(
      Files.attachExistingImageToCharacter({
        character: 'Nonexistent',
        imageId: file._id,
      }),
    ).rejects.toThrow(/Character not found/);
  });
});

describe('attach_library_image_to_character handler', () => {
  it('returns a success message and surfaces is_main', async () => {
    const { HANDLERS } = await import('../src/agent/handlers.js');
    await seedCharacter('Bronze Leopard');
    const file = seedLibraryImage();

    const out = await HANDLERS.attach_library_image_to_character({
      image_id: file._id.toString(),
      character: 'Bronze Leopard',
      set_as_main: true,
    });
    expect(out).toMatch(/Attached image to character "Bronze Leopard"/);
    expect(out).toMatch(/now main image/);
  });

  it('returns an "already attached" message on idempotent re-attach', async () => {
    const { HANDLERS } = await import('../src/agent/handlers.js');
    await seedCharacter('Polly');
    const file = seedLibraryImage();

    await HANDLERS.attach_library_image_to_character({
      image_id: file._id.toString(),
      character: 'Polly',
    });
    const second = await HANDLERS.attach_library_image_to_character({
      image_id: file._id.toString(),
      character: 'Polly',
    });
    expect(second).toMatch(/already attached/);
  });

  it('surfaces a "(moved from beat ...)" suffix when the image was beat-owned', async () => {
    const { HANDLERS } = await import('../src/agent/handlers.js');
    await seedCharacter('Bronze Leopard');
    const beat = await Plots.createBeat({ name: 'Diner Showdown' });
    const file = seedLibraryImage({
      metadata: { owner_type: 'beat', owner_id: beat._id },
    });
    await Plots.pushBeatImage(beat._id.toString(), {
      _id: file._id,
      filename: file.filename,
      content_type: file.contentType,
      size: file.length,
      uploaded_at: file.uploadDate,
    });

    const out = await HANDLERS.attach_library_image_to_character({
      image_id: file._id.toString(),
      character: 'Bronze Leopard',
    });
    expect(out).toMatch(/Attached image to character "Bronze Leopard"/);
    expect(out).toMatch(/moved from beat "Diner Showdown"/);
  });
});
