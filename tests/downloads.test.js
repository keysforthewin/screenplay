// Tests for the four bulk-download endpoints in src/web/downloads.js.
//
// We mock the auth middleware (so no real session required), the entity
// helpers (getBeat / getCharacter / getDirectorNotes), and the GridFS list +
// stream helpers. Because zips are produced with archiver { store: true } the
// raw file bytes appear verbatim inside the response body, which lets us check
// for both filenames AND file contents with a simple substring scan.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Readable } from 'node:stream';
import express from 'express';
import { ObjectId } from 'mongodb';

const beatId = new ObjectId();
const beat2Id = new ObjectId();
const charId = new ObjectId();
const note1Id = new ObjectId();
const note2Id = new ObjectId();

const beatImage1 = { _id: new ObjectId(), filename: 'shot1.png' };
const beatImage2 = { _id: new ObjectId(), filename: 'shot2.png' };
const beatAttach1 = { _id: new ObjectId(), filename: 'storyboard.pdf' };

const charImage = { _id: new ObjectId(), filename: 'portrait.jpg' };
const charAttach = { _id: new ObjectId(), filename: 'voice-memo.ogg' };

const libImage = { _id: new ObjectId(), filename: 'library-pic.png' };
const libAttach = { _id: new ObjectId(), filename: 'library-doc.pdf' };

const note1Image = { _id: new ObjectId(), filename: 'note-img.png' };
const note2Attach = { _id: new ObjectId(), filename: 'note-doc.pdf' };

// Map fileId.toString() → buffer
const imageContents = new Map([
  [beatImage1._id.toString(), Buffer.from('BEAT_IMAGE_1_BYTES')],
  [beatImage2._id.toString(), Buffer.from('BEAT_IMAGE_2_BYTES')],
  [charImage._id.toString(), Buffer.from('CHAR_IMAGE_BYTES')],
  [libImage._id.toString(), Buffer.from('LIB_IMAGE_BYTES')],
  [note1Image._id.toString(), Buffer.from('NOTE1_IMAGE_BYTES')],
]);
const attachmentContents = new Map([
  [beatAttach1._id.toString(), Buffer.from('BEAT_ATTACH_BYTES')],
  [charAttach._id.toString(), Buffer.from('CHAR_ATTACH_BYTES')],
  [libAttach._id.toString(), Buffer.from('LIB_ATTACH_BYTES')],
  [note2Attach._id.toString(), Buffer.from('NOTE2_ATTACH_BYTES')],
]);

vi.mock('../src/web/auth.js', () => ({
  requireSession: () => (_req, _res, next) => next(),
}));

vi.mock('../src/mongo/plots.js', () => ({
  getBeat: async (idOrOrder) => {
    if (idOrOrder === beatId.toString() || idOrOrder === '7') {
      return { _id: beatId, order: 7, name: 'Climax **scene**' };
    }
    return null;
  },
  listBeats: async () => [],
  getPlot: async () => ({ title: 'Test Screenplay' }),
}));

vi.mock('../src/mongo/characters.js', () => ({
  getCharacter: async (idOrName) => {
    if (idOrName === charId.toString() || idOrName === 'Steve') {
      return {
        _id: charId,
        name: 'Steve',
        images: [{ _id: charImage._id }],
        attachments: [{ _id: charAttach._id }],
      };
    }
    return null;
  },
  listCharacters: async () => [],
  findAllCharacters: async () => [],
}));

vi.mock('../src/mongo/directorNotes.js', () => ({
  getDirectorNotes: async () => ({
    notes: [
      { _id: note1Id, text: 'Note one' },
      { _id: note2Id, text: 'Note two' },
    ],
  }),
}));

vi.mock('../src/mongo/images.js', () => ({
  listImagesForBeat: async (id) => {
    return id === beatId.toString() ? [beatImage1, beatImage2] : [];
  },
  listImagesForDirectorNote: async (id) => {
    if (id === note1Id.toString()) return [note1Image];
    return [];
  },
  listLibraryImages: async () => [libImage],
  findImageFile: async (id) => {
    const key = id?.toString?.() || String(id);
    if (key === charImage._id.toString()) return charImage;
    return null;
  },
  openImageDownloadStream: (id) => {
    const key = id?.toString?.() || String(id);
    const buf = imageContents.get(key);
    if (!buf) {
      const r = new Readable({ read() {} });
      process.nextTick(() => r.emit('error', new Error('not found')));
      return r;
    }
    return Readable.from([buf]);
  },
  imageFileToMeta: (f) => ({ _id: f._id, filename: f.filename }),
  uploadGeneratedImage: async () => ({}),
  deleteImage: async () => {},
}));

vi.mock('../src/mongo/attachments.js', () => ({
  listAttachmentsForBeat: async (id) => {
    return id === beatId.toString() ? [beatAttach1] : [];
  },
  listAttachmentsForCharacter: async (id) => {
    return id === charId.toString() ? [charAttach] : [];
  },
  listAttachmentsForDirectorNote: async (id) => {
    if (id === note2Id.toString()) return [note2Attach];
    return [];
  },
  listLibraryAttachments: async () => [libAttach],
  findAttachmentFile: async () => null,
  openAttachmentDownloadStream: (id) => {
    const key = id?.toString?.() || String(id);
    const buf = attachmentContents.get(key);
    if (!buf) {
      const r = new Readable({ read() {} });
      process.nextTick(() => r.emit('error', new Error('not found')));
      return r;
    }
    return Readable.from([buf]);
  },
  attachmentFileToMeta: (f) => ({ _id: f._id, filename: f.filename }),
  uploadAttachmentBuffer: async () => ({}),
  deleteAttachment: async () => {},
}));

vi.mock('../src/mongo/imageBytes.js', () => ({
  validateImageBuffer: () => 'image/png',
}));

vi.mock('../src/mongo/prompts.js', () => ({
  getCharacterTemplate: async () => ({ fields: [] }),
  getPlotTemplate: async () => ({}),
}));

vi.mock('../src/web/gateway.js', () => ({
  addBeatImageViaGateway: async () => ({}),
  addBeatAttachmentViaGateway: async () => ({}),
  addCharacterImageViaGateway: async () => ({}),
  addDirectorNoteAttachmentViaGateway: async () => ({}),
  addDirectorNoteImageViaGateway: async () => ({}),
  addDirectorNoteViaGateway: async () => ({}),
  removeBeatAttachmentViaGateway: async () => ({}),
  removeBeatImageViaGateway: async () => ({}),
  removeCharacterImageViaGateway: async () => ({}),
  removeDirectorNoteAttachmentViaGateway: async () => ({}),
  removeDirectorNoteImageViaGateway: async () => ({}),
  removeDirectorNoteViaGateway: async () => ({}),
  setBeatMainImageViaGateway: async () => ({}),
  setCharacterMainImageViaGateway: async () => ({}),
  setDirectorNoteMainImageViaGateway: async () => ({}),
  updateBeatViaGateway: async () => ({}),
  updateCharacterViaGateway: async () => ({}),
}));

const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use('/api', buildApiRouter());
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(() => resolve()));
});

async function fetchZip(path) {
  const res = await fetch(`${baseUrl}${path}`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^application\/zip/);
  const ab = await res.arrayBuffer();
  return { res, body: Buffer.from(ab) };
}

describe('GET /api/beat/:id/download', () => {
  it('streams a zip with images/ and attachments/ folders', async () => {
    const { res, body } = await fetchZip(`/api/beat/${beatId.toString()}/download`);
    expect(res.headers.get('content-disposition')).toMatch(/Climax.*scene\.zip/);
    expect(body.slice(0, 2).toString('ascii')).toBe('PK');
    const asStr = body.toString('binary');
    expect(asStr).toContain('images/shot1.png');
    expect(asStr).toContain('images/shot2.png');
    expect(asStr).toContain('attachments/storyboard.pdf');
    // Stored (uncompressed), so raw file bytes are present too.
    expect(asStr).toContain('BEAT_IMAGE_1_BYTES');
    expect(asStr).toContain('BEAT_IMAGE_2_BYTES');
    expect(asStr).toContain('BEAT_ATTACH_BYTES');
  });

  it('also accepts beat order in the URL', async () => {
    const { body } = await fetchZip(`/api/beat/7/download`);
    expect(body.toString('binary')).toContain('images/shot1.png');
  });

  it('returns 404 for a missing beat', async () => {
    const res = await fetch(`${baseUrl}/api/beat/${beat2Id.toString()}/download`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/character/:id/download', () => {
  it('streams a zip with the character images and attachments', async () => {
    const { res, body } = await fetchZip(`/api/character/${charId.toString()}/download`);
    expect(res.headers.get('content-disposition')).toMatch(/Steve\.zip/);
    const asStr = body.toString('binary');
    expect(asStr).toContain('images/portrait.jpg');
    expect(asStr).toContain('attachments/voice-memo.ogg');
    expect(asStr).toContain('CHAR_IMAGE_BYTES');
    expect(asStr).toContain('CHAR_ATTACH_BYTES');
  });

  it('also accepts character name in the URL', async () => {
    const { body } = await fetchZip(`/api/character/Steve/download`);
    expect(body.toString('binary')).toContain('images/portrait.jpg');
  });
});

describe('GET /api/library/download', () => {
  it('streams library images and attachments', async () => {
    const { res, body } = await fetchZip('/api/library/download');
    expect(res.headers.get('content-disposition')).toMatch(/library\.zip/);
    const asStr = body.toString('binary');
    expect(asStr).toContain('images/library-pic.png');
    expect(asStr).toContain('attachments/library-doc.pdf');
    expect(asStr).toContain('LIB_IMAGE_BYTES');
    expect(asStr).toContain('LIB_ATTACH_BYTES');
  });
});

describe('GET /api/notes/download', () => {
  it('streams a zip with one folder per note', async () => {
    const { res, body } = await fetchZip('/api/notes/download');
    expect(res.headers.get('content-disposition')).toMatch(/director-notes\.zip/);
    const asStr = body.toString('binary');
    // Folder names: 001-<last6 of note1Id>/, 002-<last6 of note2Id>/
    const short1 = note1Id.toString().slice(-6);
    const short2 = note2Id.toString().slice(-6);
    expect(asStr).toContain(`notes/001-${short1}/images/note-img.png`);
    expect(asStr).toContain(`notes/002-${short2}/attachments/note-doc.pdf`);
    expect(asStr).toContain('NOTE1_IMAGE_BYTES');
    expect(asStr).toContain('NOTE2_ATTACH_BYTES');
  });
});
