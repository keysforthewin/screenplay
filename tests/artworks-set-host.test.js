import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Artworks = await import('../src/mongo/artworks.js');
const Sets = await import('../src/mongo/sets.js');
const Projects = await import('../src/mongo/projects.js');

let p1;
let setId;

beforeEach(async () => {
  fakeDb.reset();
  p1 = (await Projects.createProject('Alpha'))._id.toString();
  const s = await Sets.createSet({ projectId: p1, name: 'Kitchen' });
  setId = s._id.toString();
});

describe("artworks 'set' host type", () => {
  it('createPendingArtwork + setArtworkResult round-trips on a set', async () => {
    const { artwork } = await Artworks.createPendingArtwork({
      projectId: p1,
      hostType: 'set',
      hostId: setId,
      prompt: 'wide shot of the kitchen',
      model: 'test-model',
    });
    expect(artwork.status).toBe('pending');
    const result = new ObjectId();
    const done = await Artworks.setArtworkResult({
      projectId: p1,
      hostType: 'set',
      hostId: setId,
      artworkId: artwork._id,
      resultImageId: result,
    });
    expect(done.artwork.status).toBe('done');
    expect(done.artwork.result_image_id.equals(result)).toBe(true);
    const listed = await Artworks.listArtworks({ projectId: p1, hostType: 'set', hostId: setId });
    expect(listed.artworks.length).toBe(1);
  });

  it('set host resolves by name too', async () => {
    const { artwork } = await Artworks.appendDoneArtwork({
      projectId: p1,
      hostType: 'set',
      hostId: 'kitchen',
      resultImageId: new ObjectId(),
      name: 'imported plate',
    });
    expect(artwork.source).toBe('imported');
    const got = await Artworks.getArtwork({
      projectId: p1,
      hostType: 'set',
      hostId: setId,
      artworkId: artwork._id,
    });
    expect(got.host_kind).toBe('set');
  });

  it('setArtworkResult follows the set main_image_id forward', async () => {
    const firstResult = new ObjectId();
    const { artwork } = await Artworks.appendDoneArtwork({
      projectId: p1,
      hostType: 'set',
      hostId: setId,
      resultImageId: firstResult,
    });
    // Make the artwork's result the set's main image.
    await fakeDb.collection('sets').updateOne(
      { name_lower: 'kitchen' },
      { $set: { main_image_id: firstResult } },
    );
    const newResult = new ObjectId();
    const res = await Artworks.setArtworkResult({
      projectId: p1,
      hostType: 'set',
      hostId: setId,
      artworkId: artwork._id,
      resultImageId: newResult,
    });
    expect(res.mainImageIdChange?.changed).toBe(true);
    const s = await Sets.getSet(p1, setId);
    expect(s.main_image_id.equals(newResult)).toBe(true);
  });

  it('removeArtwork returns image ids and clears main when it pointed at them', async () => {
    const result = new ObjectId();
    const { artwork } = await Artworks.appendDoneArtwork({
      projectId: p1,
      hostType: 'set',
      hostId: setId,
      resultImageId: result,
    });
    await fakeDb.collection('sets').updateOne(
      { name_lower: 'kitchen' },
      { $set: { main_image_id: result } },
    );
    const removed = await Artworks.removeArtwork({
      projectId: p1,
      hostType: 'set',
      hostId: setId,
      artworkId: artwork._id,
    });
    expect(removed.removed_image_ids.map(String)).toContain(result.toString());
    const s = await Sets.getSet(p1, setId);
    expect(s.main_image_id).toBe(null);
    expect((s.artworks || []).length).toBe(0);
  });

  it('unknown set host throws not-found; invalid hostType still rejected', async () => {
    await expect(
      Artworks.listArtworks({ projectId: p1, hostType: 'set', hostId: 'nope' }),
    ).rejects.toThrow(/Set not found/);
    await expect(
      Artworks.listArtworks({ projectId: p1, hostType: 'prop', hostId: setId }),
    ).rejects.toThrow(/invalid hostType/);
  });
});
