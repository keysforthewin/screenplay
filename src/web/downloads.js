// Bulk-download helpers for the SPA. Streams a zip of GridFS files for a beat,
// character, library, or director-notes set. Mounted under /api so the existing
// session middleware applies.
//
// Compression is set to STORE (level 0): images and most attachments are
// already compressed; deflate burns CPU for marginal savings.

import archiver from 'archiver';
import {
  listImagesForBeat,
  listImagesForDirectorNote,
  listLibraryImages,
  openImageDownloadStream,
  findImageFile,
} from '../mongo/images.js';
import {
  listAttachmentsForBeat,
  listAttachmentsForCharacter,
  listAttachmentsForDirectorNote,
  listLibraryAttachments,
  openAttachmentDownloadStream,
  findAttachmentFile,
} from '../mongo/attachments.js';
import { getCharacter } from '../mongo/characters.js';
import { getBeat } from '../mongo/plots.js';
import { getDirectorNotes } from '../mongo/directorNotes.js';
import { stripMarkdown } from '../util/markdown.js';
import { logger } from '../log.js';

const SAFE_NAME_RE = /[\\/:*?"<>|\x00-\x1f]/g;
const HEX24 = /^[a-f0-9]{24}$/i;

function safeSegment(name, fallback) {
  const s = String(name ?? '').trim().replace(SAFE_NAME_RE, '_');
  if (!s) return fallback;
  return s.slice(0, 200);
}

// Make sure each name within a folder is unique. Returns a stable mapping that
// preserves the suffix on rerun for the same input array.
function uniqueNames(items, mkBase) {
  const seen = new Map();
  return items.map((it, i) => {
    const base = mkBase(it, i);
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    let n = seen.get(base) || 0;
    n += 1;
    seen.set(base, n);
    return n === 1 ? base : `${stem}-${n}${ext}`;
  });
}

function appendStream(archive, stream, name) {
  return new Promise((resolve, reject) => {
    // archiver emits 'entry' once the entry is fully drained from the source.
    // Attach the listener BEFORE append() so synchronous tiny streams don't
    // race past us.
    const onEntry = (entry) => {
      if (entry.name === name) {
        archive.removeListener('entry', onEntry);
        resolve();
      }
    };
    archive.on('entry', onEntry);
    stream.on('error', reject);
    archive.append(stream, { name });
  });
}

function safeContentDispositionFilename(filename) {
  const ascii = String(filename || 'file')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  return ascii.slice(0, 200) || 'file';
}

// Streams a zip to the response, calling `addEntries(archive)` to populate it.
async function streamZip(res, downloadName, addEntries) {
  const archive = archiver('zip', { store: true });
  const safeName = safeContentDispositionFilename(downloadName);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  let finalized = false;
  archive.on('warning', (err) => logger.warn(`zip warning: ${err.message}`));
  archive.on('error', (err) => {
    logger.warn(`zip error: ${err.message}`);
    if (!res.headersSent) res.status(500);
    if (!finalized) res.end();
  });
  archive.pipe(res);
  try {
    await addEntries(archive);
  } catch (err) {
    logger.warn(`zip populate error: ${err.message}`);
    archive.abort();
    if (!res.headersSent) res.status(500);
    if (!finalized) res.end();
    return;
  }
  finalized = true;
  await archive.finalize();
}

function isHex24(s) {
  return typeof s === 'string' && HEX24.test(s);
}

function imageFilename(file, fallback) {
  return safeSegment(file.filename, fallback);
}

function attachmentFilename(file, fallback) {
  return safeSegment(file.filename, fallback);
}

async function appendImages(archive, images, folder) {
  const names = uniqueNames(images, (f, i) => imageFilename(f, `image-${i + 1}.bin`));
  for (let i = 0; i < images.length; i += 1) {
    const file = images[i];
    const stream = openImageDownloadStream(file._id);
    await appendStream(archive, stream, `${folder}/${names[i]}`);
  }
}

async function appendAttachments(archive, attachments, folder) {
  const names = uniqueNames(attachments, (f, i) => attachmentFilename(f, `file-${i + 1}.bin`));
  for (let i = 0; i < attachments.length; i += 1) {
    const file = attachments[i];
    const stream = openAttachmentDownloadStream(file._id);
    await appendStream(archive, stream, `${folder}/${names[i]}`);
  }
}

// ── public entry points used by entityRoutes.js ─────────────────────────────

export async function streamBeatZip(req, res) {
  const idOrOrder = req.params.id;
  const beat = await getBeat(idOrOrder);
  if (!beat) return res.status(404).json({ error: 'beat not found' });

  const beatIdHex = beat._id.toString();
  const [images, attachments] = await Promise.all([
    listImagesForBeat(beatIdHex),
    listAttachmentsForBeat(beatIdHex),
  ]);

  const labelSrc = stripMarkdown(beat.name || '') || `beat-${beat.order}`;
  const label = safeSegment(labelSrc, `beat-${beat.order}`);
  const downloadName = `${label}.zip`;

  await streamZip(res, downloadName, async (archive) => {
    await appendImages(archive, images, 'images');
    await appendAttachments(archive, attachments, 'attachments');
  });
}

export async function streamCharacterZip(req, res) {
  const idOrName = req.params.id;
  const character = await getCharacter(idOrName);
  if (!character) return res.status(404).json({ error: 'character not found' });

  const cidHex = character._id.toString();
  // Reuse the character's embedded images[] array for consistent ordering and
  // the listAttachmentsForCharacter helper for attachments.
  const imageMetas = Array.isArray(character.images) ? character.images : [];
  const imageFiles = (
    await Promise.all(
      imageMetas.map(async (m) => {
        const id = m && m._id ? m._id.toString?.() || String(m._id) : null;
        if (!isHex24(id)) return null;
        const file = await findImageFile(id);
        return file || null;
      }),
    )
  ).filter(Boolean);

  const attachments = await listAttachmentsForCharacter(cidHex);

  const labelSrc = stripMarkdown(character.name || '') || `character-${cidHex}`;
  const label = safeSegment(labelSrc, `character-${cidHex}`);
  const downloadName = `${label}.zip`;

  await streamZip(res, downloadName, async (archive) => {
    await appendImages(archive, imageFiles, 'images');
    await appendAttachments(archive, attachments, 'attachments');
  });
}

export async function streamLibraryZip(_req, res) {
  const [images, attachments] = await Promise.all([
    listLibraryImages(),
    listLibraryAttachments(),
  ]);

  await streamZip(res, 'library.zip', async (archive) => {
    await appendImages(archive, images, 'images');
    await appendAttachments(archive, attachments, 'attachments');
  });
}

export async function streamNotesZip(_req, res) {
  const { notes = [] } = await getDirectorNotes();

  // Per-note folders: notes/<index>-<short-id>/{images,attachments}
  const folderNames = uniqueNames(notes, (n, i) => {
    const shortId = String(n._id || '').slice(-6) || `note-${i + 1}`;
    const idx = String(i + 1).padStart(3, '0');
    return `${idx}-${shortId}`;
  });

  await streamZip(res, 'director-notes.zip', async (archive) => {
    for (let i = 0; i < notes.length; i += 1) {
      const note = notes[i];
      const noteIdHex = String(note._id || '');
      const folder = `notes/${folderNames[i]}`;
      const [images, attachments] = await Promise.all([
        isHex24(noteIdHex) ? listImagesForDirectorNote(noteIdHex) : [],
        isHex24(noteIdHex) ? listAttachmentsForDirectorNote(noteIdHex) : [],
      ]);
      if (images.length === 0 && attachments.length === 0) continue;
      await appendImages(archive, images, `${folder}/images`);
      await appendAttachments(archive, attachments, `${folder}/attachments`);
    }
  });
}
