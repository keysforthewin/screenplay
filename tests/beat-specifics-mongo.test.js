import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Plots = await import('../src/mongo/plots.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('updateBeat — specifics support', () => {
  it('writes a single specifics.<key> dot-path patch', async () => {
    const b = await Plots.createBeat({ name: 'Diner', desc: 'Alice argues with Bob.' });
    const updated = await Plots.updateBeat(b._id.toString(), {
      'specifics.scene_type': 'interior',
    });
    expect(updated.specifics.scene_type).toBe('interior');
  });

  it('expands a specifics: {…} object into the embedded subdoc', async () => {
    const b = await Plots.createBeat({ name: 'Diner', desc: 'Alice argues with Bob.' });
    const updated = await Plots.updateBeat(b._id.toString(), {
      specifics: {
        scene_type: 'interior',
        time_period: 'dusk',
      },
    });
    expect(updated.specifics.scene_type).toBe('interior');
    expect(updated.specifics.time_period).toBe('dusk');
  });

  it('preserves prior specifics keys when patching a single field', async () => {
    const b = await Plots.createBeat({ name: 'Diner', desc: 'd' });
    await Plots.updateBeat(b._id.toString(), {
      specifics: { scene_type: 'interior', time_period: 'dusk' },
    });
    const updated = await Plots.updateBeat(b._id.toString(), {
      'specifics.materials_atmosphere': 'fluorescent buzz, cigarette haze',
    });
    expect(updated.specifics.scene_type).toBe('interior');
    expect(updated.specifics.time_period).toBe('dusk');
    expect(updated.specifics.materials_atmosphere).toBe(
      'fluorescent buzz, cigarette haze',
    );
  });

  it('rejects unknown specifics field names (object form)', async () => {
    const b = await Plots.createBeat({ name: 'Diner', desc: 'd' });
    await expect(
      Plots.updateBeat(b._id.toString(), { specifics: { not_a_real_field: 'foo' } }),
    ).rejects.toThrow(/unknown specifics field/);
  });

  it('rejects unknown specifics field names (dot form)', async () => {
    const b = await Plots.createBeat({ name: 'Diner', desc: 'd' });
    await expect(
      Plots.updateBeat(b._id.toString(), { 'specifics.bogus': 'foo' }),
    ).rejects.toThrow(/unknown specifics field/);
  });

  it('rejects when no recognized fields are provided', async () => {
    const b = await Plots.createBeat({ name: 'Diner', desc: 'd' });
    await expect(
      Plots.updateBeat(b._id.toString(), { foo: 'bar' }),
    ).rejects.toThrow(/no recognized fields/);
  });
});

describe('updateBeat — scene_sheet_image_id', () => {
  it('accepts a 24-hex string and stores it as ObjectId', async () => {
    const b = await Plots.createBeat({ name: 'Diner', desc: 'd' });
    const id = new ObjectId();
    const updated = await Plots.updateBeat(b._id.toString(), {
      scene_sheet_image_id: id.toString(),
    });
    expect(updated.scene_sheet_image_id).toBeDefined();
    expect(updated.scene_sheet_image_id.equals(id)).toBe(true);
  });

  it('accepts an ObjectId instance', async () => {
    const b = await Plots.createBeat({ name: 'Diner', desc: 'd' });
    const id = new ObjectId();
    const updated = await Plots.updateBeat(b._id.toString(), {
      scene_sheet_image_id: id,
    });
    expect(updated.scene_sheet_image_id.equals(id)).toBe(true);
  });

  it('accepts null to clear the field', async () => {
    const b = await Plots.createBeat({ name: 'Diner', desc: 'd' });
    const id = new ObjectId();
    await Plots.updateBeat(b._id.toString(), {
      scene_sheet_image_id: id.toString(),
    });
    const cleared = await Plots.updateBeat(b._id.toString(), {
      scene_sheet_image_id: null,
    });
    expect(cleared.scene_sheet_image_id).toBeNull();
  });

  it('rejects non-hex strings', async () => {
    const b = await Plots.createBeat({ name: 'Diner', desc: 'd' });
    await expect(
      Plots.updateBeat(b._id.toString(), { scene_sheet_image_id: 'not-hex' }),
    ).rejects.toThrow(/scene_sheet_image_id/);
  });
});
