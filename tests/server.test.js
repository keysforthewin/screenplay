import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from '../src/config.js';
import { buildApp, isValidPdfFilename, pdfLink } from '../src/server/index.js';

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
  it('accepts the screenplay timestamp pattern', () => {
    expect(isValidPdfFilename('screenplay-1700000000000.pdf')).toBe(true);
    expect(isValidPdfFilename('screenplay-1.pdf')).toBe(true);
  });

  it('rejects path traversal and other patterns', () => {
    expect(isValidPdfFilename('../etc/passwd')).toBe(false);
    expect(isValidPdfFilename('screenplay-abc.pdf')).toBe(false);
    expect(isValidPdfFilename('screenplay-1.txt')).toBe(false);
    expect(isValidPdfFilename('foo.pdf')).toBe(false);
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
    const res = await fetch(`${baseUrl}/pdf/foo.pdf`);
    expect(res.status).toBe(400);
  });

  it('returns 404 when the file does not exist', async () => {
    const res = await fetch(`${baseUrl}/pdf/screenplay-9999999999999.pdf`);
    expect(res.status).toBe(404);
  });
});
