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

const Plots = await import('../src/mongo/plots.js');
const Autofill = await import('../src/web/beatSpecificsAutofill.js');

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

describe('autofillBeatSpecifics', () => {
  it('writes only fields that are currently empty', async () => {
    const b = await Plots.createBeat({
      name: 'Diner Showdown',
      desc: 'Alice argues with Bob in a 1970s desert diner at dusk.',
      body: 'The diner is empty except for the clerk.',
    });
    await Plots.updateBeat(b._id.toString(), {
      'specifics.scene_type': 'interior', // pre-filled
    });

    mockAnthropicReturning({
      scene_type: 'exterior', // SKIPPED — already filled
      time_period: 'dusk',
      set_dressing: 'red vinyl booths, neon sign',
      asymmetrical_details: '', // empty, skip
    });

    const result = await Autofill.autofillBeatSpecifics({ beatId: b._id.toString() });

    expect(result.filled.sort()).toEqual(['set_dressing', 'time_period']);

    const updated = await Plots.getBeat(b._id.toString());
    expect(updated.specifics.scene_type).toBe('interior'); // not overwritten
    expect(updated.specifics.time_period).toBe('dusk');
    expect(updated.specifics.set_dressing).toBe('red vinyl booths, neon sign');
    expect(updated.specifics.asymmetrical_details).toBeUndefined();
  });

  it('passes beat name + desc + body as text context to the model', async () => {
    const b = await Plots.createBeat({
      name: 'Diner Showdown',
      desc: 'Alice argues with Bob.',
      body: 'The booths are vinyl. The jukebox plays a slow song.',
    });
    mockAnthropicReturning({});

    await Autofill.autofillBeatSpecifics({ beatId: b._id.toString() });

    expect(lastAnthropicArgs).toBeDefined();
    const userBlocks = lastAnthropicArgs.messages[0].content;
    const textBlock = userBlocks.find((bb) => bb.type === 'text');
    expect(textBlock).toBeDefined();
    expect(textBlock.text).toContain('Diner Showdown');
    expect(textBlock.text).toContain('Alice argues with Bob.');
    expect(textBlock.text).toContain('The booths are vinyl');
  });

  it('works text-only when the beat has no images', async () => {
    const b = await Plots.createBeat({
      name: 'Diner',
      desc: 'A 1970s desert diner.',
      body: 'Long body about the scene.',
    });
    mockAnthropicReturning({ scene_type: 'interior' });

    const result = await Autofill.autofillBeatSpecifics({ beatId: b._id.toString() });

    expect(result.filled).toEqual(['scene_type']);
    // Only the text block — no image blocks since beat has no images.
    const userBlocks = lastAnthropicArgs.messages[0].content;
    expect(userBlocks.filter((bb) => bb.type === 'image')).toHaveLength(0);
  });

  it('returns no_context when both text and images are missing', async () => {
    const b = await Plots.createBeat({ name: 'Diner', desc: 'd' });
    // Clear all text fields and images via Mongo to simulate a stripped beat.
    await fakeDb.collection('plots').updateOne(
      { _id: 'main' },
      { $set: { 'beats.0.name': '', 'beats.0.desc': '', 'beats.0.body': '', 'beats.0.images': [] } },
    );
    mockAnthropicReturning({ scene_type: 'interior' });

    const result = await Autofill.autofillBeatSpecifics({ beatId: b._id.toString() });

    expect(result.filled).toEqual([]);
    expect(result.reason).toBe('no_context');
    expect(lastAnthropicArgs).toBeNull();
  });

  it('forces tool_choice to fill_specifics with the BEAT specifics schema', async () => {
    const b = await Plots.createBeat({ name: 'Diner', desc: 'd', body: 'body' });
    mockAnthropicReturning({});

    await Autofill.autofillBeatSpecifics({ beatId: b._id.toString() });

    expect(lastAnthropicArgs.tool_choice).toEqual({ type: 'tool', name: 'fill_specifics' });
    const tool = lastAnthropicArgs.tools[0];
    expect(tool.name).toBe('fill_specifics');
    // Beat-specific field names must be present.
    expect(tool.input_schema.properties.scene_type).toBeDefined();
    expect(tool.input_schema.properties.set_dressing).toBeDefined();
    expect(tool.input_schema.properties.materials_atmosphere).toBeDefined();
    // Character-only field names must NOT be present.
    expect(tool.input_schema.properties.character_type).toBeUndefined();
    expect(tool.input_schema.properties.outfit_armor).toBeUndefined();
  });

  it('returns no_tool_call when the model does not invoke the tool', async () => {
    const b = await Plots.createBeat({ name: 'Diner', desc: 'd', body: 'body' });
    Autofill._setAnthropicFactoryForTests(() => ({
      messages: {
        create: async () => ({ content: [{ type: 'text', text: 'no tool call' }] }),
      },
    }));
    const result = await Autofill.autofillBeatSpecifics({ beatId: b._id.toString() });
    expect(result.filled).toEqual([]);
    expect(result.reason).toBe('no_tool_call');
  });
});
