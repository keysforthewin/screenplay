import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { seedDefaults } = await import('../src/seed/defaults.js');
const { getCharacterTemplate, updateCharacterTemplateFields } = await import('../src/mongo/prompts.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('seedDefaults', () => {
  it('seeds the full character template on a fresh DB, including alternate_names and name_changes', async () => {
    await seedDefaults();
    const tpl = await getCharacterTemplate();
    const names = tpl.fields.map((f) => f.name);
    expect(names).toContain('alternate_names');
    expect(names).toContain('name_changes');
    const alt = tpl.fields.find((f) => f.name === 'alternate_names');
    expect(alt.core).toBe(false);
    expect(alt.required).toBe(false);
    expect(alt.description).toMatch(/array of strings/i);
    const nc = tpl.fields.find((f) => f.name === 'name_changes');
    expect(nc.core).toBe(false);
    expect(nc.description).toMatch(/changed_on/);
  });

  it('does not duplicate fields when called twice', async () => {
    await seedDefaults();
    await seedDefaults();
    const tpl = await getCharacterTemplate();
    const names = tpl.fields.map((f) => f.name);
    const dedup = new Set(names);
    expect(names.length).toBe(dedup.size);
  });

  it('backfills new optional fields onto a pre-existing template that lacks them', async () => {
    // Simulate an existing deployment seeded BEFORE alternate_names / name_changes were added.
    await fakeDb.collection('prompts').insertOne({
      _id: 'character_template',
      fields: [
        { name: 'name', description: 'x', required: true, core: true },
        { name: 'plays_self', description: 'x', required: false, core: true },
        { name: 'hollywood_actor', description: 'x', required: false, core: true },
        { name: 'own_voice', description: 'x', required: false, core: true },
        { name: 'background_story', description: 'x', required: false, core: false },
      ],
      updated_at: new Date(),
    });

    await seedDefaults();

    const tpl = await getCharacterTemplate();
    const names = tpl.fields.map((f) => f.name);
    expect(names).toContain('alternate_names');
    expect(names).toContain('name_changes');
    expect(names).toContain('background_story'); // existing field preserved
  });

  it('preserves user-added custom template fields across re-seeds', async () => {
    await seedDefaults();
    await updateCharacterTemplateFields({
      add: [{ name: 'favorite_color', description: 'fav color', required: false }],
    });
    await seedDefaults();
    const tpl = await getCharacterTemplate();
    const names = tpl.fields.map((f) => f.name);
    expect(names).toContain('favorite_color');
    expect(names).toContain('alternate_names');
  });
});
