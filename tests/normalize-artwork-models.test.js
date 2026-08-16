// Artworks rendered before generation recording (067f80b) had their `model`
// field overwritten with the ROUTED fal endpoint id ('flux-2-pro' →
// 'fal-ai/flux-2-pro/edit'), which the picker list doesn't contain — so Retry
// 400'd and the regenerate dialog silently swapped to the first list entry.
// Two-part fix: normalizeImageModel maps wired endpoint ids (and gpt-image-2)
// back to their shortcut ids on the way in, and a one-shot migration rewrites
// the stored values.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
  closeMongo: async () => {},
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { normalizeImageModel } = await import('../src/web/imageModelValidate.js');
const { normalizeArtworkModels } = await import('../scripts/normalize-artwork-models.js');

describe('normalizeImageModel — routed endpoint ids map back to shortcuts', () => {
  it('maps both halves of each wired generate/edit pair to the shortcut id', () => {
    expect(normalizeImageModel('fal-ai/flux-2-pro')).toBe('flux-2-pro');
    expect(normalizeImageModel('fal-ai/flux-2-pro/edit')).toBe('flux-2-pro');
    expect(normalizeImageModel('fal-ai/nano-banana-pro/edit')).toBe('nano-banana-pro');
    expect(normalizeImageModel('fal-ai/flux-pro/kontext')).toBe('flux-pro-kontext');
    expect(normalizeImageModel('gpt-image-2')).toBe('openai');
  });

  it('leaves shortcut ids, catalog endpoint ids, and legacy enums alone', () => {
    expect(normalizeImageModel('flux-2-pro')).toBe('flux-2-pro');
    expect(normalizeImageModel('fal-ai/some-catalog/model')).toBe('fal-ai/some-catalog/model');
    expect(normalizeImageModel('gemini')).toBe('nano-banana-pro');
    expect(normalizeImageModel('fal')).toBe('flux-pro-kontext');
  });
});

describe('normalize-artwork-models migration', () => {
  beforeEach(() => fakeDb.reset());

  it('rewrites routed endpoint ids on every host type and reports counts', async () => {
    const art = (model) => ({ _id: new ObjectId(), model, status: 'done' });
    await fakeDb.collection('sets').insertOne({
      _id: new ObjectId(),
      name: 'S',
      artworks: [art('fal-ai/flux-2-pro/edit'), art('flux-2-pro')],
    });
    await fakeDb.collection('characters').insertOne({
      _id: new ObjectId(),
      name: 'C',
      artworks: [art('fal-ai/nano-banana-2/edit')],
    });
    await fakeDb.collection('plots').insertOne({
      _id: new ObjectId(),
      project_id: 'p1',
      beats: [{ _id: new ObjectId(), artworks: [art('gpt-image-2'), art('fal-ai/gemini-25-flash-image')] }],
    });

    const summary = await normalizeArtworkModels(fakeDb);
    expect(summary.artworks_updated).toBe(4);

    const set = await fakeDb.collection('sets').findOne({});
    expect(set.artworks.map((a) => a.model)).toEqual(['flux-2-pro', 'flux-2-pro']);
    const ch = await fakeDb.collection('characters').findOne({});
    expect(ch.artworks[0].model).toBe('nano-banana-2');
    const plot = await fakeDb.collection('plots').findOne({});
    expect(plot.beats[0].artworks.map((a) => a.model)).toEqual(['openai', 'gemini-25-flash']);
  });

  it('is idempotent — a second run changes nothing', async () => {
    await fakeDb.collection('sets').insertOne({
      _id: new ObjectId(),
      name: 'S',
      artworks: [{ _id: new ObjectId(), model: 'fal-ai/flux-2-pro/edit' }],
    });
    await normalizeArtworkModels(fakeDb);
    const second = await normalizeArtworkModels(fakeDb);
    expect(second.artworks_updated).toBe(0);
  });
});
