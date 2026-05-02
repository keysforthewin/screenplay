import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import { ObjectId } from 'mongodb';
import { config } from '../src/config.js';

const imageStore = new Map();
const attachmentStore = new Map();

vi.mock('../src/mongo/images.js', () => ({
  findImageFile: async (id) => {
    const key = id?.toString?.() || String(id);
    return imageStore.get(key) || null;
  },
  openImageDownloadStream: (id) => {
    const key = id?.toString?.() || String(id);
    const file = imageStore.get(key);
    if (!file) {
      const r = new Readable({ read() {} });
      process.nextTick(() => r.emit('error', new Error('not found')));
      return r;
    }
    return Readable.from([file._content || Buffer.alloc(0)]);
  },
}));

vi.mock('../src/mongo/attachments.js', () => ({
  findAttachmentFile: async (id) => {
    const key = id?.toString?.() || String(id);
    return attachmentStore.get(key) || null;
  },
  openAttachmentDownloadStream: (id) => {
    const key = id?.toString?.() || String(id);
    const file = attachmentStore.get(key);
    if (!file) {
      const r = new Readable({ read() {} });
      process.nextTick(() => r.emit('error', new Error('not found')));
      return r;
    }
    return Readable.from([file._content || Buffer.alloc(0)]);
  },
}));

const { buildApp, isValidPdfFilename, pdfLink, imageLink, attachmentLink } = await import(
  '../src/server/index.js'
);

let server;
let baseUrl;
let tmpDir;
const validName = 'screenplay-1700000000000.pdf';
const validBody = '%PDF-1.7 fake content';

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'screenplay-server-test-'));
  config.pdf.exportDir = tmpDir;
  await fsp.writeFile(path.join(tmpDir, validName), validBody);

  const app = buildApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(() => resolve()));
  if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('isValidPdfFilename', () => {
  it('accepts legacy screenplay-timestamp filenames', () => {
    expect(isValidPdfFilename('screenplay-1700000000000.pdf')).toBe(true);
    expect(isValidPdfFilename('screenplay-1.pdf')).toBe(true);
  });

  it('accepts descriptive slug filenames', () => {
    expect(isValidPdfFilename('raes-character-sheet-1700000000000.pdf')).toBe(true);
    expect(isValidPdfFilename('beats-1-10-1700000000000.pdf')).toBe(true);
    expect(isValidPdfFilename('full-script-1700000000000.pdf')).toBe(true);
    expect(isValidPdfFilename('act-one-climax-beats-1700000000000.pdf')).toBe(true);
    expect(isValidPdfFilename('full-script-jan-15th-1230pm-est.pdf')).toBe(true);
    expect(isValidPdfFilename('a.pdf')).toBe(true);
  });

  it('accepts a previously-failing simple non-screenplay name (descriptive form)', () => {
    expect(isValidPdfFilename('foo.pdf')).toBe(true);
    expect(isValidPdfFilename('foo-1.pdf')).toBe(true);
  });

  it('rejects path traversal and other unsafe patterns', () => {
    expect(isValidPdfFilename('../etc/passwd')).toBe(false);
    expect(isValidPdfFilename('foo/bar-1.pdf')).toBe(false);
    expect(isValidPdfFilename('screenplay-1.txt')).toBe(false);
    expect(isValidPdfFilename('screenplay-1.PDF')).toBe(false);
    expect(isValidPdfFilename('Screenplay-1.pdf')).toBe(false);
    expect(isValidPdfFilename('-leading-dash-1.pdf')).toBe(false);
    expect(isValidPdfFilename('foo bar.pdf')).toBe(false);
    expect(isValidPdfFilename('')).toBe(false);
    expect(isValidPdfFilename(null)).toBe(false);
  });
});

describe('pdfLink', () => {
  beforeEach(() => {
    config.web.publicBaseUrl = null;
    config.web.port = 3000;
  });

  it('builds a localhost URL when no public base url is set', () => {
    expect(pdfLink('/data/exports/screenplay-1700000000000.pdf')).toBe(
      'http://localhost:3000/pdf/screenplay-1700000000000.pdf',
    );
  });

  it('uses the configured public base url when present', () => {
    config.web.publicBaseUrl = 'https://example.com';
    expect(pdfLink('/data/exports/screenplay-42.pdf')).toBe(
      'https://example.com/pdf/screenplay-42.pdf',
    );
  });

  it('strips trailing slashes from the public base url', () => {
    config.web.publicBaseUrl = 'https://example.com//';
    expect(pdfLink('/x/screenplay-1.pdf')).toBe('https://example.com/pdf/screenplay-1.pdf');
  });

  it('returns null for paths that are not valid screenplay PDFs', () => {
    expect(pdfLink('/x/foo.png')).toBe(null);
    expect(pdfLink(null)).toBe(null);
    expect(pdfLink('')).toBe(null);
  });

  it('accepts a bare filename or a full path', () => {
    expect(pdfLink('screenplay-9.pdf')).toBe('http://localhost:3000/pdf/screenplay-9.pdf');
  });
});

describe('GET /health', () => {
  it('returns 200 OK', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('GET /pdf/:filename', () => {
  it('serves a valid PDF', async () => {
    const res = await fetch(`${baseUrl}/pdf/${validName}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/pdf/);
    const text = await res.text();
    expect(text).toBe(validBody);
  });

  it('returns 400 for invalid filenames', async () => {
    const res = await fetch(`${baseUrl}/pdf/${encodeURIComponent('../etc/passwd')}`);
    expect(res.status).toBe(400);
  });

  it('returns 400 for wrong-pattern filenames', async () => {
    const res = await fetch(`${baseUrl}/pdf/${encodeURIComponent('Foo.pdf')}`);
    expect(res.status).toBe(400);
  });

  it('returns 404 when the file does not exist', async () => {
    const res = await fetch(`${baseUrl}/pdf/screenplay-9999999999999.pdf`);
    expect(res.status).toBe(404);
  });
});

describe('imageLink / attachmentLink', () => {
  beforeEach(() => {
    config.web.publicBaseUrl = null;
    config.web.port = 3000;
  });

  it('builds a localhost URL by default', () => {
    expect(imageLink('a'.repeat(24))).toBe(
      `http://localhost:3000/image/${'a'.repeat(24)}`,
    );
    expect(attachmentLink('b'.repeat(24))).toBe(
      `http://localhost:3000/attachment/${'b'.repeat(24)}`,
    );
  });

  it('uses public base URL when set', () => {
    config.web.publicBaseUrl = 'https://example.com';
    expect(imageLink('c'.repeat(24))).toBe(
      `https://example.com/image/${'c'.repeat(24)}`,
    );
  });

  it('returns null for non-hex24 ids', () => {
    expect(imageLink('not-an-oid')).toBe(null);
    expect(imageLink(null)).toBe(null);
    expect(imageLink('')).toBe(null);
    expect(attachmentLink('zzz')).toBe(null);
  });

  it('accepts ObjectId instances', () => {
    const oid = new ObjectId();
    expect(imageLink(oid)).toBe(`http://localhost:3000/image/${oid.toString()}`);
  });
});

describe('GET /image/:fileId', () => {
  let oid;
  beforeAll(() => {
    oid = new ObjectId();
    imageStore.clear();
    imageStore.set(oid.toString(), {
      _id: oid,
      filename: 'pic.png',
      contentType: 'image/png',
      length: 5,
      _content: Buffer.from('hello'),
    });
  });

  it('serves the file with inline disposition and correct content type', async () => {
    const res = await fetch(`${baseUrl}/image/${oid.toString()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^image\/png/);
    expect(res.headers.get('content-disposition')).toMatch(/^inline; filename="pic\.png"$/);
    expect(await res.text()).toBe('hello');
  });

  it('returns 400 on a non-hex id', async () => {
    const res = await fetch(`${baseUrl}/image/not-an-oid`);
    expect(res.status).toBe(400);
  });

  it('returns 404 when the file is missing', async () => {
    const stranger = new ObjectId();
    const res = await fetch(`${baseUrl}/image/${stranger.toString()}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /attachment/:fileId', () => {
  let oid;
  beforeAll(() => {
    oid = new ObjectId();
    attachmentStore.clear();
    attachmentStore.set(oid.toString(), {
      _id: oid,
      filename: 'audio.ogg',
      contentType: 'audio/ogg',
      length: 7,
      _content: Buffer.from('chunk-1'),
    });
  });

  it('serves the file with attachment disposition and correct content type', async () => {
    const res = await fetch(`${baseUrl}/attachment/${oid.toString()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^audio\/ogg/);
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="audio\.ogg"$/,
    );
    expect(await res.text()).toBe('chunk-1');
  });

  it('returns 400 on a non-hex id', async () => {
    const res = await fetch(`${baseUrl}/attachment/not-an-oid`);
    expect(res.status).toBe(400);
  });

  it('returns 404 when the file is missing', async () => {
    const stranger = new ObjectId();
    const res = await fetch(`${baseUrl}/attachment/${stranger.toString()}`);
    expect(res.status).toBe(404);
  });

  it('sanitizes non-ASCII characters in Content-Disposition filenames', async () => {
    const oidNonAscii = new ObjectId();
    attachmentStore.set(oidNonAscii.toString(), {
      _id: oidNonAscii,
      filename: 'résumé.pdf',
      contentType: 'application/pdf',
      length: 3,
      _content: Buffer.from('ok!'),
    });
    const res = await fetch(`${baseUrl}/attachment/${oidNonAscii.toString()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/filename="r_sum_\.pdf"/);
  });
});
