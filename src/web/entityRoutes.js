// REST routes for the SPA. All require a valid session via X-Session-Id header.
//
// Reads are direct Mongo lookups (no gateway involvement).
// Mutations go through src/web/gateway.js so the y-doc and stateless ping fire.

import express from 'express';
import multer from 'multer';
import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../log.js';
import { requireSession } from './auth.js';
import {
  addBeatImageViaGateway,
  addBeatAttachmentViaGateway,
  addCharacterImageViaGateway,
  addDirectorNoteAttachmentViaGateway,
  addDirectorNoteImageViaGateway,
  addDirectorNoteViaGateway,
  removeBeatAttachmentViaGateway,
  removeBeatImageViaGateway,
  removeCharacterImageViaGateway,
  removeDirectorNoteAttachmentViaGateway,
  removeDirectorNoteImageViaGateway,
  removeDirectorNoteViaGateway,
  setBeatMainImageViaGateway,
  setCharacterMainImageViaGateway,
  setDirectorNoteMainImageViaGateway,
  updateBeatViaGateway,
  updateCharacterViaGateway,
} from './gateway.js';
import { getPlot, listBeats, getBeat } from '../mongo/plots.js';
import { listCharacters, getCharacter, findAllCharacters } from '../mongo/characters.js';
import { getDirectorNotes } from '../mongo/directorNotes.js';
import {
  listLibraryImages,
  imageFileToMeta,
  uploadGeneratedImage,
  deleteImage,
  findImageFile,
} from '../mongo/images.js';
import { validateImageBuffer } from '../mongo/imageBytes.js';
import {
  listLibraryAttachments,
  attachmentFileToMeta,
  uploadAttachmentBuffer,
  deleteAttachment,
  findAttachmentFile,
} from '../mongo/attachments.js';
import { getCharacterTemplate, getPlotTemplate } from '../mongo/prompts.js';
import { stripMarkdown } from '../util/markdown.js';
import { buildTocResponse } from './toc.js';

const HEX24 = /^[a-f0-9]{24}$/i;

function isOidHex(s) {
  return typeof s === 'string' && HEX24.test(s);
}

function safeFilename(name, fallback) {
  const s = String(name || '').trim();
  if (!s) return fallback;
  return s.replace(/[\\/]+/g, '_').slice(0, 200);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

export function buildApiRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));
  router.use(requireSession());

  // Connection metadata for the SPA so it knows where to open WebSockets.
  router.get('/info', async (_req, res) => {
    const wsUrl =
      config.web.hocuspocusPublicUrl ||
      `ws://${'localhost'}:${config.web.hocuspocusPort}`;
    const plot = await getPlot();
    res.json({
      hocuspocus_url: wsUrl,
      bot_color: config.web.botColor,
      screenplay_title: stripMarkdown(plot?.title || ''),
    });
  });

  // ── reads ────────────────────────────────────────────────────────────────

  router.get('/toc', async (_req, res) => {
    const [characters, beatList, notes] = await Promise.all([
      listCharacters(),
      listBeats(),
      getDirectorNotes(),
    ]);
    res.json(buildTocResponse(characters, beatList, (notes.notes || []).length));
  });

  router.get('/template', async (_req, res) => {
    const [character_template, plot_template] = await Promise.all([
      getCharacterTemplate(),
      getPlotTemplate(),
    ]);
    res.json({
      character_template: character_template || { fields: [] },
      plot_template: plot_template || {},
    });
  });

  router.get('/beat', async (req, res) => {
    const { order, id } = req.query;
    let beat = null;
    if (id && isOidHex(String(id))) {
      beat = await getBeat(String(id));
    } else if (order != null) {
      beat = await getBeat(String(order));
    }
    if (!beat) return res.status(404).json({ error: 'beat not found' });
    res.json({ beat });
  });

  router.get('/character', async (req, res) => {
    const name = String(req.query.name || '');
    if (!name) return res.status(400).json({ error: 'name required' });
    const c = await getCharacter(name);
    if (!c) return res.status(404).json({ error: 'character not found' });
    res.json({ character: c });
  });

  router.get('/notes', async (_req, res) => {
    const doc = await getDirectorNotes();
    res.json({
      notes: (doc.notes || []).map((n) => ({
        _id: n._id,
        text: n.text,
        images: n.images || [],
        main_image_id: n.main_image_id || null,
        attachments: n.attachments || [],
        created_at: n.created_at || null,
      })),
    });
  });

  router.get('/library', async (_req, res) => {
    const [images, attachments] = await Promise.all([
      listLibraryImages(),
      listLibraryAttachments(),
    ]);
    res.json({
      images: images.map(imageFileToMeta),
      attachments: attachments.map(attachmentFileToMeta),
    });
  });

  // ── library mutations ────────────────────────────────────────────────────

  router.post('/library/image', upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'file required' });
      const buffer = req.file.buffer;
      const contentType = req.file.mimetype;
      validateImageBuffer(buffer);
      const meta = await uploadGeneratedImage({
        buffer,
        contentType,
        prompt: null,
        generatedBy: null,
        ownerType: null,
        ownerId: null,
        filename: safeFilename(req.file.originalname, `library-${Date.now()}.png`),
      });
      res.json({ image: { ...meta, _id: meta._id, content_type: meta.content_type } });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/library/image/:id', async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!isOidHex(id)) return res.status(400).json({ error: 'invalid id' });
      const file = await findImageFile(id);
      if (!file) return res.status(404).json({ error: 'not found' });
      if (file.metadata?.owner_type !== null && file.metadata?.owner_type !== undefined) {
        return res.status(409).json({ error: 'image is attached to an entity' });
      }
      await deleteImage(id);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.post('/library/attachment', upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'file required' });
      const meta = await uploadAttachmentBuffer({
        buffer: req.file.buffer,
        filename: safeFilename(req.file.originalname, `attachment-${Date.now()}.bin`),
        contentType: req.file.mimetype,
      });
      res.json({ attachment: meta });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/library/attachment/:id', async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!isOidHex(id)) return res.status(400).json({ error: 'invalid id' });
      const file = await findAttachmentFile(id);
      if (!file) return res.status(404).json({ error: 'not found' });
      if (file.metadata?.owner_type !== null && file.metadata?.owner_type !== undefined) {
        return res.status(409).json({ error: 'attachment is attached to an entity' });
      }
      await deleteAttachment(id);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ── beat mutations (non-text) ────────────────────────────────────────────

  async function resolveBeatId(req) {
    const { id } = req.params;
    if (isOidHex(id)) return id;
    const beat = await getBeat(id);
    return beat?._id?.toString() || null;
  }

  router.post('/beat/:id/image', upload.single('file'), async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      if (!req.file) return res.status(400).json({ error: 'file required' });
      validateImageBuffer(req.file.buffer);
      const file = await uploadGeneratedImage({
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
        ownerType: 'beat',
        ownerId: beatId,
        filename: safeFilename(req.file.originalname, `beat-${beatId}-${Date.now()}.png`),
      });
      const setAsMain = req.body?.set_as_main === 'true' || req.query.set_as_main === '1';
      const result = await addBeatImageViaGateway({
        beatId,
        imageMeta: {
          _id: file._id,
          filename: file.filename,
          content_type: file.content_type,
          size: file.size,
          source: 'upload',
          uploaded_at: file.uploaded_at,
        },
        setAsMain,
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  router.delete('/beat/:id/image/:imageId', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const result = await removeBeatImageViaGateway({ beatId, imageId: req.params.imageId });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  router.post('/beat/:id/main-image', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const imageId = req.body?.image_id;
      if (!isOidHex(String(imageId))) return res.status(400).json({ error: 'image_id required' });
      const result = await setBeatMainImageViaGateway({ beatId, imageId });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  router.post('/beat/:id/attachment', upload.single('file'), async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      if (!req.file) return res.status(400).json({ error: 'file required' });
      const file = await uploadAttachmentBuffer({
        buffer: req.file.buffer,
        filename: safeFilename(req.file.originalname, `attach-${Date.now()}.bin`),
        contentType: req.file.mimetype,
        ownerType: 'beat',
        ownerId: beatId,
      });
      const result = await addBeatAttachmentViaGateway({
        beatId,
        attachmentMeta: {
          _id: file._id,
          filename: file.filename,
          content_type: file.content_type,
          size: file.size,
          caption: req.body?.caption || null,
          uploaded_at: file.uploaded_at,
        },
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  router.delete('/beat/:id/attachment/:attachId', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const result = await removeBeatAttachmentViaGateway({
        beatId,
        attachmentId: req.params.attachId,
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  router.patch('/beat/:id', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const { characters, order } = req.body || {};
      const patch = {};
      if (Array.isArray(characters)) patch.characters = characters;
      if (typeof order === 'number') patch.order = order;
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'no patch fields' });
      const result = await updateBeatViaGateway(beatId, patch);
      res.json({ beat: result });
    } catch (e) {
      next(e);
    }
  });

  // ── character mutations (non-text) ───────────────────────────────────────

  async function resolveCharacterId(req) {
    const { id } = req.params;
    if (isOidHex(id)) return id;
    const c = await getCharacter(id);
    return c?._id?.toString() || null;
  }

  router.post('/character/:id/image', upload.single('file'), async (req, res, next) => {
    try {
      const cid = await resolveCharacterId(req);
      if (!cid) return res.status(404).json({ error: 'character not found' });
      if (!req.file) return res.status(400).json({ error: 'file required' });
      validateImageBuffer(req.file.buffer);
      const file = await uploadGeneratedImage({
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
        ownerType: 'character',
        ownerId: cid,
        filename: safeFilename(req.file.originalname, `character-${cid}-${Date.now()}.png`),
      });
      const setAsMain = req.body?.set_as_main === 'true' || req.query.set_as_main === '1';
      const result = await addCharacterImageViaGateway({
        character: cid,
        imageMeta: {
          _id: file._id,
          filename: file.filename,
          content_type: file.content_type,
          size: file.size,
          uploaded_at: file.uploaded_at,
          caption: req.body?.caption || null,
        },
        setAsMain,
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  router.delete('/character/:id/image/:imageId', async (req, res, next) => {
    try {
      const cid = await resolveCharacterId(req);
      if (!cid) return res.status(404).json({ error: 'character not found' });
      const result = await removeCharacterImageViaGateway({
        character: cid,
        imageId: req.params.imageId,
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  router.post('/character/:id/main-image', async (req, res, next) => {
    try {
      const cid = await resolveCharacterId(req);
      if (!cid) return res.status(404).json({ error: 'character not found' });
      const imageId = req.body?.image_id;
      if (!isOidHex(String(imageId))) return res.status(400).json({ error: 'image_id required' });
      const result = await setCharacterMainImageViaGateway({ character: cid, imageId });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  router.patch('/character/:id', async (req, res, next) => {
    try {
      const cid = await resolveCharacterId(req);
      if (!cid) return res.status(404).json({ error: 'character not found' });
      const { plays_self, own_voice } = req.body || {};
      const patch = {};
      if (typeof plays_self === 'boolean') patch.plays_self = plays_self;
      if (typeof own_voice === 'boolean') patch.own_voice = own_voice;
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'no patch fields' });
      const result = await updateCharacterViaGateway(cid, patch);
      res.json({ character: result });
    } catch (e) {
      next(e);
    }
  });

  // ── notes mutations (non-text) ───────────────────────────────────────────

  router.post('/notes', async (req, res, next) => {
    try {
      const text = String(req.body?.text || '').trim() || '_New note_';
      const note = await addDirectorNoteViaGateway({ text });
      res.json({ note });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/notes/:noteId', async (req, res, next) => {
    try {
      if (!isOidHex(req.params.noteId)) return res.status(400).json({ error: 'invalid id' });
      await removeDirectorNoteViaGateway({ noteId: req.params.noteId });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.post('/notes/:noteId/image', upload.single('file'), async (req, res, next) => {
    try {
      if (!isOidHex(req.params.noteId)) return res.status(400).json({ error: 'invalid id' });
      if (!req.file) return res.status(400).json({ error: 'file required' });
      validateImageBuffer(req.file.buffer);
      const file = await uploadGeneratedImage({
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
        ownerType: 'director_note',
        ownerId: req.params.noteId,
        filename: safeFilename(req.file.originalname, `note-${req.params.noteId}-${Date.now()}.png`),
      });
      const setAsMain = req.body?.set_as_main === 'true' || req.query.set_as_main === '1';
      const result = await addDirectorNoteImageViaGateway({
        noteId: req.params.noteId,
        imageMeta: {
          _id: file._id,
          filename: file.filename,
          content_type: file.content_type,
          size: file.size,
          uploaded_at: file.uploaded_at,
        },
        setAsMain,
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  router.delete('/notes/:noteId/image/:imageId', async (req, res, next) => {
    try {
      const result = await removeDirectorNoteImageViaGateway({
        noteId: req.params.noteId,
        imageId: req.params.imageId,
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  router.post('/notes/:noteId/main-image', async (req, res, next) => {
    try {
      const imageId = req.body?.image_id;
      if (!isOidHex(String(imageId))) return res.status(400).json({ error: 'image_id required' });
      const result = await setDirectorNoteMainImageViaGateway({
        noteId: req.params.noteId,
        imageId,
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  router.post('/notes/:noteId/attachment', upload.single('file'), async (req, res, next) => {
    try {
      if (!isOidHex(req.params.noteId)) return res.status(400).json({ error: 'invalid id' });
      if (!req.file) return res.status(400).json({ error: 'file required' });
      const file = await uploadAttachmentBuffer({
        buffer: req.file.buffer,
        filename: safeFilename(req.file.originalname, `note-attach-${Date.now()}.bin`),
        contentType: req.file.mimetype,
        ownerType: 'director_note',
        ownerId: req.params.noteId,
      });
      const result = await addDirectorNoteAttachmentViaGateway({
        noteId: req.params.noteId,
        attachmentMeta: {
          _id: file._id,
          filename: file.filename,
          content_type: file.content_type,
          size: file.size,
          caption: req.body?.caption || null,
          uploaded_at: file.uploaded_at,
        },
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  router.delete('/notes/:noteId/attachment/:attachId', async (req, res, next) => {
    try {
      const result = await removeDirectorNoteAttachmentViaGateway({
        noteId: req.params.noteId,
        attachmentId: req.params.attachId,
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  // ── error handler ────────────────────────────────────────────────────────

  router.use((err, _req, res, _next) => {
    logger.warn(`api error: ${err.message}`);
    if (res.headersSent) return;
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'internal' });
  });

  return router;
}
