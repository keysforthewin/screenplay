// Tests for GET /api/export/pdf — the web "Download Screenplay" endpoint that
// wraps the agent's full-screenplay PDF export (exportToPdf with no filters).
//
// We mock auth (no real session), projects (so resolveProject() returns a fixed
// default without a DB), and src/pdf/export.js so the heavy PDF generator is
// replaced by a tiny on-disk file we can stream and assert against. The actual
// PDF rendering is covered by tests/pdf-export-filename.test.js.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../src/web/auth.js', () => ({
  requireSession: () => (_req, _res, next) => next(),
}));

vi.mock('../src/mongo/projects.js', () => ({
  getProjectById: async () => null,
  getDefaultProject: async () => ({
    _id: { toString: () => '000000000000000000000001' },
    title: 'Screenplay',
  }),
  normalizeProjectTitle: (t) => {
    const s = String(t ?? '').trim();
    if (!s) throw new Error('project title must be a non-empty string');
    return s;
  },
  createProject: async () => null,
  getProjectByTitle: async () => null,
  listProjects: async () => [],
  resolveProjectId: async (id) => id,
}));

// Overridable per test; the route handler awaits this.
let exportResult;
const exportCalls = [];
vi.mock('../src/pdf/export.js', () => ({
  exportToPdf: async (opts) => {
    exportCalls.push(opts);
    return exportResult;
  },
  slugifyFilename: (s) =>
    String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'export',
}));

const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server;
let baseUrl;
let pdfPath;

beforeAll(async () => {
  pdfPath = path.join(os.tmpdir(), `test-screenplay-${process.pid}.pdf`);
  fs.writeFileSync(pdfPath, '%PDF-1.4\nFAKE_PDF_BYTES\n%%EOF');
  exportResult = { path: pdfPath };
  const app = express();
  app.use('/api', buildApiRouter());
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(() => resolve()));
  try {
    fs.unlinkSync(pdfPath);
  } catch {
    // ignore
  }
});

describe('GET /api/export/pdf', () => {
  it('streams the full-screenplay PDF as a download attachment', async () => {
    exportResult = { path: pdfPath };
    const res = await fetch(`${baseUrl}/api/export/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/pdf/);
    expect(res.headers.get('content-disposition')).toMatch(/attachment/);
    expect(res.headers.get('content-disposition')).toMatch(/\.pdf/);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.slice(0, 4).toString('ascii')).toBe('%PDF');
    expect(body.toString('binary')).toContain('FAKE_PDF_BYTES');
  });

  it('exports the WHOLE screenplay for the resolved project (no filters)', async () => {
    exportResult = { path: pdfPath };
    exportCalls.length = 0;
    await fetch(`${baseUrl}/api/export/pdf`);
    expect(exportCalls.length).toBe(1);
    const opts = exportCalls[0];
    expect(String(opts.projectId)).toBe('000000000000000000000001');
    expect(opts.characters).toBeFalsy();
    expect(opts.beats_query).toBeFalsy();
    expect(opts.dossier_character).toBeFalsy();
  });

  it('returns a 400 with the message when the export fails', async () => {
    exportResult = { error: 'no beats to export' };
    const res = await fetch(`${baseUrl}/api/export/pdf`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('no beats to export');
  });
});
