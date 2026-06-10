// Unit tests for the artwork-import flow.
//
// Covers:
//   - appendDoneArtwork (mongo) appends a status='done' artwork with the
//     right shape and source='imported'.
//   - createArtworkFromImageViaGateway (gateway) reuses the existing GridFS
//     id when the source is already host-owned (no copy).
//
// The cross-owner copy path is exercised by the gateway in production but
// requires real GridFS streams; we don't test it here.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
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
const Artworks = await import('../src/mongo/artworks.js');
const Characters = await import('../src/mongo/characters.js');
const Plots = await import('../src/mongo/plots.js');
const Gateway = await import('../src/web/gateway.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

function seedImage({ ownerType, ownerId, contentType = 'image/png' }) {
  const doc = {
    _id: new ObjectId(),
    filename: 'src.png',
    contentType,
    length: 1234,
    uploadDate: new Date(),
    metadata: {
      owner_type: ownerType,
      owner_id: ownerId || null,
      source: 'generated',
    },
  };
  fakeDb.collection('images.files')._docs.push(doc);
  return doc;
}

describe('appendDoneArtwork (mongo helper)', () => {
  it('appends a done artwork on a character with source=imported', async () => {
    const c = await Characters.createCharacter({ projectId, name: 'Rae' });
    const resultId = new ObjectId();

    const { artwork, host_id } = await Artworks.appendDoneArtwork({ projectId,
      hostType: 'character',
      hostId: c._id.toString(),
      resultImageId: resultId,
      name: 'Imported portrait',
    });

    expect(host_id.equals(c._id)).toBe(true);
    expect(artwork.status).toBe('done');
    expect(artwork.source).toBe('imported');
    expect(artwork.prompt).toBe('');
    expect(artwork.model).toBe('');
    expect(artwork.reference_image_ids).toEqual([]);
    expect(artwork.job_id).toBeNull();
    expect(artwork.name).toBe('Imported portrait');
    expect(artwork.result_image_id.equals(resultId)).toBe(true);

    const fresh = await Characters.getCharacter(projectId, 'Rae');
    expect(fresh.artworks).toHaveLength(1);
    expect(fresh.artworks[0]._id.equals(artwork._id)).toBe(true);
  });

  it('appends a done artwork on a beat', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Cold open' });
    const resultId = new ObjectId();

    const { artwork } = await Artworks.appendDoneArtwork({ projectId,
      hostType: 'beat',
      hostId: beat._id.toString(),
      resultImageId: resultId,
    });

    expect(artwork.status).toBe('done');
    expect(artwork.source).toBe('imported');
    expect(artwork.result_image_id.equals(resultId)).toBe(true);

    const plot = await Plots.getPlot(projectId);
    const fresh = plot.beats.find((b) => b._id.equals(beat._id));
    expect(fresh.artworks).toHaveLength(1);
  });

  it('preserves prior artworks when appending another import', async () => {
    const c = await Characters.createCharacter({ projectId, name: 'Iris' });
    await Artworks.appendDoneArtwork({ projectId,
      hostType: 'character',
      hostId: c._id.toString(),
      resultImageId: new ObjectId(),
      name: 'first',
    });
    await Artworks.appendDoneArtwork({ projectId,
      hostType: 'character',
      hostId: c._id.toString(),
      resultImageId: new ObjectId(),
      name: 'second',
    });

    const fresh = await Characters.getCharacter(projectId, 'Iris');
    expect(fresh.artworks).toHaveLength(2);
    expect(fresh.artworks[0].name).toBe('first');
    expect(fresh.artworks[1].name).toBe('second');
  });
});

describe('createArtworkFromImageViaGateway (same-owner, no copy)', () => {
  it('reuses the existing image id when the source is already character-owned', async () => {
    const c = await Characters.createCharacter({ projectId, name: 'Rae' });
    const file = seedImage({ ownerType: 'character', ownerId: c._id });

    const { artwork } = await Gateway.createArtworkFromImageViaGateway({ projectId,
      hostType: 'character',
      hostId: c._id.toString(),
      imageId: file._id,
      name: 'reused',
    });

    expect(artwork.status).toBe('done');
    expect(artwork.result_image_id.toString()).toBe(file._id.toString());

    // GridFS file is unchanged.
    const after = await fakeDb
      .collection('images.files')
      .findOne({ _id: file._id });
    expect(after.metadata.owner_type).toBe('character');
    expect(after.metadata.owner_id.equals(c._id)).toBe(true);
  });

  it('reuses the existing image id when the source is already beat-owned', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Climax' });
    const file = seedImage({ ownerType: 'beat', ownerId: beat._id });

    const { artwork } = await Gateway.createArtworkFromImageViaGateway({ projectId,
      hostType: 'beat',
      hostId: beat._id.toString(),
      imageId: file._id,
    });

    expect(artwork.status).toBe('done');
    expect(artwork.result_image_id.toString()).toBe(file._id.toString());
  });

  it('throws status=404 when the source image does not exist', async () => {
    const c = await Characters.createCharacter({ projectId, name: 'Rae' });
    await expect(
      Gateway.createArtworkFromImageViaGateway({ projectId,
        hostType: 'character',
        hostId: c._id.toString(),
        imageId: new ObjectId(),
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
