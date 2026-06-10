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
vi.mock('../src/rag/queue.js', () => ({
  enqueueReindex: () => {},
}));
vi.mock('../src/rag/indexer.js', () => ({}));

const { resolveRoom } = await import('../src/web/roomRegistry.js');
const Projects = await import('../src/mongo/projects.js');

let pid;
beforeEach(async () => {
  fakeDb.reset();
  pid = (await Projects.getDefaultProject())._id;
});

function seedAttachmentFile({ id, ownerType, ownerId, name = '', description = '' }) {
  const doc = {
    _id: id || new ObjectId(),
    filename: 'doc.pdf',
    contentType: 'application/pdf',
    length: 1234,
    uploadDate: new Date(),
    metadata: {
      owner_type: ownerType,
      owner_id: ownerId,
      source: 'upload',
      content_type: 'application/pdf',
      name,
      description,
    },
  };
  fakeDb.collection('attachments.files')._docs.push(doc);
  return doc;
}

describe('owned-attachment fragments on character/beat rooms', () => {
  it('describeBeatRoom seeds attachment:<id>:name and :description from GridFS metadata', async () => {
    const beatId = new ObjectId();
    const attA = new ObjectId();
    const attB = new ObjectId();
    fakeDb.collection('plots')._docs.push({
      _id: 'main',
      project_id: pid.toString(),
      title: 'P',
      synopsis: '',
      beats: [
        {
          _id: beatId,
          order: 1,
          name: 'Open',
          desc: '',
          body: '',
          images: [],
          main_image_id: null,
          attachments: [
            { _id: attA, filename: 'doc.pdf', content_type: 'application/pdf' },
            { _id: attB, filename: 'b.pdf', content_type: 'application/pdf' },
          ],
        },
      ],
      notes: '',
      current_beat_id: null,
      updated_at: new Date(),
    });
    seedAttachmentFile({
      id: attA,
      ownerType: 'beat',
      ownerId: beatId,
      name: 'Treatment',
      description: 'first draft',
    });
    seedAttachmentFile({ id: attB, ownerType: 'beat', ownerId: beatId, name: '', description: '' });

    const desc = await resolveRoom(`beat:${beatId}`);
    expect(desc).toBeTruthy();
    expect(desc.fields).toEqual(
      expect.arrayContaining([
        `attachment:${attA}:name`,
        `attachment:${attA}:description`,
        `attachment:${attB}:name`,
        `attachment:${attB}:description`,
      ]),
    );
    expect(desc.seed[`attachment:${attA}:name`]).toBe('Treatment');
    expect(desc.seed[`attachment:${attA}:description`]).toBe('first draft');
    expect(desc.seed[`attachment:${attB}:name`]).toBe('');
  });

  it('beat room persistFields routes attachment:<id>:name back to GridFS metadata', async () => {
    const beatId = new ObjectId();
    const attA = new ObjectId();
    fakeDb.collection('plots')._docs.push({
      _id: 'main',
      project_id: pid.toString(),
      title: 'P',
      synopsis: '',
      beats: [
        {
          _id: beatId,
          order: 1,
          name: 'Open',
          desc: '',
          body: '',
          images: [],
          main_image_id: null,
          attachments: [{ _id: attA, filename: 'doc.pdf' }],
        },
      ],
      notes: '',
      current_beat_id: null,
      updated_at: new Date(),
    });
    seedAttachmentFile({
      id: attA,
      ownerType: 'beat',
      ownerId: beatId,
      name: 'old',
      description: 'old desc',
    });

    const desc = await resolveRoom(`beat:${beatId}`);
    const result = await desc.persistFields({
      [`attachment:${attA}:name`]: 'NEW NAME',
      [`attachment:${attA}:description`]: 'old desc',
    });
    expect(result.changed).toBe(true);
    expect(result.fields).toEqual([`attachment:${attA}:name`]);

    const after = await fakeDb.collection('attachments.files').findOne({ _id: attA });
    expect(after.metadata.name).toBe('NEW NAME');
    expect(after.metadata.description).toBe('old desc');
  });

  it('describeCharacterRoom seeds attachment fragments from c.attachments', async () => {
    const charId = new ObjectId();
    const attA = new ObjectId();
    fakeDb.collection('characters')._docs.push({
      _id: charId,
      project_id: pid.toString(),
      name: 'Steve',
      name_lower: 'steve',
      hollywood_actor: '',
      images: [],
      main_image_id: null,
      attachments: [{ _id: attA, filename: 'bio.pdf' }],
    });
    seedAttachmentFile({
      id: attA,
      ownerType: 'character',
      ownerId: charId,
      name: 'Bio',
      description: 'short',
    });

    const desc = await resolveRoom(`character:${charId}`);
    expect(desc).toBeTruthy();
    expect(desc.fields).toEqual(
      expect.arrayContaining([`attachment:${attA}:name`, `attachment:${attA}:description`]),
    );
    expect(desc.seed[`attachment:${attA}:name`]).toBe('Bio');
    expect(desc.seed[`attachment:${attA}:description`]).toBe('short');
  });

  it('describeBeatRoom returns no attachment fragments when the beat has no attachments', async () => {
    const beatId = new ObjectId();
    fakeDb.collection('plots')._docs.push({
      _id: 'main',
      project_id: pid.toString(),
      title: 'P',
      synopsis: '',
      beats: [
        {
          _id: beatId,
          order: 1,
          name: 'Open',
          desc: '',
          body: '',
          images: [],
          main_image_id: null,
          attachments: [],
        },
      ],
      notes: '',
      current_beat_id: null,
      updated_at: new Date(),
    });

    const desc = await resolveRoom(`beat:${beatId}`);
    const attachFields = desc.fields.filter((f) => f.startsWith('attachment:'));
    expect(attachFields).toEqual([]);
  });
});
