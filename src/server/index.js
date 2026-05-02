import express from 'express';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { config } from '../config.js';
import { logger } from '../log.js';
import {
  findImageFile,
  openImageDownloadStream,
} from '../mongo/images.js';
import {
  findAttachmentFile,
  openAttachmentDownloadStream,
} from '../mongo/attachments.js';

const PDF_FILENAME_RE = /^[a-z0-9][a-z0-9-]{0,150}\.pdf$/;
const HEX24_RE = /^[a-f0-9]{24}$/i;

export function isValidPdfFilename(name) {
  return typeof name === 'string' && PDF_FILENAME_RE.test(name);
}

function isHex24(s) {
  return typeof s === 'string' && HEX24_RE.test(s);
}

function publicBase() {
  return (config.web.publicBaseUrl || `http://localhost:${config.web.port}`).replace(/\/+$/, '');
}

function safeContentDispositionFilename(filename) {
  const ascii = String(filename || 'file').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return ascii.slice(0, 200) || 'file';
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

  app.get('/image/:fileId', async (req, res) => {
    const { fileId } = req.params;
    if (!isHex24(fileId)) {
      return res.status(400).send('Invalid id.');
    }
    let file;
    try {
      file = await findImageFile(fileId);
    } catch (e) {
      logger.warn(`web /image lookup failed: ${e.message}`);
      return res.status(500).send('Lookup failed.');
    }
    if (!file) return res.status(404).send('Image not found.');
    const ct = file.contentType || file.metadata?.content_type || 'application/octet-stream';
    const safe = safeContentDispositionFilename(file.filename);
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Disposition', `inline; filename="${safe}"`);
    if (file.length) res.setHeader('Content-Length', String(file.length));
    const stream = openImageDownloadStream(file._id);
    stream.on('error', (err) => {
      logger.warn(`web /image stream error: ${err.message}`);
      if (!res.headersSent) res.status(500);
      res.end();
    });
    stream.pipe(res);
  });

  app.get('/attachment/:fileId', async (req, res) => {
    const { fileId } = req.params;
    if (!isHex24(fileId)) {
      return res.status(400).send('Invalid id.');
    }
    let file;
    try {
      file = await findAttachmentFile(fileId);
    } catch (e) {
      logger.warn(`web /attachment lookup failed: ${e.message}`);
      return res.status(500).send('Lookup failed.');
    }
    if (!file) return res.status(404).send('Attachment not found.');
    const ct = file.contentType || file.metadata?.content_type || 'application/octet-stream';
    const safe = safeContentDispositionFilename(file.filename);
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
    if (file.length) res.setHeader('Content-Length', String(file.length));
    const stream = openAttachmentDownloadStream(file._id);
    stream.on('error', (err) => {
      logger.warn(`web /attachment stream error: ${err.message}`);
      if (!res.headersSent) res.status(500);
      res.end();
    });
    stream.pipe(res);
  });

  return app;
}

export function pdfLink(filepathOrName) {
  if (!filepathOrName) return null;
  const filename = path.basename(String(filepathOrName));
  if (!isValidPdfFilename(filename)) return null;
  return `${publicBase()}/pdf/${filename}`;
}

export function imageLink(fileId) {
  const id = fileId == null ? '' : String(fileId);
  if (!isHex24(id)) return null;
  return `${publicBase()}/image/${id}`;
}

export function attachmentLink(fileId) {
  const id = fileId == null ? '' : String(fileId);
  if (!isHex24(id)) return null;
  return `${publicBase()}/attachment/${id}`;
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
