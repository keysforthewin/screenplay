import express from 'express';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { config } from '../config.js';
import { logger } from '../log.js';

const PDF_FILENAME_RE = /^screenplay-\d+\.pdf$/;

export function isValidPdfFilename(name) {
  return typeof name === 'string' && PDF_FILENAME_RE.test(name);
}

export function buildApp() {
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/pdf/:filename', async (req, res) => {
    const { filename } = req.params;
    if (!isValidPdfFilename(filename)) {
      return res.status(400).send('Invalid filename.');
    }
    const filepath = path.join(config.pdf.exportDir, filename);
    try {
      await fsp.access(filepath);
    } catch {
      return res.status(404).send('PDF not found.');
    }
    res.download(filepath, filename);
  });

  return app;
}

export function pdfLink(filepathOrName) {
  if (!filepathOrName) return null;
  const filename = path.basename(String(filepathOrName));
  if (!isValidPdfFilename(filename)) return null;
  const base = config.web.publicBaseUrl || `http://localhost:${config.web.port}`;
  return `${base.replace(/\/+$/, '')}/pdf/${filename}`;
}

export function startServer() {
  const app = buildApp();
  const port = config.web.port;
  const server = app.listen(port, () => {
    const actual = server.address()?.port ?? port;
    logger.info(`Web server listening on port ${actual}`);
  });
  server.on('error', (err) => {
    logger.error(`Web server error: ${err.message}`);
  });
  return server;
}
