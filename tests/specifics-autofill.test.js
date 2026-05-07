import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

vi.mock('../src/mongo/images.js', () => ({
  readImageBuffer: async () => ({
    buffer: TINY_PNG,
    file: { _id: new ObjectId(), contentType: 'image/png', length: TINY_PNG.length },
  }),
}));

const Characters = await import('../src/mongo/characters.js');
const Autofill = await import('../src/web/specificsAutofill.js');

let lastAnthropicArgs = null;
function mockAnthropicReturning(toolInput) {
  lastAnthropicArgs = null;
  Autofill._setAnthropicFactoryForTests(() => ({
    messages: {
      create: async (args) => {
        lastAnthropicArgs = args;
        return {
          content: [
            { type: 'tool_use', name: 'fill_specifics', input: toolInput, id: 'toolu_test' },
          ],
        };
      },
    },
  }));
}

beforeEach(() => {
  fakeDb.reset();
  lastAnthropicArgs = null;
});

describe('autofillCharacterSpecifics', () => {
  it('writes only fields that are currently empty', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    await Characters.updateCharacter(c._id.toString(), {
      'specifics.character_type': 'human', // pre-filled by user
    });
    // Push an image so the autofill has eligible input.
    await fakeDb.collection('characters').updateOne(
      { _id: c._id },
      { $set: { images: [{ _id: new ObjectId(), content_type: 'image/png' }] } },
    );

    mockAnthropicReturning({
      character_type: 'humanoid', // should be SKIPPED — already filled
      age: 'early 30s', // should be written
      outfit_armor: 'leather jacket, distressed denim', // should be written
      asymmetrical_details: '', // empty, skip
    });

    const result = await Autofill.autofillCharacterSpecifics({
      characterId: c._id.toString(),
    });

    expect(result.filled.sort()).toEqual(['age', 'outfit_armor']);

    const updated = await Characters.getCharacter(c._id.toString());
    expect(updated.specifics.character_type).toBe('human'); // not overwritten
    expect(updated.specifics.age).toBe('early 30s');
    expect(updated.specifics.outfit_armor).toBe('leather jacket, distressed denim');
    // asymmetrical_details was empty in the model output → never written
    expect(updated.specifics.asymmetrical_details).toBeUndefined();
  });

  it('returns no_images when the character has none attached', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    mockAnthropicReturning({ age: '30s' });

    const result = await Autofill.autofillCharacterSpecifics({
      characterId: c._id.toString(),
    });

    expect(result.filled).toEqual([]);
    expect(result.reason).toBe('no_images');
    // Anthropic should NOT have been called.
    expect(lastAnthropicArgs).toBeNull();
  });

  it('forces tool_choice to fill_specifics with the SPECIFICS_FIELDS schema', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    await fakeDb.collection('characters').updateOne(
      { _id: c._id },
      { $set: { images: [{ _id: new ObjectId(), content_type: 'image/png' }] } },
    );
    mockAnthropicReturning({});

    await Autofill.autofillCharacterSpecifics({ characterId: c._id.toString() });

    expect(lastAnthropicArgs.tool_choice).toEqual({ type: 'tool', name: 'fill_specifics' });
    const tool = lastAnthropicArgs.tools[0];
    expect(tool.name).toBe('fill_specifics');
    // A few of the field names must be present in the schema.
    expect(tool.input_schema.properties.character_type).toBeDefined();
    expect(tool.input_schema.properties.outfit_armor).toBeDefined();
    expect(tool.input_schema.properties.continuity_locks).toBeDefined();
  });

  it('passes the character name + hollywood actor + custom fields as text context', async () => {
    const c = await Characters.createCharacter({
      name: 'Rae',
      hollywood_actor: 'Florence Pugh',
      fields: {
        background_story: 'Grew up on a horse ranch in Montana.',
        arc: 'From skeptic to true believer.',
      },
    });
    await fakeDb.collection('characters').updateOne(
      { _id: c._id },
      { $set: { images: [{ _id: new ObjectId(), content_type: 'image/png' }] } },
    );
    mockAnthropicReturning({});

    await Autofill.autofillCharacterSpecifics({ characterId: c._id.toString() });

    const userBlocks = lastAnthropicArgs.messages[0].content;
    const textBlock = userBlocks.find((bb) => bb.type === 'text');
    expect(textBlock).toBeDefined();
    expect(textBlock.text).toContain('Character name: Rae');
    expect(textBlock.text).toContain('Florence Pugh');
    expect(textBlock.text).toContain('background_story');
    expect(textBlock.text).toContain('horse ranch in Montana');
    expect(textBlock.text).toContain('arc');
    expect(textBlock.text).toContain('skeptic to true believer');
  });

  it('returns no_tool_call when the model does not invoke the tool', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    await fakeDb.collection('characters').updateOne(
      { _id: c._id },
      { $set: { images: [{ _id: new ObjectId(), content_type: 'image/png' }] } },
    );
    Autofill._setAnthropicFactoryForTests(() => ({
      messages: {
        create: async () => ({ content: [{ type: 'text', text: 'no tool call' }] }),
      },
    }));

    const result = await Autofill.autofillCharacterSpecifics({
      characterId: c._id.toString(),
    });
    expect(result.filled).toEqual([]);
    expect(result.reason).toBe('no_tool_call');
  });
});
