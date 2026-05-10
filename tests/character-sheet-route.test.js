import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

// 1×1 transparent PNG.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

// Track GridFS-style operations in this fake.
const uploadedImages = [];
const deletedImages = [];

vi.mock('../src/mongo/images.js', () => ({
  uploadGeneratedImage: async ({ buffer, contentType, prompt, ownerType, ownerId, filename, name }) => {
    const _id = new ObjectId();
    uploadedImages.push({ _id, buffer, contentType, prompt, ownerType, ownerId, filename, name });
    return {
      _id,
      filename,
      content_type: contentType,
      size: buffer.length,
      uploaded_at: new Date(),
      metadata: { name: name || '' },
    };
  },
  deleteImage: async (id) => {
    deletedImages.push(id?.toString?.() || String(id));
  },
  readImageBuffer: async () => null,
}));

const Characters = await import('../src/mongo/characters.js');
const Sheet = await import('../src/web/characterSheet.js');

beforeEach(() => {
  fakeDb.reset();
  uploadedImages.length = 0;
  deletedImages.length = 0;
  Sheet._resetGeneratorForTests();
});

// Stub config.openai.apiKey for the route.
vi.mock('../src/config.js', async () => {
  const real = await vi.importActual('../src/config.js');
  return {
    ...real,
    config: {
      ...real.config,
      openai: { apiKey: 'test-openai-key' },
    },
  };
});

describe('generateCharacterSheetForCharacter', () => {
  it('builds a prompt from specifics, uploads the result, and updates the character', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    await Characters.updateCharacter(c._id.toString(), {
      specifics: {
        character_type: 'human',
        age: 'early 30s',
        outfit_armor: 'leather jacket, distressed denim',
      },
    });

    let received = null;
    Sheet._setGeneratorForTests(async (args) => {
      received = args;
      return {
        buffer: TINY_PNG,
        contentType: 'image/png',
        model: 'gemini-2.5-flash-image',
        latencyMs: 12,
        usedInputImage: false,
      };
    });

    const result = await Sheet.generateCharacterSheetForCharacter({
      characterId: c._id.toString(),
      quality: 'low',
      model: 'gemini',
    });

    // Prompt must include the production preamble, the filled fields, and the
    // fixed REQUIRED VIEWS block.
    expect(received.prompt).toContain('UE5 MetaHuman');
    expect(received.prompt).toContain('CHARACTER TYPE:\nhuman');
    expect(received.prompt).toContain('OUTFIT / ARMOR:\nleather jacket, distressed denim');
    expect(received.prompt).toContain('REQUIRED VIEWS:');
    expect(received.prompt).toContain('CHARACTER NAME: Rae');
    expect(received.quality).toBe('low');
    expect(received.model).toBe('gemini');
    expect(received.omitImages).toBe(false);
    // No main_image_id on this character → null is forwarded to the dispatcher.
    expect(received.mainImageId).toBeNull();

    // Upload happened with the right owner.
    expect(uploadedImages).toHaveLength(1);
    expect(uploadedImages[0].ownerType).toBe('character');
    expect(String(uploadedImages[0].ownerId)).toBe(c._id.toString());

    // character_sheet_image_ids is set on the character.
    const updated = await Characters.getCharacter(c._id.toString());
    expect(Array.isArray(updated.character_sheet_image_ids)).toBe(true);
    expect(updated.character_sheet_image_ids).toHaveLength(1);
    expect(updated.character_sheet_image_ids[0].toString()).toBe(result.image_id);

    // Returned model echoes what the dispatcher reported.
    expect(result.model).toBe('gemini-2.5-flash-image');
    expect(result.used_input_image).toBe(false);
    // Default sheet name: "Sheet 1" since the character had no prior sheets.
    expect(result.sheet_name).toBe('Sheet 1');

    // Append-only: no prior sheet to delete.
    expect(deletedImages).toEqual([]);
  });

  it('forwards mainImageId and omitImages from the character to the dispatcher', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const portrait = new ObjectId();
    // updateCharacter doesn't accept main_image_id as a patch field — it's
    // managed by attachImageToCharacter etc. — so write it directly via the
    // fake collection.
    await fakeDb
      .collection('characters')
      .updateOne({ _id: c._id }, { $set: { main_image_id: portrait } });

    let received = null;
    Sheet._setGeneratorForTests(async (args) => {
      received = args;
      return {
        buffer: TINY_PNG,
        contentType: 'image/png',
        model: 'gemini-2.5-flash-image',
        latencyMs: 1,
        usedInputImage: true,
      };
    });

    await Sheet.generateCharacterSheetForCharacter({
      characterId: c._id.toString(),
      quality: 'auto',
      model: 'gemini',
      omitImages: false,
    });

    expect(received.mainImageId.toString()).toBe(portrait.toString());
    expect(received.omitImages).toBe(false);
  });

  it('passes omitImages=true through when the user opts out of the main image', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const portrait = new ObjectId();
    await fakeDb
      .collection('characters')
      .updateOne({ _id: c._id }, { $set: { main_image_id: portrait } });

    let received = null;
    Sheet._setGeneratorForTests(async (args) => {
      received = args;
      return {
        buffer: TINY_PNG,
        contentType: 'image/png',
        model: 'gpt-image-2',
        latencyMs: 1,
        usedInputImage: false,
      };
    });

    const result = await Sheet.generateCharacterSheetForCharacter({
      characterId: c._id.toString(),
      quality: 'high',
      model: 'openai',
      omitImages: true,
    });

    expect(received.omitImages).toBe(true);
    expect(received.model).toBe('openai');
    expect(result.used_input_image).toBe(false);
  });

  it('appends to character_sheet_image_ids instead of replacing on regeneration', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });

    // Pre-seed a previous sheet via the legacy scalar; the backfill in
    // getCharacter promotes it into the array view.
    const previousId = new ObjectId();
    await fakeDb
      .collection('characters')
      .updateOne({ _id: c._id }, { $set: { character_sheet_image_id: previousId } });

    Sheet._setGeneratorForTests(async () => ({
      buffer: TINY_PNG,
      contentType: 'image/png',
      model: 'gemini-2.5-flash-image',
      latencyMs: 5,
      usedInputImage: false,
    }));

    const result = await Sheet.generateCharacterSheetForCharacter({
      characterId: c._id.toString(),
      quality: 'auto',
      model: 'gemini',
      sheetName: 'Variant',
    });

    // Old sheet bytes are NOT deleted; we now keep history.
    expect(deletedImages).toEqual([]);

    const updated = await Characters.getCharacter(c._id.toString());
    const ids = updated.character_sheet_image_ids.map((x) => x.toString());
    expect(ids).toContain(previousId.toString());
    expect(ids).toContain(result.image_id);
    expect(result.sheet_name).toBe('Variant');
  });

  it('honors customPrompt — skipping buildCharacterSheetPrompt', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });

    let received = null;
    Sheet._setGeneratorForTests(async (args) => {
      received = args;
      return {
        buffer: TINY_PNG,
        contentType: 'image/png',
        model: 'gemini-2.5-flash-image',
        latencyMs: 1,
        usedInputImage: false,
      };
    });

    await Sheet.generateCharacterSheetForCharacter({
      characterId: c._id.toString(),
      quality: 'auto',
      model: 'gemini',
      customPrompt: 'a young version of Rae, age 12, school uniform',
    });

    expect(received.prompt).toBe('a young version of Rae, age 12, school uniform');
    expect(received.prompt).not.toContain('UE5 MetaHuman');
  });

  it('rejects reference_image_ids that are not attached to the character', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    Sheet._setGeneratorForTests(async () => ({
      buffer: TINY_PNG,
      contentType: 'image/png',
      model: 'gemini-2.5-flash-image',
      latencyMs: 1,
      usedInputImage: false,
    }));

    const stranger = new ObjectId();
    await expect(
      Sheet.generateCharacterSheetForCharacter({
        characterId: c._id.toString(),
        quality: 'auto',
        model: 'gemini',
        referenceImageIds: [stranger.toString()],
      }),
    ).rejects.toThrow(/not attached to this character/);
  });

  it('forwards validated reference_image_ids to the dispatcher', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const portraitA = new ObjectId();
    const portraitB = new ObjectId();
    await fakeDb.collection('characters').updateOne(
      { _id: c._id },
      {
        $set: {
          images: [
            { _id: portraitA, filename: 'a.png', content_type: 'image/png', size: 1, uploaded_at: new Date() },
            { _id: portraitB, filename: 'b.png', content_type: 'image/png', size: 1, uploaded_at: new Date() },
          ],
          main_image_id: portraitA,
        },
      },
    );

    let received = null;
    Sheet._setGeneratorForTests(async (args) => {
      received = args;
      return {
        buffer: TINY_PNG,
        contentType: 'image/png',
        model: 'gemini-2.5-flash-image',
        latencyMs: 1,
        usedInputImage: true,
        inputImageCount: 2,
      };
    });

    await Sheet.generateCharacterSheetForCharacter({
      characterId: c._id.toString(),
      quality: 'auto',
      model: 'gemini',
      referenceImageIds: [portraitA.toString(), portraitB.toString()],
    });

    expect(received.referenceImageIds).toEqual([portraitA.toString(), portraitB.toString()]);
  });

  it('throws status=404 when the character does not exist', async () => {
    Sheet._setGeneratorForTests(async () => ({
      buffer: TINY_PNG,
      contentType: 'image/png',
      model: 'gemini-2.5-flash-image',
      usedInputImage: false,
    }));
    let err;
    try {
      await Sheet.generateCharacterSheetForCharacter({
        characterId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        quality: 'auto',
        model: 'gemini',
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.status).toBe(404);
  });
});
