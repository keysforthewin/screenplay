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
  uploadGeneratedImage: async ({ buffer, contentType, prompt, ownerType, ownerId, filename }) => {
    const _id = new ObjectId();
    uploadedImages.push({ _id, buffer, contentType, prompt, ownerType, ownerId, filename });
    return {
      _id,
      filename,
      content_type: contentType,
      size: buffer.length,
      uploaded_at: new Date(),
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
  // Force the OPENAI_API_KEY check to pass by directly mutating config.
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

    let receivedPrompt = null;
    let receivedSize = null;
    let receivedQuality = null;
    Sheet._setGeneratorForTests(async ({ prompt, size, quality }) => {
      receivedPrompt = prompt;
      receivedSize = size;
      receivedQuality = quality;
      return { buffer: TINY_PNG, contentType: 'image/png', model: 'gpt-image-2', latencyMs: 12 };
    });

    const result = await Sheet.generateCharacterSheetForCharacter({
      characterId: c._id.toString(),
      quality: 'low',
    });

    // Prompt must include the production preamble, the filled fields, and the
    // fixed REQUIRED VIEWS block.
    expect(receivedPrompt).toContain('UE5 MetaHuman');
    expect(receivedPrompt).toContain('CHARACTER TYPE:\nhuman');
    expect(receivedPrompt).toContain('OUTFIT / ARMOR:\nleather jacket, distressed denim');
    expect(receivedPrompt).toContain('REQUIRED VIEWS:');
    expect(receivedPrompt).toContain('CHARACTER NAME: Rae');
    expect(receivedSize).toBe('1536x1024');
    expect(receivedQuality).toBe('low');

    // Upload happened with the right owner.
    expect(uploadedImages).toHaveLength(1);
    expect(uploadedImages[0].ownerType).toBe('character');
    expect(String(uploadedImages[0].ownerId)).toBe(c._id.toString());

    // character_sheet_image_id is set on the character.
    const updated = await Characters.getCharacter(c._id.toString());
    expect(updated.character_sheet_image_id).toBeDefined();
    expect(updated.character_sheet_image_id.toString()).toBe(result.image_id);

    // No prior sheet to delete.
    expect(deletedImages).toEqual([]);
  });

  it('deletes the previous sheet image on regeneration', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });

    // Pre-seed a previous sheet image id.
    const previousId = new ObjectId();
    await Characters.updateCharacter(c._id.toString(), {
      character_sheet_image_id: previousId.toString(),
    });

    Sheet._setGeneratorForTests(async () => ({
      buffer: TINY_PNG,
      contentType: 'image/png',
      model: 'gpt-image-2',
      latencyMs: 5,
    }));

    const result = await Sheet.generateCharacterSheetForCharacter({
      characterId: c._id.toString(),
      quality: 'auto',
    });

    expect(deletedImages).toEqual([previousId.toString()]);

    const updated = await Characters.getCharacter(c._id.toString());
    expect(updated.character_sheet_image_id.toString()).toBe(result.image_id);
    expect(updated.character_sheet_image_id.toString()).not.toBe(previousId.toString());
  });

  it('throws status=404 when the character does not exist', async () => {
    Sheet._setGeneratorForTests(async () => ({
      buffer: TINY_PNG,
      contentType: 'image/png',
      model: 'gpt-image-2',
    }));
    let err;
    try {
      await Sheet.generateCharacterSheetForCharacter({
        characterId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        quality: 'auto',
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.status).toBe(404);
  });
});
