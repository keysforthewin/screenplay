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

// Capture every call so tests can assert on inputImage / prompt.
const geminiCalls = [];
vi.mock('../src/gemini/client.js', () => ({
  generateImage: async (args) => {
    geminiCalls.push(args);
    return {
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      contentType: 'image/png',
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 1,
        totalTokenCount: 2,
      },
    };
  },
  NANO_BANANA_MODEL: 'gemini-2.5-flash-image',
}));

// Stand-in for the GridFS bucket. Stores image metadata + bytes in memory and
// preserves real ObjectId equality so the handler's "was main?" check works.
const fakeBucket = new Map(); // id.toString() -> { buffer, file }
const uploads = []; // captured uploadGeneratedImage args
const deletions = []; // captured deleteImage ids

vi.mock('../src/mongo/images.js', async () => {
  return {
    readImageBuffer: async (id) => {
      const key = id instanceof ObjectId ? id.toString() : String(id);
      return fakeBucket.get(key) || null;
    },
    uploadGeneratedImage: async ({ buffer, contentType, prompt, generatedBy, ownerType, ownerId }) => {
      const _id = new ObjectId();
      uploads.push({ _id, ownerType, ownerId, prompt, generatedBy, contentType });
      const file = {
        _id,
        filename: `gen-${_id}.png`,
        contentType,
        length: buffer.length,
        metadata: { owner_type: ownerType, owner_id: ownerId || null },
        uploadDate: new Date(),
      };
      fakeBucket.set(_id.toString(), { buffer, file });
      return {
        _id,
        filename: file.filename,
        content_type: contentType,
        size: buffer.length,
        uploaded_at: file.uploadDate,
      };
    },
    streamImageToTmp: async (id) => ({ path: `/tmp/${id}.png` }),
    deleteImage: async (id) => {
      const key = id instanceof ObjectId ? id.toString() : String(id);
      deletions.push(key);
      fakeBucket.delete(key);
    },
  };
});

vi.mock('../src/config.js', async () => {
  const real = await vi.importActual('../src/config.js');
  return {
    ...real,
    config: {
      ...real.config,
      gemini: { apiKey: 'fake-key', vertex: { project: null, location: null } },
      discord: { ...real.config.discord, movieChannelId: 'cX' },
    },
  };
});

const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const Images = await import('../src/mongo/images.js');
const { HANDLERS } = await import('../src/agent/handlers.js');

// Helper: place an "existing" image in the fake bucket, then attach its
// metadata to the named character (mirroring what generate_image would have
// done previously).
async function seedBeatWithImage(beatName, { setAsMain = true } = {}) {
  const b = await Plots.createBeat({ name: beatName, desc: 'd' });
  const file = await Images.uploadGeneratedImage({
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]),
    contentType: 'image/png',
    prompt: 'seed-beat',
    generatedBy: 'seed',
    ownerType: 'beat',
    ownerId: b._id,
  });
  await Plots.pushBeatImage(
    b._id.toString(),
    {
      _id: file._id,
      filename: file.filename,
      content_type: file.content_type,
      size: file.size,
      source: 'generated',
      caption: null,
      uploaded_at: file.uploaded_at,
    },
    setAsMain,
  );
  uploads.length = 0;
  deletions.length = 0;
  geminiCalls.length = 0;
  return { beat: b, imageId: file._id };
}

async function seedLibraryImage() {
  const file = await Images.uploadGeneratedImage({
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x03]),
    contentType: 'image/png',
    prompt: 'seed-library',
    generatedBy: 'seed',
    ownerType: null,
    ownerId: null,
  });
  uploads.length = 0;
  deletions.length = 0;
  geminiCalls.length = 0;
  return { imageId: file._id };
}

async function seedCharacterWithImage(name, { setAsMain = true } = {}) {
  const c = await Characters.createCharacter({ name });
  const file = await Images.uploadGeneratedImage({
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]),
    contentType: 'image/png',
    prompt: 'seed',
    generatedBy: 'seed',
    ownerType: 'character',
    ownerId: c._id,
  });
  await Characters.pushCharacterImage(
    c._id.toString(),
    {
      _id: file._id,
      filename: file.filename,
      content_type: file.content_type,
      size: file.size,
      uploaded_at: file.uploaded_at,
      caption: null,
    },
    setAsMain,
  );
  // Clear capture buffers so tests assert only on the edit, not the seeding.
  uploads.length = 0;
  deletions.length = 0;
  geminiCalls.length = 0;
  return { character: c, imageId: file._id };
}

beforeEach(() => {
  fakeDb.reset();
  fakeBucket.clear();
  uploads.length = 0;
  deletions.length = 0;
  geminiCalls.length = 0;
});

describe('edit_image', () => {
  it('edits a character\'s main image and replaces main_image_id, keeping the source by default', async () => {
    const { character, imageId } = await seedCharacterWithImage('Steady Clarke');

    const out = await HANDLERS.edit_image({
      source_image_id: imageId.toString(),
      prompt: 'give him blonde hair',
      replace_source: false,
    });

    // Sentinel return shape lets the loop attach the file + emit a clickable link
    expect(out).toMatch(/^__IMAGE_PATH__:/);
    expect(out).toMatch(/Edited image/);

    // Gemini saw the source image as inputImage
    expect(geminiCalls).toHaveLength(1);
    expect(geminiCalls[0].inputImage).toBeDefined();
    expect(geminiCalls[0].inputImage.contentType).toBe('image/png');
    expect(Buffer.isBuffer(geminiCalls[0].inputImage.buffer)).toBe(true);
    expect(geminiCalls[0].prompt).toContain('blonde hair');

    // Result was uploaded as a character-owned image
    expect(uploads).toHaveLength(1);
    expect(uploads[0].ownerType).toBe('character');
    expect(uploads[0].ownerId.equals(character._id)).toBe(true);

    // Character now has both images, with the new one as main
    const updated = await fakeDb.collection('characters').findOne({ _id: character._id });
    expect(updated.images).toHaveLength(2);
    expect(updated.main_image_id.equals(uploads[0]._id)).toBe(true);
    expect(updated.images.some((i) => i._id.equals(imageId))).toBe(true);

    // Source kept (replace_source: false)
    expect(deletions).toHaveLength(0);
  });

  it('with replace_source: true, removes the original from the character and bucket', async () => {
    const { character, imageId } = await seedCharacterWithImage('Steady Clarke');

    await HANDLERS.edit_image({
      source_image_id: imageId.toString(),
      prompt: 'give him blonde hair',
      replace_source: true,
    });

    const updated = await fakeDb.collection('characters').findOne({ _id: character._id });
    expect(updated.images).toHaveLength(1);
    expect(updated.images[0]._id.equals(uploads[0]._id)).toBe(true);
    expect(updated.main_image_id.equals(uploads[0]._id)).toBe(true);
    expect(deletions).toContain(imageId.toString());
    expect(fakeBucket.has(imageId.toString())).toBe(false);
  });

  it('editing a non-main character image leaves main_image_id alone', async () => {
    // Seed a character with a main image first, then add a second image (non-main)
    const c = await Characters.createCharacter({ name: 'Foxglove' });
    const fileA = await Images.uploadGeneratedImage({
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xa]),
      contentType: 'image/png',
      ownerType: 'character',
      ownerId: c._id,
    });
    await Characters.pushCharacterImage(
      c._id.toString(),
      { _id: fileA._id, filename: fileA.filename, content_type: 'image/png', size: 5, uploaded_at: new Date(), caption: null },
      true,
    );
    const fileB = await Images.uploadGeneratedImage({
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xb]),
      contentType: 'image/png',
      ownerType: 'character',
      ownerId: c._id,
    });
    await Characters.pushCharacterImage(
      c._id.toString(),
      { _id: fileB._id, filename: fileB.filename, content_type: 'image/png', size: 5, uploaded_at: new Date(), caption: null },
      false,
    );
    uploads.length = 0;
    deletions.length = 0;
    geminiCalls.length = 0;

    await HANDLERS.edit_image({
      source_image_id: fileB._id.toString(),
      prompt: 'add a hat',
      replace_source: false,
    });

    const updated = await fakeDb.collection('characters').findOne({ _id: c._id });
    expect(updated.images).toHaveLength(3);
    expect(updated.main_image_id.equals(fileA._id)).toBe(true);
  });

  it('edits a beat image and updates main_image_id when the source was beat main', async () => {
    const { beat, imageId } = await seedBeatWithImage('Diner Showdown');

    const out = await HANDLERS.edit_image({
      source_image_id: imageId.toString(),
      prompt: 'add neon signage',
      replace_source: false,
    });

    expect(out).toMatch(/attached to beat "Diner Showdown"/);
    expect(uploads[0].ownerType).toBe('beat');
    expect(uploads[0].ownerId.equals(beat._id)).toBe(true);

    const plot = await Plots.getPlot();
    const updated = plot.beats.find((b) => b._id.equals(beat._id));
    expect(updated.images).toHaveLength(2);
    expect(updated.main_image_id.equals(uploads[0]._id)).toBe(true);
  });

  it('edits a beat image with replace_source: true, removing the original', async () => {
    const { beat, imageId } = await seedBeatWithImage('Rooftop');

    await HANDLERS.edit_image({
      source_image_id: imageId.toString(),
      prompt: 'add rain',
      replace_source: true,
    });

    const plot = await Plots.getPlot();
    const updated = plot.beats.find((b) => b._id.equals(beat._id));
    expect(updated.images).toHaveLength(1);
    expect(updated.main_image_id.equals(uploads[0]._id)).toBe(true);
    expect(deletions).toContain(imageId.toString());
  });

  it('edits a library image with no overrides and keeps it in the library', async () => {
    const { imageId } = await seedLibraryImage();

    const out = await HANDLERS.edit_image({
      source_image_id: imageId.toString(),
      prompt: 'desaturate',
      replace_source: false,
    });

    expect(out).toMatch(/saved to library/);
    expect(uploads[0].ownerType).toBe(null);
    expect(uploads[0].ownerId).toBe(null);
  });

  it('edits a library image with attach_to_character override, attaching the result to the character', async () => {
    const c = await Characters.createCharacter({ name: 'Marsh Wren' });
    const { imageId } = await seedLibraryImage();

    const out = await HANDLERS.edit_image({
      source_image_id: imageId.toString(),
      prompt: 'tighter framing',
      replace_source: false,
      attach_to_character: 'Marsh Wren',
    });

    expect(out).toMatch(/attached to character "Marsh Wren"/);
    expect(uploads[0].ownerType).toBe('character');
    expect(uploads[0].ownerId.equals(c._id)).toBe(true);
    const updated = await fakeDb.collection('characters').findOne({ _id: c._id });
    expect(updated.images).toHaveLength(1);
  });

  it('cross-owner override + replace_source: true puts result on new owner and removes source from original', async () => {
    const { character, imageId } = await seedCharacterWithImage('Old Bramble');
    const beat = await Plots.createBeat({ name: 'Cathedral', desc: 'dusk' });
    uploads.length = 0;
    deletions.length = 0;

    const out = await HANDLERS.edit_image({
      source_image_id: imageId.toString(),
      prompt: 'pull back to a wide shot',
      replace_source: true,
      attach_to_beat: 'Cathedral',
    });

    expect(out).toMatch(/attached to beat "Cathedral"/);
    expect(uploads[0].ownerType).toBe('beat');
    expect(uploads[0].ownerId.equals(beat._id)).toBe(true);

    const updatedChar = await fakeDb.collection('characters').findOne({ _id: character._id });
    expect(updatedChar.images).toHaveLength(0);
    expect(updatedChar.main_image_id).toBeFalsy();

    const plot = await Plots.getPlot();
    const updatedBeat = plot.beats.find((b) => b._id.equals(beat._id));
    expect(updatedBeat.images).toHaveLength(1);
    expect(deletions).toContain(imageId.toString());
  });

  it('returns an error when replace_source is missing', async () => {
    const { imageId } = await seedCharacterWithImage('Quiet Hawthorn');
    const out = await HANDLERS.edit_image({
      source_image_id: imageId.toString(),
      prompt: 'darker mood',
    });
    expect(out).toMatch(/replace_source is required/);
    expect(geminiCalls).toHaveLength(0);
    expect(uploads).toHaveLength(0);
  });

  it('returns an error when both attach_to_character and attach_to_beat are set', async () => {
    const { imageId } = await seedCharacterWithImage('Twin Peaks');
    await Plots.createBeat({ name: 'Diner', desc: 'd' });
    const out = await HANDLERS.edit_image({
      source_image_id: imageId.toString(),
      prompt: 'x',
      replace_source: false,
      attach_to_character: 'Twin Peaks',
      attach_to_beat: 'Diner',
    });
    expect(out).toMatch(/at most one of attach_to_character or attach_to_beat/);
    expect(geminiCalls).toHaveLength(0);
  });

  it('returns an error when the source image is not found', async () => {
    const fakeId = new ObjectId().toString();
    const out = await HANDLERS.edit_image({
      source_image_id: fakeId,
      prompt: 'x',
      replace_source: false,
    });
    expect(out).toMatch(/source image not found/);
    expect(geminiCalls).toHaveLength(0);
  });

  it('returns an error when source content_type is unsupported', async () => {
    const c = await Characters.createCharacter({ name: 'Tinkerbell' });
    const file = await Images.uploadGeneratedImage({
      buffer: Buffer.from([0x00, 0x01]),
      contentType: 'image/gif',
      ownerType: 'character',
      ownerId: c._id,
    });
    uploads.length = 0;

    const out = await HANDLERS.edit_image({
      source_image_id: file._id.toString(),
      prompt: 'x',
      replace_source: false,
    });
    expect(out).toMatch(/unsupported source type/);
    expect(geminiCalls).toHaveLength(0);
  });
});
