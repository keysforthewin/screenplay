import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { seedDefaults } = await import('../src/seed/defaults.js');
const { getCharacterTemplate, updateCharacterTemplateFields } = await import('../src/mongo/prompts.js');
const Projects = await import('../src/mongo/projects.js');

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
    expect(alt.description).toMatch(/comma-separated/i);
    expect(alt.description).toMatch(/do not write a json array/i);
    const nc = tpl.fields.find((f) => f.name === 'name_changes');
    expect(nc.core).toBe(false);
    expect(nc.description).toMatch(/plain english/i);
    expect(nc.description).toMatch(/do not write a json array/i);
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
    const def = await Projects.getDefaultProject();
    await fakeDb.collection('prompts').insertOne({
      _id: `${def._id.toString()}:character_template`,
      fields: [
        { name: 'name', description: 'x', required: true, core: true },
        { name: 'hollywood_actor', description: 'x', required: false, core: true },
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

  it('strips retired plays_self / own_voice fields from an existing template', async () => {
    const def = await Projects.getDefaultProject();
    await fakeDb.collection('prompts').insertOne({
      _id: `${def._id.toString()}:character_template`,
      fields: [
        { name: 'name', description: 'x', required: true, core: true },
        { name: 'plays_self', description: 'legacy', required: false, core: true },
        { name: 'hollywood_actor', description: 'x', required: false, core: true },
        { name: 'own_voice', description: 'legacy', required: false, core: true },
      ],
      updated_at: new Date(),
    });

    await seedDefaults();

    const tpl = await getCharacterTemplate();
    const names = tpl.fields.map((f) => f.name);
    expect(names).not.toContain('plays_self');
    expect(names).not.toContain('own_voice');
    expect(names).toContain('hollywood_actor');
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

describe('seedProjectDefaults', () => {
  it('seeds templates and an empty plot doc for every project on startup', async () => {
    const defaultProject = await Projects.getDefaultProject();
    const defaultId = defaultProject._id.toString();
    const p2 = (await Projects.createProject('Second'))._id.toString();
    await seedDefaults();
    const { getCharacterTemplate, getPlotTemplate } = await import('../src/mongo/prompts.js');
    // Default project
    expect(await getCharacterTemplate(defaultId)).toBeTruthy();
    expect(await getPlotTemplate(defaultId)).toBeTruthy();
    const defaultPlot = await fakeDb.collection('plots').findOne({ project_id: defaultId });
    expect(defaultPlot).toBeTruthy();
    expect(defaultPlot.beats).toEqual([]);
    // Second project
    expect(await getCharacterTemplate(p2)).toBeTruthy();
    expect(await getPlotTemplate(p2)).toBeTruthy();
    const plot = await fakeDb.collection('plots').findOne({ project_id: p2 });
    expect(plot).toBeTruthy();
    expect(plot.beats).toEqual([]);
  });
});
