// Tests for the new POST /image/copy endpoints used by the picker modal's
// "Character" and "Beats" tabs. The copy endpoints duplicate a source GridFS
// image into a fresh file owned by the target entity — the source must stay
// intact (copy semantics, not move).
//
// GridFSBucket reads/writes don't play nicely with the in-memory fake mongo,
// so we mock readImageBuffer + uploadGeneratedImage and verify call args plus
// the embedded-gallery push via the real gateway helpers.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/web/auth.js', () => ({
  requireSession: () => (_req, _res, next) => next(),
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const uploadCalls = [];
const readCalls = [];

vi.mock('../src/mongo/images.js', async () => {
  const real = await vi.importActual('../src/mongo/images.js');
  return {
    ...real,
    readImageBuffer: async (id) => {
      const key = String(id);
      readCalls.push(key);
      const docs = fakeDb.collection('images.files')._docs;
      const found = docs.find((d) => String(d._id) === key);
      if (!found) return null;
      return {
        buffer: Buffer.from('SOURCE_BYTES'),
        file: found,
      };
    },
    uploadGeneratedImage: async (_projectId, args) => {
      const id = new ObjectId();
      uploadCalls.push({
        ownerType: args.ownerType,
        ownerId: args.ownerId ? String(args.ownerId) : null,
        prompt: args.prompt ?? null,
        generatedBy: args.generatedBy ?? null,
        name: args.name ?? '',
        description: args.description ?? '',
      });
      return {
        _id: id,
        filename: args.filename || 'copy.png',
        content_type: args.contentType,
        size: args.buffer?.length || 0,
        metadata: {
          owner_type: args.ownerType,
          owner_id: args.ownerId,
          prompt: args.prompt ?? null,
          generated_by: args.generatedBy ?? null,
          name: args.name ?? '',
          description: args.description ?? '',
        },
        uploaded_at: new Date(),
      };
    },
  };
});

const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const DirectorNotes = await import('../src/mongo/directorNotes.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter());
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  fakeDb.reset();
  uploadCalls.length = 0;
  readCalls.length = 0;
});

function seedSourceImage({ ownerType, ownerId, name, description, prompt }) {
  const doc = {
    _id: new ObjectId(),
    filename: 'source.png',
    contentType: 'image/png',
    length: 12,
    uploadDate: new Date(),
    metadata: {
      owner_type: ownerType ?? null,
      owner_id: ownerId ?? null,
      source: 'generated',
      prompt: prompt || null,
      generated_by: 'gemini-2.5-flash-image',
      name: name || '',
      description: description || '',
    },
  };
  fakeDb.collection('images.files')._docs.push(doc);
  return doc;
}

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, json };
}

describe('POST /api/character/:id/image/copy', () => {
  it('copies a character-owned image to another character without disturbing the source', async () => {
    const src = await Characters.createCharacter({ name: 'Bronze Leopard' });
    const dst = await Characters.createCharacter({ name: 'Silver Wolf' });
    const file = seedSourceImage({
      ownerType: 'character',
      ownerId: src._id,
      name: 'noir portrait',
      description: 'rim-lit moody',
      prompt: 'noir portrait, rim light',
    });
    // Mirror the embedded-gallery push that the original attach flow would have done
    await fakeDb.collection('characters').updateOne(
      { _id: src._id },
      { $push: { images: { _id: file._id, filename: file.filename } } },
    );

    const { status, json } = await post(
      `/api/character/${dst._id}/image/copy`,
      { image_id: String(file._id) },
    );

    expect(status).toBe(200);
    expect(readCalls).toEqual([String(file._id)]);
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].ownerType).toBe('character');
    expect(uploadCalls[0].ownerId).toBe(String(dst._id));
    expect(uploadCalls[0].prompt).toBe('noir portrait, rim light');
    expect(uploadCalls[0].generatedBy).toBe('gemini-2.5-flash-image');
    expect(uploadCalls[0].name).toBe('noir portrait');
    expect(uploadCalls[0].description).toBe('rim-lit moody');

    // Source character keeps its image untouched.
    const srcDoc = await fakeDb.collection('characters').findOne({ _id: src._id });
    expect(srcDoc.images).toHaveLength(1);
    expect(String(srcDoc.images[0]._id)).toBe(String(file._id));

    // Destination character has a brand-new image entry (different _id).
    const dstDoc = await fakeDb.collection('characters').findOne({ _id: dst._id });
    expect(dstDoc.images).toHaveLength(1);
    expect(String(dstDoc.images[0]._id)).not.toBe(String(file._id));

    // The source GridFS file metadata is unchanged.
    const fileAfter = await fakeDb.collection('images.files').findOne({ _id: file._id });
    expect(fileAfter.metadata.owner_type).toBe('character');
    expect(String(fileAfter.metadata.owner_id)).toBe(String(src._id));
  });

  it('copies a beat-owned image to a character without disturbing the source beat', async () => {
    const char = await Characters.createCharacter({ name: 'Bronze Leopard' });
    const beat = await Plots.createBeat({ name: 'Diner Showdown' });
    const file = seedSourceImage({ ownerType: 'beat', ownerId: beat._id });
    await Plots.pushBeatImage(undefined, beat._id.toString(), {
      _id: file._id,
      filename: file.filename,
      content_type: file.contentType,
      size: file.length,
      uploaded_at: file.uploadDate,
    });

    const { status, json } = await post(
      `/api/character/${char._id}/image/copy`,
      { image_id: String(file._id) },
    );

    expect(status).toBe(200);
    expect(uploadCalls[0].ownerType).toBe('character');
    expect(uploadCalls[0].ownerId).toBe(String(char._id));

    // Source beat keeps its image.
    const plot = await Plots.getPlot();
    const srcBeat = plot.beats.find((b) => b._id.equals(beat._id));
    expect(srcBeat.images).toHaveLength(1);
    expect(String(srcBeat.images[0]._id)).toBe(String(file._id));

    // Source GridFS file still owned by the beat.
    const fileAfter = await fakeDb.collection('images.files').findOne({ _id: file._id });
    expect(fileAfter.metadata.owner_type).toBe('beat');
    expect(String(fileAfter.metadata.owner_id)).toBe(String(beat._id));
  });

  it('returns 400 on a malformed image_id', async () => {
    const c = await Characters.createCharacter({ name: 'Bronze Leopard' });
    const { status } = await post(
      `/api/character/${c._id}/image/copy`,
      { image_id: 'not-an-oid' },
    );
    expect(status).toBe(400);
    expect(uploadCalls).toHaveLength(0);
  });

  it('returns 404 when the source image does not exist', async () => {
    const c = await Characters.createCharacter({ name: 'Bronze Leopard' });
    const { status } = await post(
      `/api/character/${c._id}/image/copy`,
      { image_id: String(new ObjectId()) },
    );
    expect(status).toBe(404);
    expect(uploadCalls).toHaveLength(0);
  });
});

describe('POST /api/beat/:id/image/copy', () => {
  it('copies a character-owned image to a beat without disturbing the source', async () => {
    const char = await Characters.createCharacter({ name: 'Bronze Leopard' });
    const beat = await Plots.createBeat({ name: 'Diner Showdown' });
    const file = seedSourceImage({ ownerType: 'character', ownerId: char._id });
    await fakeDb.collection('characters').updateOne(
      { _id: char._id },
      { $push: { images: { _id: file._id, filename: file.filename } } },
    );

    const { status } = await post(
      `/api/beat/${beat._id}/image/copy`,
      { image_id: String(file._id) },
    );

    expect(status).toBe(200);
    expect(uploadCalls[0].ownerType).toBe('beat');
    expect(uploadCalls[0].ownerId).toBe(String(beat._id));

    const charAfter = await fakeDb.collection('characters').findOne({ _id: char._id });
    expect(charAfter.images).toHaveLength(1);

    const plot = await Plots.getPlot();
    const beatAfter = plot.beats.find((b) => b._id.equals(beat._id));
    expect(beatAfter.images).toHaveLength(1);
    expect(String(beatAfter.images[0]._id)).not.toBe(String(file._id));
  });
});

describe('POST /api/notes/:noteId/image/copy', () => {
  it('copies an image into a director note without disturbing the source', async () => {
    const char = await Characters.createCharacter({ name: 'Bronze Leopard' });
    const note = await DirectorNotes.addDirectorNote({ text: 'noir tone' });
    const file = seedSourceImage({ ownerType: 'character', ownerId: char._id });

    const { status } = await post(
      `/api/notes/${note._id}/image/copy`,
      { image_id: String(file._id) },
    );

    expect(status).toBe(200);
    expect(uploadCalls[0].ownerType).toBe('director_note');
    expect(uploadCalls[0].ownerId).toBe(String(note._id));

    const dn = await DirectorNotes.getDirectorNotes();
    const noteAfter = dn.notes.find((n) => n._id.equals(note._id));
    expect(noteAfter.images).toHaveLength(1);
    expect(String(noteAfter.images[0]._id)).not.toBe(String(file._id));
  });
});
