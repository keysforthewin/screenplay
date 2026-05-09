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
  addLibraryImageViaGateway,
  addStoryboardReferenceImageViaGateway,
  createDialogViaGateway,
  createStoryboardViaGateway,
  deleteDialogViaGateway,
  deleteStoryboardViaGateway,
  removeBeatAttachmentViaGateway,
  removeBeatImageViaGateway,
  removeCharacterImageViaGateway,
  removeDirectorNoteAttachmentViaGateway,
  removeDirectorNoteImageViaGateway,
  removeDirectorNoteViaGateway,
  removeLibraryImageViaGateway,
  removeStoryboardReferenceImageViaGateway,
  reorderDialogsViaGateway,
  reorderStoryboardsViaGateway,
  setBeatMainImageViaGateway,
  setCharacterMainImageViaGateway,
  setDirectorNoteMainImageViaGateway,
  setStoryboardAudioViaGateway,
  setStoryboardImageViaGateway,
  updateBeatViaGateway,
  updateCharacterViaGateway,
} from './gateway.js';
import { kickoffLibraryVisionSeed } from './libraryVisionWorker.js';
import { getPlot, listBeats, getBeat } from '../mongo/plots.js';
import {
  countStoryboardsByBeat,
  getStoryboard,
  listStoryboards,
} from '../mongo/storyboards.js';
import {
  countDialogsByBeat,
  getDialog,
  listDialogs,
} from '../mongo/dialogs.js';
import { listCharacters, getCharacter, findAllCharacters } from '../mongo/characters.js';
import { getDirectorNotes } from '../mongo/directorNotes.js';
import {
  listLibraryImages,
  imageFileToMeta,
  uploadGeneratedImage,
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
import {
  streamBeatZip,
  streamCharacterZip,
  streamLibraryZip,
  streamNotesZip,
} from './downloads.js';

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

// Synthesize a discordUser-shaped object from the SPA session so token-usage
// rows for web-triggered work attribute to the visitor's username (prefixed
// with `web:` so a Discord user with the same display name doesn't merge).
function webDiscordUser(req) {
  const name = req?.session?.username;
  if (!name) return null;
  return { id: `web:${name}`, displayName: name };
}

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
    const [characters, beatList, notes, storyboardCounts, dialogCounts] =
      await Promise.all([
        listCharacters(),
        listBeats(),
        getDirectorNotes(),
        countStoryboardsByBeat(),
        countDialogsByBeat(),
      ]);
    res.json(
      buildTocResponse(
        characters,
        beatList,
        (notes.notes || []).length,
        storyboardCounts,
        dialogCounts,
      ),
    );
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

  // ── bulk-download endpoints ─────────────────────────────────────────────
  // Stream a zip of all images + attachments for the given scope. Auth is
  // applied by the router-level requireSession() above.

  router.get('/beat/:id/download', async (req, res, next) => {
    try {
      await streamBeatZip(req, res);
    } catch (e) {
      next(e);
    }
  });

  router.get('/character/:id/download', async (req, res, next) => {
    try {
      await streamCharacterZip(req, res);
    } catch (e) {
      next(e);
    }
  });

  router.get('/library/download', async (req, res, next) => {
    try {
      await streamLibraryZip(req, res);
    } catch (e) {
      next(e);
    }
  });

  router.get('/notes/download', async (req, res, next) => {
    try {
      await streamNotesZip(req, res);
    } catch (e) {
      next(e);
    }
  });

  // ── library mutations ────────────────────────────────────────────────────

  router.post('/library/image', upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'file required' });
      const buffer = req.file.buffer;
      const contentType = req.file.mimetype;
      const sniffed = validateImageBuffer(buffer);
      const meta = await uploadGeneratedImage({
        buffer,
        contentType,
        prompt: null,
        generatedBy: null,
        ownerType: null,
        ownerId: null,
        filename: safeFilename(req.file.originalname, `library-${Date.now()}.png`),
      });
      await addLibraryImageViaGateway({ imageMeta: meta });
      res.json({ image: { ...meta, _id: meta._id, content_type: meta.content_type } });
      kickoffLibraryVisionSeed(meta._id, buffer, sniffed || contentType);
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
      await removeLibraryImageViaGateway({ imageId: id });
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

  // ── beat "specifics" tab (web-only) ──────────────────────────────────────
  // Auto-fill empty specifics fields by asking Claude vision about the beat's
  // body/desc/name text and any attached reference images.
  router.post('/beat/:id/specifics/autofill', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const { autofillBeatSpecifics } = await import('./beatSpecificsAutofill.js');
      const result = await autofillBeatSpecifics({ beatId });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  // Generate a UE5 production-grade scene reference sheet from beat.specifics.
  // Caller picks the model (gemini | openai); when `omit_images` is false and
  // the beat has a main_image_id, that image is sent as a reference.
  router.post('/beat/:id/scene-sheet', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const quality = String(req.body?.quality || 'auto');
      if (!['low', 'medium', 'high', 'auto'].includes(quality)) {
        return res.status(400).json({ error: 'invalid quality' });
      }
      const model = String(req.body?.model || 'gemini');
      if (!['gemini', 'openai'].includes(model)) {
        return res.status(400).json({ error: 'invalid model' });
      }
      const omitImages = !!req.body?.omit_images;
      const { generateSceneSheetForBeat } = await import('./beatSceneSheet.js');
      const result = await generateSceneSheetForBeat({
        beatId,
        quality,
        model,
        omitImages,
        discordUser: webDiscordUser(req),
      });
      res.json(result);
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

  // ── character "specifics" tab (web-only) ────────────────────────────────
  // Auto-fill empty specifics fields by asking Claude vision about the
  // character's reference images. Never overwrites non-empty fields.
  router.post('/character/:id/specifics/autofill', async (req, res, next) => {
    try {
      const cid = await resolveCharacterId(req);
      if (!cid) return res.status(404).json({ error: 'character not found' });
      const { autofillCharacterSpecifics } = await import('./specificsAutofill.js');
      const result = await autofillCharacterSpecifics({ characterId: cid });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  // Generate a UE5 MetaHuman-style character sheet from the specifics fields.
  // Caller picks the model (gemini | openai); when `omit_images` is false and
  // the character has a main_image_id, that image is sent as a reference.
  router.post('/character/:id/character-sheet', async (req, res, next) => {
    try {
      const cid = await resolveCharacterId(req);
      if (!cid) return res.status(404).json({ error: 'character not found' });
      const quality = String(req.body?.quality || 'auto');
      if (!['low', 'medium', 'high', 'auto'].includes(quality)) {
        return res.status(400).json({ error: 'invalid quality' });
      }
      const model = String(req.body?.model || 'gemini');
      if (!['gemini', 'openai'].includes(model)) {
        return res.status(400).json({ error: 'invalid model' });
      }
      const omitImages = !!req.body?.omit_images;
      const { generateCharacterSheetForCharacter } = await import('./characterSheet.js');
      const result = await generateCharacterSheetForCharacter({
        characterId: cid,
        quality,
        model,
        omitImages,
        discordUser: webDiscordUser(req),
      });
      res.json(result);
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

  // ── storyboard mutations ────────────────────────────────────────────────

  async function resolveStoryboardId(req) {
    const { id } = req.params;
    if (!isOidHex(id)) return null;
    const sb = await getStoryboard(id);
    return sb?._id?.toString() || null;
  }

  // List all storyboards for a beat. Beat may be referred to by hex id or by
  // beat order (e.g. "2"); we resolve to the beat's _id first.
  router.get('/storyboards', async (req, res, next) => {
    try {
      const beatRef = req.query.beat_id;
      if (beatRef == null || beatRef === '') {
        return res.status(400).json({ error: 'beat_id required' });
      }
      const beat = await getBeat(String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const items = await listStoryboards({ beatId: beat._id });
      res.json({
        beat: {
          _id: beat._id,
          order: beat.order,
          name: beat.name,
          body: beat.body,
          characters: beat.characters || [],
          images: beat.images || [],
          main_image_id: beat.main_image_id || null,
        },
        storyboards: items,
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/storyboards', async (req, res, next) => {
    try {
      const beatRef = req.body?.beat_id;
      if (!beatRef) return res.status(400).json({ error: 'beat_id required' });
      const beat = await getBeat(String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const sb = await createStoryboardViaGateway({
        beatId: beat._id,
        textPrompt: String(req.body?.text_prompt || ''),
      });
      res.json({ storyboard: sb });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/storyboard/:id', async (req, res, next) => {
    try {
      const sbId = await resolveStoryboardId(req);
      if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
      const result = await deleteStoryboardViaGateway({ storyboardId: sbId });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  // Bulk reorder for a single beat. Body: { beat_id, ordered_ids: [hex...] }
  router.post('/storyboards/reorder', async (req, res, next) => {
    try {
      const beatRef = req.body?.beat_id;
      const orderedIds = req.body?.ordered_ids;
      if (!beatRef) return res.status(400).json({ error: 'beat_id required' });
      if (!Array.isArray(orderedIds)) {
        return res.status(400).json({ error: 'ordered_ids must be an array' });
      }
      const beat = await getBeat(String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const result = await reorderStoryboardsViaGateway({
        beatId: beat._id,
        orderedIds,
      });
      res.json({ storyboards: result });
    } catch (e) {
      next(e);
    }
  });

  // Upload a frame image (start_frame|end_frame|character_sheet). The image
  // is owned by the storyboard's beat for GridFS metadata bookkeeping.
  router.post('/storyboard/:id/image', upload.single('file'), async (req, res, next) => {
    try {
      const sbId = await resolveStoryboardId(req);
      if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
      if (!req.file) return res.status(400).json({ error: 'file required' });
      const role = String(req.body?.role || req.query.role || '').trim();
      if (!['start_frame', 'end_frame', 'character_sheet'].includes(role)) {
        return res.status(400).json({ error: 'role must be start_frame|end_frame|character_sheet' });
      }
      validateImageBuffer(req.file.buffer);
      const sb = await getStoryboard(sbId);
      const file = await uploadGeneratedImage({
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
        ownerType: 'beat',
        ownerId: sb.beat_id,
        filename: safeFilename(
          req.file.originalname,
          `storyboard-${sbId}-${role}-${Date.now()}.png`,
        ),
      });
      const result = await setStoryboardImageViaGateway({
        storyboardId: sbId,
        role,
        imageId: file._id,
      });
      res.json({ storyboard: result, image: { _id: file._id, content_type: file.content_type } });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/storyboard/:id/image/:role', async (req, res, next) => {
    try {
      const sbId = await resolveStoryboardId(req);
      if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
      const role = String(req.params.role);
      if (!['start_frame', 'end_frame', 'character_sheet'].includes(role)) {
        return res.status(400).json({ error: 'role must be start_frame|end_frame|character_sheet' });
      }
      const result = await setStoryboardImageViaGateway({
        storyboardId: sbId,
        role,
        imageId: null,
      });
      res.json({ storyboard: result });
    } catch (e) {
      next(e);
    }
  });

  router.post('/storyboard/:id/reference', upload.single('file'), async (req, res, next) => {
    try {
      const sbId = await resolveStoryboardId(req);
      if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
      if (!req.file) return res.status(400).json({ error: 'file required' });
      validateImageBuffer(req.file.buffer);
      const sb = await getStoryboard(sbId);
      const file = await uploadGeneratedImage({
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
        ownerType: 'beat',
        ownerId: sb.beat_id,
        filename: safeFilename(
          req.file.originalname,
          `storyboard-${sbId}-ref-${Date.now()}.png`,
        ),
      });
      const result = await addStoryboardReferenceImageViaGateway({
        storyboardId: sbId,
        imageId: file._id,
      });
      res.json({ storyboard: result, image: { _id: file._id, content_type: file.content_type } });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/storyboard/:id/reference/:imageId', async (req, res, next) => {
    try {
      const sbId = await resolveStoryboardId(req);
      if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
      if (!isOidHex(req.params.imageId)) {
        return res.status(400).json({ error: 'invalid image_id' });
      }
      const result = await removeStoryboardReferenceImageViaGateway({
        storyboardId: sbId,
        imageId: req.params.imageId,
      });
      res.json({ storyboard: result });
    } catch (e) {
      next(e);
    }
  });

  router.post('/storyboard/:id/audio', upload.single('file'), async (req, res, next) => {
    try {
      const sbId = await resolveStoryboardId(req);
      if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
      if (!req.file) return res.status(400).json({ error: 'file required' });
      const ct = req.file.mimetype || 'audio/mpeg';
      if (!ct.startsWith('audio/')) {
        return res.status(400).json({ error: 'file must be audio/*' });
      }
      const sb = await getStoryboard(sbId);
      const file = await uploadAttachmentBuffer({
        buffer: req.file.buffer,
        filename: safeFilename(
          req.file.originalname,
          `storyboard-${sbId}-audio-${Date.now()}.bin`,
        ),
        contentType: ct,
        ownerType: 'beat',
        ownerId: sb.beat_id,
      });
      const result = await setStoryboardAudioViaGateway({
        storyboardId: sbId,
        audioFileId: file._id,
      });
      res.json({
        storyboard: result,
        audio: {
          _id: file._id,
          filename: file.filename,
          content_type: file.content_type,
          size: file.size,
        },
      });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/storyboard/:id/audio', async (req, res, next) => {
    try {
      const sbId = await resolveStoryboardId(req);
      if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
      const result = await setStoryboardAudioViaGateway({
        storyboardId: sbId,
        audioFileId: null,
      });
      res.json({ storyboard: result });
    } catch (e) {
      next(e);
    }
  });

  // Kick off auto-generation for a beat. Runs the generation pipeline in the
  // background so the request returns quickly; the SPA listens for stateless
  // ping broadcasts on storyboards:<beatId> and refetches as items appear.
  router.post('/storyboards/generate', async (req, res, next) => {
    try {
      const beatRef = req.body?.beat_id;
      if (!beatRef) return res.status(400).json({ error: 'beat_id required' });
      const beat = await getBeat(String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const target = Number(req.body?.count) > 0 ? Number(req.body.count) : null;
      const { startStoryboardGenerationJob, BeatBusyError } = await import(
        './storyboardGenerate.js'
      );
      try {
        const jobId = await startStoryboardGenerationJob({
          beatId: beat._id.toString(),
          targetCount: target,
        });
        res.status(202).json({ job_id: jobId, beat_id: beat._id });
      } catch (e) {
        if (e instanceof BeatBusyError) {
          return res.status(409).json({ error: e.message });
        }
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  router.get('/storyboards/generate/:jobId', async (req, res, next) => {
    try {
      const { getStoryboardGenerationJob } = await import('./storyboardGenerate.js');
      const job = getStoryboardGenerationJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'job not found' });
      res.json({ job });
    } catch (e) {
      next(e);
    }
  });

  // Wipe every storyboard for a beat (page-level "Delete all" button).
  router.post('/storyboards/clear', async (req, res, next) => {
    try {
      const beatRef = req.body?.beat_id;
      if (!beatRef) return res.status(400).json({ error: 'beat_id required' });
      const beat = await getBeat(String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const { isBeatLocked } = await import('./beatLocks.js');
      if (isBeatLocked(beat._id)) {
        return res
          .status(409)
          .json({ error: 'Storyboard work in progress for this beat; try again' });
      }
      const { deleteAllStoryboardsForBeatViaGateway } = await import('./gateway.js');
      const result = await deleteAllStoryboardsForBeatViaGateway({ beatId: beat._id });
      res.json({ ...result, beat_id: beat._id.toString() });
    } catch (e) {
      next(e);
    }
  });

  // LLM-driven batch edit. Body: { beat_id, instructions }. Synchronous —
  // returns the new storyboard list once Anthropic + apply have completed.
  router.post('/storyboards/edit', async (req, res, next) => {
    try {
      const beatRef = req.body?.beat_id;
      const instructions = req.body?.instructions;
      if (!beatRef) return res.status(400).json({ error: 'beat_id required' });
      if (!instructions || typeof instructions !== 'string' || !instructions.trim()) {
        return res.status(400).json({ error: 'instructions (non-empty string) required' });
      }
      const beat = await getBeat(String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const { isBeatLocked, withBeatLock } = await import('./beatLocks.js');
      if (isBeatLocked(beat._id)) {
        return res
          .status(409)
          .json({ error: 'Storyboard work in progress for this beat; try again' });
      }
      const { editStoryboard, InvalidOpsError } = await import('./storyboardEdit.js');
      try {
        const result = await withBeatLock(beat._id, () =>
          editStoryboard({ beatId: beat._id, instructions }),
        );
        res.json(result);
      } catch (e) {
        if (e instanceof InvalidOpsError) {
          return res.status(422).json({ error: e.message, details: e.details });
        }
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  // ── dialog mutations ────────────────────────────────────────────────────

  async function resolveDialogId(req) {
    const { id } = req.params;
    if (!isOidHex(id)) return null;
    const d = await getDialog(id);
    return d?._id?.toString() || null;
  }

  router.get('/dialogs', async (req, res, next) => {
    try {
      const beatRef = req.query.beat_id;
      if (beatRef == null || beatRef === '') {
        return res.status(400).json({ error: 'beat_id required' });
      }
      const beat = await getBeat(String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const items = await listDialogs({ beatId: beat._id });
      res.json({
        beat: {
          _id: beat._id,
          order: beat.order,
          name: beat.name,
          body: beat.body,
          characters: beat.characters || [],
        },
        dialogs: items,
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/dialogs', async (req, res, next) => {
    try {
      const beatRef = req.body?.beat_id;
      if (!beatRef) return res.status(400).json({ error: 'beat_id required' });
      const beat = await getBeat(String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const d = await createDialogViaGateway({
        beatId: beat._id,
        body: String(req.body?.body || ''),
        character: String(req.body?.character || ''),
      });
      res.json({ dialog: d });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/dialog/:id', async (req, res, next) => {
    try {
      const dId = await resolveDialogId(req);
      if (!dId) return res.status(404).json({ error: 'dialog not found' });
      const result = await deleteDialogViaGateway({ dialogId: dId });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  // Set the speaker on a dialog item to an existing character. The supplied
  // name must match (case-insensitive on stripMarkdown) a character in the
  // project — the SPA's <CharacterSelect> enforces this client-side, but we
  // re-validate here so the gateway never stores an unknown speaker.
  router.patch('/dialog/:id', async (req, res, next) => {
    try {
      const dId = await resolveDialogId(req);
      if (!dId) return res.status(404).json({ error: 'dialog not found' });
      const { character } = req.body || {};
      if (typeof character !== 'string') {
        return res.status(400).json({ error: 'character (string) required' });
      }
      const { setDialogCharacterViaGateway } = await import('./gateway.js');
      try {
        const dialog = await setDialogCharacterViaGateway({
          dialogId: dId,
          characterName: character,
        });
        res.json({ dialog });
      } catch (e) {
        if (/^No character named|character is required/.test(e.message)) {
          return res.status(400).json({ error: e.message });
        }
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  router.post('/dialogs/reorder', async (req, res, next) => {
    try {
      const beatRef = req.body?.beat_id;
      const orderedIds = req.body?.ordered_ids;
      if (!beatRef) return res.status(400).json({ error: 'beat_id required' });
      if (!Array.isArray(orderedIds)) {
        return res.status(400).json({ error: 'ordered_ids must be an array' });
      }
      const beat = await getBeat(String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const result = await reorderDialogsViaGateway({
        beatId: beat._id,
        orderedIds,
      });
      res.json({ dialogs: result });
    } catch (e) {
      next(e);
    }
  });

  // Kick off auto-extraction for a beat. Runs the generation in the
  // background so the request returns quickly; the SPA listens for stateless
  // ping broadcasts on dialogs:<beatId> and refetches as items appear.
  router.post('/dialogs/generate', async (req, res, next) => {
    try {
      const beatRef = req.body?.beat_id;
      if (!beatRef) return res.status(400).json({ error: 'beat_id required' });
      const beat = await getBeat(String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const { startDialogGenerationJob, BeatBusyError } = await import(
        './dialogGenerate.js'
      );
      try {
        const jobId = await startDialogGenerationJob({
          beatId: beat._id.toString(),
        });
        res.status(202).json({ job_id: jobId, beat_id: beat._id });
      } catch (e) {
        if (e instanceof BeatBusyError) {
          return res.status(409).json({ error: e.message });
        }
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  router.get('/dialogs/generate/:jobId', async (req, res, next) => {
    try {
      const { getDialogGenerationJob } = await import('./dialogGenerate.js');
      const job = getDialogGenerationJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'job not found' });
      res.json({ job });
    } catch (e) {
      next(e);
    }
  });

  // Wipe every dialog for a beat (page-level "Delete all" button).
  router.post('/dialogs/clear', async (req, res, next) => {
    try {
      const beatRef = req.body?.beat_id;
      if (!beatRef) return res.status(400).json({ error: 'beat_id required' });
      const beat = await getBeat(String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const { isBeatLocked } = await import('./beatLocks.js');
      if (isBeatLocked(beat._id)) {
        return res
          .status(409)
          .json({ error: 'Dialog work in progress for this beat; try again' });
      }
      const { deleteAllDialogsForBeatViaGateway } = await import('./gateway.js');
      const result = await deleteAllDialogsForBeatViaGateway({ beatId: beat._id });
      res.json({ ...result, beat_id: beat._id.toString() });
    } catch (e) {
      next(e);
    }
  });

  // LLM-driven batch edit. Body: { beat_id, instructions }. Synchronous —
  // returns the new dialog list once Anthropic + apply have completed.
  router.post('/dialogs/edit', async (req, res, next) => {
    try {
      const beatRef = req.body?.beat_id;
      const instructions = req.body?.instructions;
      if (!beatRef) return res.status(400).json({ error: 'beat_id required' });
      if (!instructions || typeof instructions !== 'string' || !instructions.trim()) {
        return res.status(400).json({ error: 'instructions (non-empty string) required' });
      }
      const beat = await getBeat(String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const { isBeatLocked, withBeatLock } = await import('./beatLocks.js');
      if (isBeatLocked(beat._id)) {
        return res
          .status(409)
          .json({ error: 'Dialog work in progress for this beat; try again' });
      }
      const { editDialog, InvalidOpsError } = await import('./dialogEdit.js');
      try {
        const result = await withBeatLock(beat._id, () =>
          editDialog({ beatId: beat._id, instructions }),
        );
        res.json(result);
      } catch (e) {
        if (e instanceof InvalidOpsError) {
          return res.status(422).json({ error: e.message, details: e.details });
        }
        throw e;
      }
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
