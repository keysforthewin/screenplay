// The reference-image catalog the Prompts tab draws from: done artworks of
// the beat's characters and sets only, numbered, formatted for the planner.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/web/hocuspocus.js', () => ({
  getRoomDocument: () => null,
  withDirectDocument: vi.fn(),
  broadcastRoomStateless: vi.fn(),
  isHocuspocusRunning: () => false,
}));

// Image metadata for the catalog: name/description keyed by id.
const imageMeta = new Map();
vi.mock('../src/mongo/images.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    findImageFile: vi.fn(async (id) => {
      const m = imageMeta.get(String(id));
      if (!m) return null;
      return { _id: new ObjectId(String(id)), filename: 'x.png', contentType: 'image/png', length: 1, metadata: m };
    }),
  };
});

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Gen = await import('../src/web/referenceCatalog.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  imageMeta.clear();
  projectId = (await createProject('Test Project'))._id.toString();
});

function newImage(desc = '') {
  const id = new ObjectId();
  imageMeta.set(id.toString(), { description: desc, name: '' });
  return id;
}

async function seedBeatWithRefs() {
  // Only ARTWORK is catalogued: the uploaded sheet/portrait/main images below
  // must never appear.
  const uploadedSheet = newImage('Sarah full-body turnaround (uploaded sheet)');
  const uploadedPortrait = newImage('Sarah close portrait (uploaded)');
  const uploadedSetMain = newImage('Diner interior (uploaded main)');
  const sheet = newImage('Sarah full-body turnaround, red coat');
  const portrait = newImage('Sarah close portrait');
  const setMain = newImage('Diner interior, chrome counter, neon');
  const artworkId = newImage('Diner exterior at night');
  await fakeDb.collection('characters').insertOne({
    _id: new ObjectId(),
    project_id: projectId,
    name: 'Sarah',
    name_lower: 'sarah',
    character_sheet_image_ids: [uploadedSheet],
    main_image_id: uploadedPortrait,
    images: [{ _id: uploadedPortrait, caption: 'portrait' }],
    artworks: [
      { _id: new ObjectId(), status: 'done', result_image_id: sheet, name: 'Turnaround', description: '' },
      { _id: new ObjectId(), status: 'done', result_image_id: portrait, name: 'Close', description: '' },
      { _id: new ObjectId(), status: 'error', result_image_id: null },
    ],
    fields: {},
    created_at: new Date(),
    updated_at: new Date(),
  });
  await fakeDb.collection('sets').insertOne({
    _id: new ObjectId(),
    project_id: projectId,
    name: 'Diner',
    name_lower: 'diner',
    description: 'A roadside diner.',
    main_image_id: uploadedSetMain,
    images: [{ _id: uploadedSetMain, caption: '' }],
    artworks: [
      { _id: new ObjectId(), status: 'done', result_image_id: setMain, name: 'Interior plate', description: '' },
      { _id: new ObjectId(), status: 'done', result_image_id: artworkId, name: 'Night plate', description: 'Diner exterior at night' },
      { _id: new ObjectId(), status: 'pending', result_image_id: null },
    ],
    created_at: new Date(),
    updated_at: new Date(),
  });
  const beat = await Plots.createBeat({
    projectId,
    name: 'Arrival',
    desc: 'Sarah walks into the diner.',
    body: 'Sarah pushes the door open. The bell rings. Everyone looks up.',
    characters: ['Sarah'],
    sets: ['Diner'],
  });
  return { beat, sheet, portrait, setMain, artworkId };
}

describe('buildReferenceCatalog', () => {
  it('with setUploads, offers a set\'s uploaded photos first (main image leading), tagged SET PHOTO; characters\' uploads stay out', async () => {
    const { beat } = await seedBeatWithRefs();
    const second = newImage('Diner facade (uploaded)');
    const diner = await fakeDb.collection('sets').findOne({ name_lower: 'diner' });
    await fakeDb.collection('sets').updateOne({ _id: diner._id }, { $push: { images: { _id: second, caption: 'facade, daylight' } } });
    const plain = await Gen.buildReferenceCatalog(projectId, beat);
    expect(plain.some((e) => e.upload)).toBe(false);
    const catalog = await Gen.buildReferenceCatalog(projectId, beat, { setUploads: true });
    const sets = catalog.filter((e) => e.owner_type === 'set');
    expect(sets[0]).toMatchObject({ image_id: String(diner.main_image_id), upload: true, label: 'Diner — photo (main image)', description: 'Diner interior (uploaded main)' });
    expect(sets[1]).toMatchObject({ image_id: second.toString(), upload: true, label: 'Diner — photo', description: 'Diner facade (uploaded)' });
    expect(sets.slice(2).some((e) => e.upload)).toBe(false);
    expect(sets).toHaveLength(4);
    expect(catalog.filter((e) => e.owner_type === 'character').some((e) => e.upload)).toBe(false);
    expect(Gen.formatReferenceCatalog(catalog)).toContain('[SET PHOTO Diner] Diner — photo (main image)');
  });

  it('a prop plate is offered first for its set, labelled and tagged with the object', async () => {
    const { beat } = await seedBeatWithRefs();
    const plate = newImage('A sugar shaker on grey');
    const diner = await fakeDb.collection('sets').findOne({ name_lower: 'diner' });
    await fakeDb.collection('sets').updateOne({ _id: diner._id }, {
      $push: { artworks: { _id: new ObjectId(), status: 'done', result_image_id: plate, name: 'Shaker plate', prop: 'sugar shaker', description: '' } },
    });
    const catalog = await Gen.buildReferenceCatalog(projectId, beat);
    const sets = catalog.filter((e) => e.owner_type === 'set');
    expect(sets[0]).toMatchObject({ image_id: plate.toString(), prop: 'sugar shaker', label: 'Diner — prop plate: sugar shaker' });
    expect(sets.slice(1).some((e) => 'prop' in e)).toBe(false);
    expect(Gen.formatReferenceCatalog(catalog)).toContain('[PROP Diner] Diner — prop plate: sugar shaker');
  });

  it('numbers done artworks only (characters then sets), skipping uploaded sheets/portraits/gallery and non-done artworks', async () => {
    const { beat, sheet, portrait, setMain, artworkId } = await seedBeatWithRefs();
    const catalog = await Gen.buildReferenceCatalog(projectId, beat);
    expect(catalog.map((e) => e.image_id)).toEqual([
      sheet.toString(), portrait.toString(), setMain.toString(), artworkId.toString(),
    ]);
    expect(catalog.map((e) => e.index)).toEqual([1, 2, 3, 4]);
    expect(catalog[0]).toMatchObject({ owner_type: 'character', owner_name: 'Sarah', label: 'Sarah — artwork: Turnaround' });
    expect(catalog[0].description).toBe('Sarah full-body turnaround, red coat');
    expect(catalog[2]).toMatchObject({ owner_type: 'set', owner_name: 'Diner', label: 'Diner — artwork: Interior plate' });
    expect(catalog[3].label).toBe('Diner — artwork: Night plate');
    const text = Gen.formatReferenceCatalog(catalog);
    expect(text).toContain('1. [CHARACTER Sarah] Sarah — artwork: Turnaround — Sarah full-body turnaround, red coat');
    expect(text).toContain('3. [SET Diner] Diner — artwork: Interior plate');
    expect(text).not.toMatch(/uploaded/);
  });

  it('carries owner_id, and offers a character\'s wardrobe plate even when it is a gallery upload', async () => {
    const { beat, sheet, artworkId } = await seedBeatWithRefs();
    const base = await Gen.buildReferenceCatalog(projectId, beat);
    expect(base.every((e) => /^[a-f0-9]{24}$/.test(e.owner_id))).toBe(true);
    expect(base.some((e) => e.wardrobe)).toBe(false);
    const plate = newImage('wardrobe upload');
    await fakeDb.collection('characters').updateOne({ project_id: projectId, name_lower: 'sarah' }, { $set: { wardrobe_image_id: plate }, $push: { images: { _id: plate } } });
    const withUpload = await Gen.buildReferenceCatalog(projectId, beat);
    const entry = withUpload.find((e) => e.image_id === plate.toString());
    expect(entry).toMatchObject({ owner_type: 'character', owner_name: 'Sarah', wardrobe: true, label: 'Sarah — wardrobe plate' });
    expect(Gen.formatReferenceCatalog(withUpload)).toContain('Sarah — wardrobe plate');
    // A plate that is already an artwork keeps one entry, relabelled.
    await fakeDb.collection('characters').updateOne({ project_id: projectId, name_lower: 'sarah' }, { $set: { wardrobe_image_id: sheet } });
    const asArt = await Gen.buildReferenceCatalog(projectId, beat);
    expect(asArt.filter((e) => e.image_id === sheet.toString())).toHaveLength(1);
    expect(asArt.find((e) => e.image_id === sheet.toString())).toMatchObject({ wardrobe: true, label: 'Sarah — wardrobe plate (artwork: Turnaround)' });
    expect(asArt.some((e) => e.image_id === plate.toString())).toBe(false);
    expect(String(artworkId)).toBeTruthy();
  });

  it('a beat whose hosts have no artwork yields an empty catalog even when they have uploads', async () => {
    const portrait = newImage('uploaded portrait');
    await fakeDb.collection('characters').insertOne({
      _id: new ObjectId(), project_id: projectId, name: 'Tom', name_lower: 'tom',
      character_sheet_image_ids: [newImage('sheet')], main_image_id: portrait, images: [{ _id: portrait }], artworks: [],
      fields: {}, created_at: new Date(), updated_at: new Date(),
    });
    const beat = await Plots.createBeat({ projectId, name: 'B', characters: ['Tom'] });
    expect(await Gen.buildReferenceCatalog(projectId, beat)).toEqual([]);
    expect(Gen.formatReferenceCatalog([])).toMatch(/no artwork available/);
  });
  it('shares the cap between hosts: a character with more artwork than the cap does not crowd out the set or his own wardrobe plate', async () => {
    const art = (n) => Array.from({ length: n }, (_, i) => ({ _id: new ObjectId(), status: 'done', result_image_id: newImage(`art ${i}`), name: `A${i}`, description: '' }));
    const plate = newImage('wardrobe plate');
    await fakeDb.collection('characters').insertOne({
      _id: new ObjectId(), project_id: projectId, name: 'Tom', name_lower: 'tom', fields: {},
      images: [{ _id: plate, caption: 'striped tee' }], wardrobe_image_id: plate, artworks: art(Gen.MAX_CATALOG_ENTRIES + 18),
    });
    await fakeDb.collection('sets').insertOne({ _id: new ObjectId(), project_id: projectId, name: 'Theater', name_lower: 'theater', description: '', artworks: art(Gen.MAX_CATALOG_ENTRIES) });
    await fakeDb.collection('sets').insertOne({ _id: new ObjectId(), project_id: projectId, name: 'Stars', name_lower: 'stars', description: '', artworks: art(6) });
    const beat = await Plots.createBeat({ projectId, name: 'B', characters: ['Tom'], sets: ['Theater', 'Stars'] });
    const catalog = await Gen.buildReferenceCatalog(projectId, beat);
    expect(catalog).toHaveLength(Gen.MAX_CATALOG_ENTRIES);
    const count = (name) => catalog.filter((e) => e.owner_name === name).length;
    expect(count('Stars')).toBe(6);
    expect(count('Tom')).toBe((Gen.MAX_CATALOG_ENTRIES - 6) / 2);
    expect(count('Theater')).toBe((Gen.MAX_CATALOG_ENTRIES - 6) / 2);
    expect(catalog[0]).toMatchObject({ owner_name: 'Tom', wardrobe: true, image_id: plate.toString() });
    expect(catalog.map((e) => e.index)).toEqual(catalog.map((_, n) => n + 1));
  });
});
