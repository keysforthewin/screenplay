import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { createProject } = await import('../src/mongo/projects.js');
const { HANDLERS } = await import('../src/agent/handlers.js');
const Characters = await import('../src/mongo/characters.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

describe('similarity post-hook on create_character', () => {
  it('appends a heads-up when a near-duplicate exists', async () => {
    await Characters.createCharacter({ projectId,
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
    }, { projectId });
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
    }, { projectId });
    expect(out).toMatch(/Created character Solo/);
    expect(out).not.toMatch(/Heads up/);
  });

  it('does not append when no match crosses the threshold', async () => {
    await Characters.createCharacter({ projectId,
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
    }, { projectId });
    expect(out).toMatch(/Created character Pyro/);
    expect(out).not.toMatch(/Heads up/);
  });
});

describe('similarity post-hook on edit (character)', () => {
  it('runs when a custom field is edited', async () => {
    await Characters.createCharacter({ projectId,
      name: 'Marcus',
      plays_self: true,
      own_voice: true,
      fields: {
        background_story:
          'A grizzled warrior who lost his family in a tragic fire and seeks vengeance',
      },
    });
    await Characters.createCharacter({ projectId,
      name: 'Bland',
      plays_self: true,
      own_voice: true,
      fields: { background_story: 'no specific story yet' },
    });
    const out = await HANDLERS.edit({
      collection: 'character',
      identifier: 'Bland',
      field: 'fields.background_story',
      edits: [
        {
          find: '',
          replace:
            'A grizzled warrior who lost his family in a tragic fire and now seeks vengeance',
        },
      ],
    }, { projectId });
    expect(out).toMatch(/Replaced Bland\.fields\.background_story/);
    expect(out).toMatch(/Heads up/);
    expect(out).toMatch(/similar to "Marcus"/);
  });

  it('skips the hook when set_field only unsets a custom field (no text)', async () => {
    await Characters.createCharacter({ projectId,
      name: 'Twin1',
      fields: { background_story: 'a duplicate story shared between twins exactly' },
    });
    await Characters.createCharacter({ projectId,
      name: 'Twin2',
      fields: { background_story: 'a duplicate story shared between twins exactly', stale_note: 'remove me' },
    });
    const out = await HANDLERS.set_field({
      collection: 'character',
      identifier: 'Twin2',
      field: 'unset',
      value: ['stale_note'],
    }, { projectId });
    expect(out).toMatch(/Unset 1 field\(s\) on Twin2/);
    expect(out).not.toMatch(/Heads up/);
  });
});

describe('similarity post-hook on create_beat', () => {
  it('appends a heads-up when an earlier beat is similar', async () => {
    await HANDLERS.create_beat({
      name: 'Diner Confrontation',
      desc: 'Alice argues with Bob about the past at the diner counter',
      body: 'Tense exchange across the linoleum table while coffee grows cold',
    }, { projectId });
    const out = await HANDLERS.create_beat({
      name: 'Coffee Argument',
      desc: 'Alice argues with Bob about the past at the diner counter',
      body: 'Tense exchange across the linoleum table while the coffee grows cold',
    }, { projectId });
    expect(out).toMatch(/Created beat/);
    expect(out).toMatch(/Heads up/);
    expect(out).toMatch(/similar to "#1 Diner Confrontation"/);
  });
});

describe('similarity post-hook on edit (beat)', () => {
  it('runs when a text field is edited', async () => {
    const a = await HANDLERS.create_beat({
      name: 'A',
      desc: 'a forest meeting between two strangers about an old debt',
    }, { projectId });
    expect(a).toMatch(/Created beat/);
    const b = await HANDLERS.create_beat({ name: 'B', desc: 'a placeholder' }, { projectId });
    const beatBId = b.match(/_id ([a-f0-9]{24})/)[1];
    const out = await HANDLERS.edit({
      collection: 'beat',
      identifier: beatBId,
      field: 'desc',
      edits: [{ find: '', replace: 'a forest meeting between two strangers about an old debt' }],
    }, { projectId });
    expect(out).toMatch(/Replaced beat/);
    expect(out).toMatch(/Heads up/);
  });

  it('skips the hook when set_field only changes order', async () => {
    await HANDLERS.create_beat({ name: 'A', desc: 'identical phrasing seven words long here ok' }, { projectId });
    const b = await HANDLERS.create_beat({
      name: 'B',
      desc: 'identical phrasing seven words long here ok',
    }, { projectId });
    const beatBId = b.match(/_id ([a-f0-9]{24})/)[1];
    const out = await HANDLERS.set_field({
      collection: 'beat',
      identifier: beatBId,
      field: 'order',
      value: 99,
    }, { projectId });
    // value=99 is past the end; with 2 beats total, B (already order 2) clamps
    // to the last position, i.e. stays at order 2 — the handler now reports the
    // resulting position, not the requested value.
    expect(out).toMatch(/\.order = 2/);
    expect(out).not.toMatch(/Heads up/);
  });
});
