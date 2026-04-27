import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { HANDLERS } = await import('../src/agent/handlers.js');
const Characters = await import('../src/mongo/characters.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('similarity post-hook on create_character', () => {
  it('appends a heads-up when a near-duplicate exists', async () => {
    await Characters.createCharacter({
      name: 'Marcus',
      plays_self: true,
      own_voice: true,
      fields: {
        background_story:
          'A grizzled warrior who lost his family in a tragic fire and seeks vengeance through battle',
      },
    });
    const out = await HANDLERS.create_character({
      name: 'Brutus',
      plays_self: true,
      own_voice: true,
      fields: {
        background_story:
          'A grizzled warrior who lost his family in a tragic fire and seeks vengeance',
      },
    });
    expect(out).toMatch(/Created character Brutus/);
    expect(out).toMatch(/Heads up/);
    expect(out).toMatch(/similar to "Marcus"/);
  });

  it('does not append a heads-up when corpus is empty', async () => {
    const out = await HANDLERS.create_character({
      name: 'Solo',
      plays_self: true,
      own_voice: true,
      fields: { background_story: 'a lone wanderer' },
    });
    expect(out).toMatch(/Created character Solo/);
    expect(out).not.toMatch(/Heads up/);
  });

  it('does not append when no match crosses the threshold', async () => {
    await Characters.createCharacter({
      name: 'Marcus',
      plays_self: true,
      own_voice: true,
      fields: { background_story: 'a baker in a quiet village who loves bread' },
    });
    const out = await HANDLERS.create_character({
      name: 'Pyro',
      plays_self: true,
      own_voice: true,
      fields: { background_story: 'a fire mage from the mountains seeking ancient runes' },
    });
    expect(out).toMatch(/Created character Pyro/);
    expect(out).not.toMatch(/Heads up/);
  });
});

describe('similarity post-hook on update_character', () => {
  it('runs when patch.fields is provided', async () => {
    await Characters.createCharacter({
      name: 'Marcus',
      plays_self: true,
      own_voice: true,
      fields: {
        background_story:
          'A grizzled warrior who lost his family in a tragic fire and seeks vengeance',
      },
    });
    await Characters.createCharacter({
      name: 'Bland',
      plays_self: true,
      own_voice: true,
      fields: { background_story: 'no specific story yet' },
    });
    const out = await HANDLERS.update_character({
      identifier: 'Bland',
      patch: {
        fields: {
          background_story:
            'A grizzled warrior who lost his family in a tragic fire and now seeks vengeance',
        },
      },
    });
    expect(out).toMatch(/Updated Bland/);
    expect(out).toMatch(/Heads up/);
    expect(out).toMatch(/similar to "Marcus"/);
  });

  it('skips the hook when patch only changes casting (no text)', async () => {
    await Characters.createCharacter({
      name: 'Twin1',
      plays_self: true,
      own_voice: true,
      fields: { background_story: 'a duplicate story shared between twins exactly' },
    });
    await Characters.createCharacter({
      name: 'Twin2',
      plays_self: true,
      own_voice: true,
      fields: { background_story: 'a duplicate story shared between twins exactly' },
    });
    const out = await HANDLERS.update_character({
      identifier: 'Twin2',
      patch: { plays_self: false, hollywood_actor: 'Ada Lovelace' },
    });
    expect(out).toMatch(/Updated Twin2/);
    expect(out).not.toMatch(/Heads up/);
  });
});

describe('similarity post-hook on create_beat', () => {
  it('appends a heads-up when an earlier beat is similar', async () => {
    await HANDLERS.create_beat({
      name: 'Diner Confrontation',
      desc: 'Alice argues with Bob about the past at the diner counter',
      body: 'Tense exchange across the linoleum table while coffee grows cold',
    });
    const out = await HANDLERS.create_beat({
      name: 'Coffee Argument',
      desc: 'Alice argues with Bob about the past at the diner counter',
      body: 'Tense exchange across the linoleum table while the coffee grows cold',
    });
    expect(out).toMatch(/Created beat/);
    expect(out).toMatch(/Heads up/);
    expect(out).toMatch(/similar to "#1 Diner Confrontation"/);
  });
});

describe('similarity post-hook on update_beat', () => {
  it('runs when patch touches text fields', async () => {
    const a = await HANDLERS.create_beat({
      name: 'A',
      desc: 'a forest meeting between two strangers about an old debt',
    });
    expect(a).toMatch(/Created beat/);
    const b = await HANDLERS.create_beat({ name: 'B', desc: 'a placeholder' });
    const beatBId = b.match(/_id ([a-f0-9]{24})/)[1];
    const out = await HANDLERS.update_beat({
      identifier: beatBId,
      patch: { desc: 'a forest meeting between two strangers about an old debt' },
    });
    expect(out).toMatch(/Updated beat/);
    expect(out).toMatch(/Heads up/);
  });

  it('skips the hook when patch only changes order', async () => {
    await HANDLERS.create_beat({ name: 'A', desc: 'identical phrasing seven words long here ok' });
    const b = await HANDLERS.create_beat({
      name: 'B',
      desc: 'identical phrasing seven words long here ok',
    });
    const beatBId = b.match(/_id ([a-f0-9]{24})/)[1];
    const out = await HANDLERS.update_beat({
      identifier: beatBId,
      patch: { order: 99 },
    });
    expect(out).toMatch(/Updated beat/);
    expect(out).not.toMatch(/Heads up/);
  });
});
