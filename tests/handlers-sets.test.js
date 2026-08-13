import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

const { createProject } = await import('../src/mongo/projects.js');
const Sets = await import('../src/mongo/sets.js');
const Plots = await import('../src/mongo/plots.js');
const { HANDLERS } = await import('../src/agent/handlers.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

describe('list_sets handler', () => {
  it('returns id/name/description-preview for every set, sorted by name', async () => {
    await Sets.createSet({ projectId, name: 'The Diner', description: 'A retro roadside diner.' });
    await Sets.createSet({ projectId, name: 'Alice\'s Apartment' });

    const out = JSON.parse(await HANDLERS.list_sets({}, { projectId }));

    expect(out).toHaveLength(2);
    expect(out.map((s) => s.name)).toEqual(["Alice's Apartment", 'The Diner']);
    const diner = out.find((s) => s.name === 'The Diner');
    expect(diner.description).toContain('retro roadside diner');
    expect(typeof diner._id).toBe('string');
  });

  it('returns an empty array when no sets exist', async () => {
    const out = JSON.parse(await HANDLERS.list_sets({}, { projectId }));
    expect(out).toEqual([]);
  });
});

describe('get_set handler', () => {
  it('returns the full set document with an SPA link', async () => {
    const s = await Sets.createSet({ projectId, name: 'The Diner', description: 'Retro roadside diner.' });

    const out = await HANDLERS.get_set({ identifier: 'the diner' }, { projectId, projectTitle: 'Test Project' });

    expect(out).toMatch(/"name": "The Diner"/);
    expect(out).toMatch(/Retro roadside diner/);
    expect(out).toMatch(/Edit in browser: .*\/set\/The%20Diner/);
    expect(out).toContain(s._id.toString());
  });

  it('returns a friendly error when the set does not exist', async () => {
    const out = await HANDLERS.get_set({ identifier: 'Ghost Town' }, { projectId });
    expect(out).toMatch(/no set found/i);
  });
});

describe('create_set handler', () => {
  it('creates a set with name + description and returns an SPA link', async () => {
    const out = await HANDLERS.create_set(
      { name: 'The Diner', description: 'Retro roadside diner.' },
      { projectId, projectTitle: 'Test Project' },
    );

    expect(out).toMatch(/Created set The Diner/);
    expect(out).toMatch(/Edit in browser: .*\/set\/The%20Diner/);

    const s = await Sets.getSet(projectId, 'The Diner');
    expect(s.description).toBe('Retro roadside diner.');
  });

  it('creates a set with just a name (description optional)', async () => {
    const out = await HANDLERS.create_set({ name: 'Empty Lot' }, { projectId });
    expect(out).toMatch(/Created set Empty Lot/);
  });

  it('rejects a duplicate name (case-insensitive) via the gateway 409', async () => {
    await Sets.createSet({ projectId, name: 'The Diner' });
    await expect(
      HANDLERS.create_set({ name: 'THE DINER' }, { projectId }),
    ).rejects.toThrow(/already exists/i);
  });
});

describe('delete_set handler', () => {
  it('returns a friendly error when the set does not exist', async () => {
    const out = await HANDLERS.delete_set({ identifier: 'Ghost Town' }, { projectId });
    expect(out).toMatch(/no set found/i);
  });

  it('deletes the set and unlinks it from every beat that referenced it', async () => {
    await Sets.createSet({ projectId, name: 'The Diner' });
    await Plots.createBeat({ projectId, name: 'Open', desc: 'd', sets: ['The Diner'] });
    await Plots.createBeat({ projectId, name: 'Mid', desc: 'd', sets: ['The Diner', 'Empty Lot'] });

    const out = await HANDLERS.delete_set({ identifier: 'the diner' }, { projectId });

    expect(out).toMatch(/Deleted set "The Diner"/);
    expect(out).toMatch(/unlinked from 2 beat/i);
    expect(await Sets.getSet(projectId, 'The Diner')).toBe(null);

    const beats = await Plots.listBeats(projectId);
    expect(beats.find((b) => b.name === 'Open').sets).toEqual([]);
    expect(beats.find((b) => b.name === 'Mid').sets).toEqual(['Empty Lot']);
  });
});

describe('search_sets handler', () => {
  it('finds sets whose name or description contain the query', async () => {
    await Sets.createSet({ projectId, name: 'The Diner', description: 'A retro roadside diner.' });
    await Sets.createSet({ projectId, name: 'Empty Lot', description: 'A weedy vacant lot.' });

    const out = JSON.parse(await HANDLERS.search_sets({ query: 'diner' }, { projectId }));

    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('The Diner');
    expect(out[0].matched_fields).toContain('name');
  });

  it('returns an empty array when nothing matches', async () => {
    await Sets.createSet({ projectId, name: 'The Diner' });
    const out = JSON.parse(await HANDLERS.search_sets({ query: 'spaceship' }, { projectId }));
    expect(out).toEqual([]);
  });
});

describe('link_set_to_beat / unlink_set_from_beat handlers', () => {
  it('links a set to an explicit beat, idempotently', async () => {
    await Sets.createSet({ projectId, name: 'The Diner' });
    const beat = await Plots.createBeat({ projectId, name: 'Open', desc: 'd' });

    const out = await HANDLERS.link_set_to_beat(
      { beat: beat._id.toString(), set: 'the diner' },
      { projectId },
    );
    expect(out).toMatch(/Linked The Diner to beat "Open"/);

    const again = await HANDLERS.link_set_to_beat(
      { beat: beat._id.toString(), set: 'The Diner' },
      { projectId },
    );
    expect(again).toMatch(/Linked The Diner to beat "Open"/);

    const [updated] = await Plots.listBeats(projectId);
    expect(updated.sets).toEqual(['The Diner']);
  });

  it('returns a friendly error when the set does not exist', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Open', desc: 'd' });
    const out = await HANDLERS.link_set_to_beat(
      { beat: beat._id.toString(), set: 'Ghost Town' },
      { projectId },
    );
    expect(out).toMatch(/no set found/i);
    const [updated] = await Plots.listBeats(projectId);
    expect(updated.sets).toEqual([]);
  });

  it('defaults to the current beat when beat is omitted', async () => {
    await Sets.createSet({ projectId, name: 'The Diner' });
    const beat = await Plots.createBeat({ projectId, name: 'Open', desc: 'd' });
    await Plots.setCurrentBeat(projectId, beat._id.toString());

    const out = await HANDLERS.link_set_to_beat({ set: 'The Diner' }, { projectId });
    expect(out).toMatch(/Linked The Diner to beat "Open"/);
  });

  it('unlinks a set from a beat', async () => {
    await Sets.createSet({ projectId, name: 'The Diner' });
    const beat = await Plots.createBeat({ projectId, name: 'Open', desc: 'd', sets: ['The Diner'] });

    const out = await HANDLERS.unlink_set_from_beat(
      { beat: beat._id.toString(), set: 'The Diner' },
      { projectId },
    );
    expect(out).toMatch(/Unlinked The Diner from beat "Open"/);

    const [updated] = await Plots.listBeats(projectId);
    expect(updated.sets).toEqual([]);
  });
});

describe('edit handler on sets', () => {
  it('applies find/replace edits to a set description', async () => {
    const s = await Sets.createSet({
      projectId,
      name: 'The Diner',
      description: 'The diner is red inside.',
    });
    const out = await HANDLERS.edit(
      {
        collection: 'set',
        identifier: 'the diner',
        field: 'description',
        edits: [{ find: 'red', replace: 'teal' }],
      },
      { projectId, projectTitle: 'Test Project' },
    );
    expect(String(out)).not.toMatch(/^Tool error/);
    const fresh = await Sets.getSet(projectId, s._id.toString());
    expect(fresh.description).toBe('The diner is teal inside.');
  });

  it('rejects unknown set fields with a helpful error', async () => {
    await Sets.createSet({ projectId, name: 'The Diner' });
    await expect(
      HANDLERS.edit(
        {
          collection: 'set',
          identifier: 'the diner',
          field: 'mood',
          edits: [{ find: '', replace: 'x' }],
        },
        { projectId },
      ),
    ).rejects.toThrow(/name|description/);
  });
});
