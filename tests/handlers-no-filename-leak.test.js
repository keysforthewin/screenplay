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

const Characters = await import('../src/mongo/characters.js');
const Plots = await import('../src/mongo/plots.js');
const DirectorNotes = await import('../src/mongo/directorNotes.js');
const { HANDLERS } = await import('../src/agent/handlers.js');

beforeEach(() => {
  fakeDb.reset();
});

const TMDB_FILENAME = 'iYdeP6K0qz44Wg2Nw9LPJGMBkQ5.jpg';

function fakeImageMeta({ filename = TMDB_FILENAME, source = 'upload' } = {}) {
  return {
    _id: new ObjectId(),
    filename,
    content_type: 'image/jpeg',
    size: 56000,
    source,
    prompt: null,
    generated_by: null,
    caption: null,
    uploaded_at: new Date(),
  };
}

async function seedCharacterWithImage(name = 'Flikk') {
  const c = await Characters.createCharacter({ name, plays_self: true, own_voice: true });
  const meta = fakeImageMeta();
  await Characters.pushCharacterImage(c._id.toString(), meta, true);
  return { character: c, imageMeta: meta };
}

async function seedBeatWithImage() {
  const beat = await Plots.createBeat({ name: 'Diner', desc: 'A scene at the diner.' });
  const meta = fakeImageMeta({ filename: 'beat-leak-name.jpg' });
  await Plots.pushBeatImage(beat._id.toString(), meta, true);
  return { beat, imageMeta: meta };
}

async function seedDirectorNoteWithImage() {
  const note = await DirectorNotes.addDirectorNote({ text: 'Always show, never tell.' });
  const meta = fakeImageMeta({ filename: 'note-leak-name.png' });
  await DirectorNotes.pushDirectorNoteImage(note._id.toString(), meta, true);
  return { note, imageMeta: meta };
}

function seedLibraryImage(filename = 'lib-leak-name.png') {
  const doc = {
    _id: new ObjectId(),
    filename,
    contentType: 'image/png',
    length: 1234,
    uploadDate: new Date(),
    metadata: { owner_type: null, owner_id: null, source: 'generated' },
  };
  fakeDb.collection('images.files')._docs.push(doc);
  return doc;
}

function parseTrailingJson(text) {
  // Several handlers return free-form prefix + JSON body; pull the JSON object out.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`No JSON in:\n${text}`);
  return JSON.parse(text.slice(start, end + 1));
}

describe('image-listing handlers do not leak GridFS filename', () => {
  it('list_character_images omits filename and does not include the leaked string', async () => {
    await seedCharacterWithImage('Flikk');

    const out = await HANDLERS.list_character_images({ character: 'Flikk' });

    expect(out).not.toContain(TMDB_FILENAME);
    const parsed = parseTrailingJson(out);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]).not.toHaveProperty('filename');
    expect(parsed.images[0]).toHaveProperty('_id');
    expect(parsed.images[0]).toHaveProperty('content_type', 'image/jpeg');
  });

  it('list_beat_images omits filename', async () => {
    const { beat } = await seedBeatWithImage();

    const out = await HANDLERS.list_beat_images({ beat: beat._id.toString() });

    expect(out).not.toContain('beat-leak-name.jpg');
    const parsed = parseTrailingJson(out);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]).not.toHaveProperty('filename');
    expect(parsed.images[0]).toHaveProperty('_id');
  });

  it('list_director_note_images omits filename', async () => {
    const { note } = await seedDirectorNoteWithImage();

    const out = await HANDLERS.list_director_note_images({ note_id: note._id.toString() });

    expect(out).not.toContain('note-leak-name.png');
    const parsed = parseTrailingJson(out);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]).not.toHaveProperty('filename');
    expect(parsed.images[0]).toHaveProperty('_id');
  });

  it('list_library_images omits filename', async () => {
    seedLibraryImage('lib-leak-name.png');

    const out = await HANDLERS.list_library_images();

    expect(out).not.toContain('lib-leak-name.png');
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).not.toHaveProperty('filename');
    expect(parsed[0]).toHaveProperty('_id');
  });

  it('get_character does not leak the filename of an embedded image', async () => {
    await seedCharacterWithImage('Flikk');

    const out = await HANDLERS.get_character({ identifier: 'Flikk' });

    expect(out).not.toContain(TMDB_FILENAME);
    const parsed = parseTrailingJson(out);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]).not.toHaveProperty('filename');
  });

  it('get_beat does not leak the filename of an embedded image', async () => {
    const { beat } = await seedBeatWithImage();

    const out = await HANDLERS.get_beat({ identifier: beat._id.toString() });

    expect(out).not.toContain('beat-leak-name.jpg');
    const parsed = parseTrailingJson(out);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]).not.toHaveProperty('filename');
  });
});
