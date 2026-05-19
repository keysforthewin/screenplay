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
import { ALLOWED_IMAGE_MODELS } from './imageReplaceDispatch.js';

// Default model the SPA falls back to when the request omits `image_model`/`model`.
// Old enum values (`gemini`, `fal`) from cached SPA bundles are normalized to the
// closest current equivalent so we don't 400 on stale clients.
const DEFAULT_IMAGE_MODEL = 'nano-banana-pro';
function normalizeImageModel(raw) {
  const v = String(raw ?? DEFAULT_IMAGE_MODEL);
  if (v === 'gemini' || v === 'google') return 'nano-banana-pro';
  if (v === 'fal') return 'flux-pro-kontext';
  return v;
}
function isValidImageModel(v) {
  return ALLOWED_IMAGE_MODELS.includes(v);
}
const IMAGE_MODEL_ERROR = `image_model must be one of: ${ALLOWED_IMAGE_MODELS.join('|')}`;
import { getSession, touchSession } from '../mongo/auth.js';
import {
  announceBeatMedia,
  announceCharacterMedia,
  announceNoteMedia,
  announceStoryboardMedia,
  announceLibraryMedia,
  announceBatchSummary,
} from './announceHelpers.js';
import {
  startVideoGenerationJob,
  getVideoGenerationJob,
  subscribeToJob,
  unsubscribeFromJob,
  serializeJob,
  buildVideoPayloadPreview,
  VideoBeatBusyError,
  MissingInputsError,
  FalNotConfiguredError,
  UnknownVideoModelError,
} from './falVideoGenerate.js';
import {
  addBeatImageViaGateway,
  addBeatAttachmentViaGateway,
  addCharacterAttachmentViaGateway,
  addCharacterImageViaGateway,
  addDirectorNoteAttachmentViaGateway,
  addDirectorNoteImageViaGateway,
  addDirectorNoteViaGateway,
  addLibraryImageViaGateway,
  addStoryboardFrameReferenceImageViaGateway,
  attachExistingAttachmentToBeatViaGateway,
  attachExistingAttachmentToCharacterViaGateway,
  attachExistingAttachmentToDirectorNoteViaGateway,
  attachExistingImageToBeatViaGateway,
  attachExistingImageToCharacterViaGateway,
  attachExistingImageToDirectorNoteViaGateway,
  copyDialogAudioToStoryboardViaGateway,
  createDialogViaGateway,
  createStoryboardViaGateway,
  deleteDialogViaGateway,
  deleteStoryboardViaGateway,
  removeBeatAttachmentViaGateway,
  removeBeatImageViaGateway,
  removeCharacterAttachmentViaGateway,
  removeCharacterImageViaGateway,
  removeDirectorNoteAttachmentViaGateway,
  removeDirectorNoteImageViaGateway,
  removeDirectorNoteViaGateway,
  removeLibraryImageViaGateway,
  removeStoryboardFrameReferenceImageViaGateway,
  replaceBeatImageViaGateway,
  replaceCharacterImageViaGateway,
  moveBeatImageToLibraryViaGateway,
  moveCharacterImageToLibraryViaGateway,
  reorderDialogsViaGateway,
  reorderStoryboardsViaGateway,
  setBeatMainImageViaGateway,
  setCharacterMainImageViaGateway,
  setDirectorNoteMainImageViaGateway,
  setDialogAudioViaGateway,
  setOwnedImageMetaViaGateway,
  setStoryboardAudioViaGateway,
  setStoryboardFramePromptViaGateway,
  setStoryboardFrameReferenceImagesViaGateway,
  setStoryboardImageViaGateway,
  setStoryboardVideoViaGateway,
  undoStoryboardFrameEditViaGateway,
  updateBeatViaGateway,
  updateStoryboardScalarsViaGateway,
} from './gateway.js';
import {
  kickoffLibraryVisionSeed,
  kickoffImageVisionSeed,
} from './libraryVisionWorker.js';
import { getPlot, listBeats, getBeat } from '../mongo/plots.js';
import {
  startGenerateArtworkJob,
  startRegenerateArtworkJob,
  startEditArtworkJob,
  undoArtworkEdit,
  deleteArtwork,
} from './artworkJobs.js';
import { patchArtworkViaGateway } from './gateway.js';
import {
  countStoryboardsByBeat,
  getPreviousStoryboardInBeat,
  getStoryboard,
  listStoryboards,
} from '../mongo/storyboards.js';
import {
  grabStartFrameFromPrevious,
  FfmpegMissingError,
  FfmpegFailedError,
} from './storyboardGrabFrame.js';
import {
  countDialogsByBeat,
  getDialog,
  listDialogs,
} from '../mongo/dialogs.js';
import { listCharacters, getCharacter, findAllCharacters } from '../mongo/characters.js';
import { getDirectorNotes } from '../mongo/directorNotes.js';
import {
  deleteImage,
  listLibraryImages,
  listImagesForBeat,
  listImagesByOwnerType,
  imageFileToMeta,
  uploadGeneratedImage,
  findImageFile,
  readImageBuffer,
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
import { collectStoryboardReferenceIds } from './storyboardReferenceAggregator.js';
import { buildTocResponse } from './toc.js';
import {
  streamBeatZip,
  streamCharacterZip,
  streamLibraryZip,
  streamNotesZip,
} from './downloads.js';

const HEX24 = /^[a-f0-9]{24}$/i;

// Sentinel returned by the resolution/fps validators when they've already
// sent a 400. Callers check `=== ERR` and bail out of the route.
const ERR = Symbol('input-validation-error');

const RESOLUTION_RE = /^[A-Za-z0-9_]{1,24}$/;

// Validate a `resolution` body field on the /video/preview and
// /video/generate routes. Returns the trimmed string, null when absent,
// or the ERR sentinel after writing a 400 to `res`.
function parseResolutionField(raw, res) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') {
    res.status(400).json({ error: 'resolution must be a string' });
    return ERR;
  }
  const trimmed = raw.trim();
  if (!RESOLUTION_RE.test(trimmed)) {
    res.status(400).json({ error: 'resolution must be a short alphanumeric tag like "720p"' });
    return ERR;
  }
  return trimmed;
}

// Validate an `fps` body field. Returns an integer in [1, 120], null
// when absent, or ERR after a 400.
function parseFpsField(raw, res) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 120) {
    res.status(400).json({ error: 'fps must be a number between 1 and 120' });
    return ERR;
  }
  return Math.round(n);
}

function isOidHex(s) {
  return typeof s === 'string' && HEX24.test(s);
}

function safeFilename(name, fallback) {
  const s = String(name || '').trim();
  if (!s) return fallback;
  return s.replace(/[\\/]+/g, '_').slice(0, 200);
}

// Validate + load reference images from the request body. Returns
// { ids, images } on success; { error } when any id is malformed or missing.
// Callers should respond with 400/404 on error and pass `images` to
// dispatchImageReplace's referenceImages param.
async function loadReferenceImages(rawIds) {
  if (rawIds == null) return { ids: [], images: [], error: null };
  if (!Array.isArray(rawIds)) {
    return { ids: [], images: [], error: 'reference_image_ids must be an array' };
  }
  const ids = rawIds.map((x) => String(x || '').trim()).filter(Boolean);
  for (const id of ids) {
    if (!isOidHex(id)) {
      return { ids: [], images: [], error: `reference_image_ids: ${id} is not a 24-hex string` };
    }
  }
  const images = [];
  for (const id of ids) {
    const r = await readImageBuffer(id);
    if (!r) {
      return { ids: [], images: [], error: `reference image ${id} not found`, status: 404 };
    }
    const declared = r.file.contentType || r.file.metadata?.contentType || null;
    images.push({ buffer: r.buffer, contentType: declared || 'image/png' });
  }
  return { ids, images, error: null };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

// Duplicate a source GridFS image into a brand-new file owned by the target
// entity. Used by the picker modal's "Character"/"Beats" tabs so cross-entity
// picks don't disturb the source. Returns the embedded-gallery meta entry
// (matches the shape the add*ImageViaGateway helpers expect).
async function copyImageToNewOwner({ imageId, ownerType, ownerId, filenameBase }) {
  const src = await readImageBuffer(imageId);
  if (!src) {
    const e = new Error(`source image not found: ${imageId}`);
    e.status = 404;
    throw e;
  }
  const { buffer, file } = src;
  const contentType = file.contentType || file.metadata?.content_type || 'image/png';
  const ext = (() => {
    if (contentType.includes('jpeg')) return 'jpg';
    if (contentType.includes('webp')) return 'webp';
    return 'png';
  })();
  const newFile = await uploadGeneratedImage({
    buffer,
    contentType,
    ownerType,
    ownerId,
    filename: `${filenameBase}-${Date.now()}.${ext}`,
    prompt: file.metadata?.prompt || null,
    generatedBy: file.metadata?.generated_by || null,
    name: file.metadata?.name || '',
    description: file.metadata?.description || '',
  });
  return {
    _id: newFile._id,
    filename: newFile.filename,
    content_type: newFile.content_type,
    size: newFile.size,
    source: file.metadata?.source || 'upload',
    prompt: newFile.metadata?.prompt || null,
    generated_by: newFile.metadata?.generated_by || null,
    uploaded_at: newFile.uploaded_at,
  };
}

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

  // Server-Sent Events stream of fal video-generation job status. Registered
  // BEFORE requireSession() because EventSource cannot set custom headers —
  // so this route validates a session id from the query string instead.
  router.get('/storyboard/:id/video-job/:jobId/events', async (req, res, next) => {
    try {
      const sid = String(req.query?.session_id || '');
      if (!sid) {
        res.status(401).json({ error: 'missing session' });
        return;
      }
      const session = await getSession(sid);
      if (!session) {
        res.status(401).json({ error: 'invalid session' });
        return;
      }
      touchSession(sid).catch(() => {});
      req.session = session;

      const job = getVideoGenerationJob(req.params.jobId);
      if (!job) {
        res.status(404).json({ error: 'job not found' });
        return;
      }
      // SSE preamble. flushHeaders ensures the browser opens the stream
      // immediately rather than waiting for the first body bytes.
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      // Initial snapshot so the SPA renders state immediately on connect.
      res.write(`event: snapshot\ndata: ${JSON.stringify(serializeJob(job))}\n\n`);

      const listener = (snap) => {
        const terminal = snap.status === 'done' || snap.status === 'error';
        const eventName = terminal ? snap.status : 'update';
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(snap)}\n\n`);
        if (terminal) {
          unsubscribeFromJob(snap.job_id, listener);
          res.end();
        }
      };
      subscribeToJob(req.params.jobId, listener);

      // If the job is already terminal at connect time, close after the
      // snapshot — no further events will fire.
      if (job.status === 'done' || job.status === 'error') {
        unsubscribeFromJob(req.params.jobId, listener);
        res.end();
        return;
      }

      // Periodic SSE comment to keep proxies from idling the socket.
      const keepalive = setInterval(() => {
        res.write(`: keepalive ${Date.now()}\n\n`);
      }, 20_000);
      keepalive.unref?.();

      req.on('close', () => {
        clearInterval(keepalive);
        unsubscribeFromJob(req.params.jobId, listener);
      });
    } catch (e) {
      next(e);
    }
  });

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
    // findAllCharacters (not listCharacters) — we need fields.{...} content for
    // the deep filter to match on description/body-style template fields.
    // listDialogs() / listStoryboards() unfiltered return every row; we group
    // them per beat in buildTocResponse to back the dialog/storyboard tab
    // filter without forcing N+1 round trips here.
    const [characters, beatList, notes, storyboardCounts, dialogCounts, allDialogs, allStoryboards] =
      await Promise.all([
        findAllCharacters(),
        listBeats(),
        getDirectorNotes(),
        countStoryboardsByBeat(),
        countDialogsByBeat(),
        listDialogs(),
        listStoryboards(),
      ]);
    res.json(
      buildTocResponse(
        characters,
        beatList,
        (notes.notes || []).length,
        storyboardCounts,
        dialogCounts,
        { allDialogs, allStoryboards },
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

  // Lazy backfill: kick off the vision worker for any owned image whose
  // GridFS metadata has neither name nor description set. Fire-and-forget;
  // the worker dedups in-flight ids itself.
  async function backfillOwnedImageCaptions(ownerType, ownerId, images) {
    const ids = (images || []).map((i) => i._id?.toString?.()).filter(Boolean);
    if (!ids.length) return;
    const files = await Promise.all(ids.map((id) => findImageFile(id).catch(() => null)));
    for (let i = 0; i < ids.length; i += 1) {
      const file = files[i];
      if (!file) continue;
      const hasName = !!(file.metadata?.name || '').trim();
      const hasDesc = !!(file.metadata?.description || '').trim();
      if (hasName || hasDesc) continue;
      kickoffImageVisionSeed(ids[i], null, null, { ownerType, ownerId });
    }
  }

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
    backfillOwnedImageCaptions('beat', beat._id?.toString?.(), beat.images).catch(() => {});
  });

  // Resolve every character named in a beat to its current Mongo doc, with
  // per-character sheet metadata so the storyboard page can render a
  // pre-generation sheet picker. Uses the same name-resolution path as the
  // storyboard renderer (findCharactersInBeat) — so the dropdown reflects
  // exactly what generation will pick up.
  router.get('/beat/:id/characters', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const beat = await getBeat(beatId);
      const { findCharactersInBeat } = await import('./storyboardGenerate.js');
      const docs = await findCharactersInBeat(beat);
      const out = [];
      for (const c of docs) {
        const sheetIds = Array.isArray(c.character_sheet_image_ids)
          ? c.character_sheet_image_ids
          : c.character_sheet_image_id
            ? [c.character_sheet_image_id]
            : [];
        const sheets = [];
        for (const sid of sheetIds) {
          const file = await findImageFile(sid);
          sheets.push({
            _id: String(sid),
            name: file?.metadata?.name || '',
            content_type: file?.contentType || null,
          });
        }
        out.push({
          _id: c._id.toString(),
          name: stripMarkdown(c.name || ''),
          main_image_id: c.main_image_id ? c.main_image_id.toString() : null,
          sheets,
          hollywood_actor:
            typeof c.hollywood_actor === 'string' ? c.hollywood_actor : null,
          fields: c.fields && typeof c.fields === 'object' ? c.fields : {},
        });
      }
      res.json({ characters: out });
    } catch (e) {
      next(e);
    }
  });

  // All "done" artworks reachable from this beat — used by the Storyboard
  // start/end frame picker's Artwork tab. Combines the beat's own artworks
  // with the artworks of every character listed in beat.characters[], so the
  // user can pick a character portrait or beat moodboard as the frame image
  // in a single click. Pending/error artworks are filtered out.
  router.get('/beat/:id/scene-artworks', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const beat = await getBeat(beatId);
      const { findCharactersInBeat } = await import('./storyboardGenerate.js');
      const charDocs = await findCharactersInBeat(beat);

      const items = [];
      const seen = new Set(); // dedupe by result_image_id

      // Beat-owned artworks first.
      for (const a of beat.artworks || []) {
        if (a.status !== 'done' || !a.result_image_id) continue;
        const key = String(a.result_image_id);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          _id: String(a._id),
          result_image_id: key,
          name: a.name || '',
          prompt: a.prompt || '',
          owner_kind: 'beat',
          owner_id: String(beat._id),
          owner_label: `Beat: ${stripMarkdown(beat.name || '')}`.trim(),
        });
      }

      // Each in-scene character's artworks.
      for (const c of charDocs) {
        const cName = stripMarkdown(c.name || '').trim();
        for (const a of c.artworks || []) {
          if (a.status !== 'done' || !a.result_image_id) continue;
          const key = String(a.result_image_id);
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({
            _id: String(a._id),
            result_image_id: key,
            name: a.name || '',
            prompt: a.prompt || '',
            owner_kind: 'character',
            owner_id: String(c._id),
            owner_label: cName ? `Character: ${cName}` : 'Character',
          });
        }
      }

      res.json({ artworks: items });
    } catch (e) {
      next(e);
    }
  });

  // Every GridFS image owned by this beat — superset of beat.images[] because
  // it includes storyboard frames and reference uploads (those write to GridFS
  // with owner_type='beat' but don't mutate the embedded gallery array).
  router.get('/beat/:id/images', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const files = await listImagesForBeat(beatId);
      const filtered = files.filter((f) => f.metadata?.kind !== 'thumbnail');
      res.json({ images: filtered.map(imageFileToMeta) });
    } catch (e) {
      next(e);
    }
  });

  router.get('/character', async (req, res) => {
    const name = String(req.query.name || '');
    if (!name) return res.status(400).json({ error: 'name required' });
    const c = await getCharacter(name);
    if (!c) return res.status(404).json({ error: 'character not found' });
    res.json({ character: c });
    backfillOwnedImageCaptions('character', c._id?.toString?.(), c.images).catch(() => {});
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

  // All character-owned GridFS images, joined with the owning character's
  // name. Used by the EntityImagePickerModal's "Character" source tab so a
  // user can copy any existing character image onto another entity. Optional
  // ?exclude_id=<character_id> drops images owned by that character.
  router.get('/images/by-owner/characters', async (req, res, next) => {
    try {
      const exclude = String(req.query?.exclude_id || '').trim();
      const files = await listImagesByOwnerType('character');
      const ids = [];
      const seen = new Set();
      for (const f of files) {
        const oid = f.metadata?.owner_id;
        if (!oid) continue;
        const key = oid.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        ids.push(oid);
      }
      const nameById = new Map();
      if (ids.length) {
        const all = await findAllCharacters();
        const wantedKeys = new Set(ids.map((x) => x.toString()));
        for (const c of all) {
          const key = c._id.toString();
          if (wantedKeys.has(key)) {
            nameById.set(key, c.name || '(unnamed)');
          }
        }
      }
      const result = [];
      for (const f of files) {
        const ownerId = f.metadata?.owner_id?.toString?.() || null;
        if (!ownerId) continue;
        if (exclude && ownerId === exclude) continue;
        result.push({
          ...imageFileToMeta(f),
          owner_id: ownerId,
          owner_name: nameById.get(ownerId) || '(unknown)',
        });
      }
      res.json({ images: result });
    } catch (e) {
      next(e);
    }
  });

  // All beat-owned GridFS images, joined with the owning beat's name/order.
  // Used by the picker modal's "Beats" source tab. Optional ?exclude_id drops
  // images owned by that beat.
  router.get('/images/by-owner/beats', async (req, res, next) => {
    try {
      const exclude = String(req.query?.exclude_id || '').trim();
      const [files, plot] = await Promise.all([
        listImagesByOwnerType('beat'),
        getPlot(),
      ]);
      const beatById = new Map();
      for (const b of plot?.beats || []) {
        if (b?._id) {
          beatById.set(b._id.toString(), {
            name: b.name || '',
            order: b.order ?? null,
          });
        }
      }
      const result = [];
      for (const f of files) {
        const ownerId = f.metadata?.owner_id?.toString?.() || null;
        if (!ownerId) continue;
        if (exclude && ownerId === exclude) continue;
        const beat = beatById.get(ownerId);
        result.push({
          ...imageFileToMeta(f),
          owner_id: ownerId,
          owner_name: beat?.name || '(unknown beat)',
          owner_order: beat?.order ?? null,
        });
      }
      res.json({ images: result });
    } catch (e) {
      next(e);
    }
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
      announceLibraryMedia({
        req,
        verb: 'uploaded an image to',
        imageFileId: meta._id,
      });
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
      announceLibraryMedia({ req, verb: 'deleted a library image from' });
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
      announceLibraryMedia({
        req,
        verb: 'uploaded a file to',
        mediaFileId: meta._id,
        mediaLabel: meta.filename || 'file',
      });
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
      announceLibraryMedia({ req, verb: 'deleted a library file from' });
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
      const sniffed = validateImageBuffer(req.file.buffer);
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
      announceBeatMedia({
        req,
        beat: await getBeat(beatId),
        verb: 'uploaded an image to',
        imageFileId: file._id,
      });
      kickoffImageVisionSeed(file._id, req.file.buffer, sniffed || req.file.mimetype, {
        ownerType: 'beat',
        ownerId: beatId,
      });
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
      announceBeatMedia({
        req,
        beat: await getBeat(beatId),
        verb: 'deleted an image from',
      });
    } catch (e) {
      next(e);
    }
  });

  // Replace a beat's image with a model-generated one. Two modes:
  // - mode='edit'     → pass the existing bytes + prompt to the chosen image
  //                     model's edits endpoint.
  // - mode='generate' → pure text-to-image; the slot is replaced by a fresh
  //                     image built from the prompt alone.
  // The slot position is preserved; if the replaced image was main, the new
  // image becomes main. Old GridFS bytes are deleted.
  router.post('/beat/:id/image/:imageId/regenerate', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const oldImageId = req.params.imageId;
      if (!isOidHex(oldImageId)) return res.status(400).json({ error: 'invalid image id' });
      const mode = String(req.body?.mode ?? 'edit');
      if (!['edit', 'generate'].includes(mode)) {
        return res.status(400).json({ error: 'mode must be edit|generate' });
      }
      const imageModel = normalizeImageModel(req.body?.image_model);
      if (!isValidImageModel(imageModel)) {
        return res.status(400).json({ error: IMAGE_MODEL_ERROR });
      }
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
      if (!prompt) {
        return res.status(400).json({ error: 'prompt (non-empty string) required' });
      }
      if (prompt.length > 4096) {
        return res.status(400).json({ error: 'prompt must be ≤ 4096 chars' });
      }

      const refs = await loadReferenceImages(req.body?.reference_image_ids);
      if (refs.error) {
        return res.status(refs.status || 400).json({ error: refs.error });
      }

      let existingImage = null;
      if (mode === 'edit') {
        const r = await readImageBuffer(oldImageId);
        if (!r) return res.status(404).json({ error: 'existing image not found' });
        const declared = r.file.contentType || r.file.metadata?.contentType || null;
        existingImage = { buffer: r.buffer, contentType: declared || 'image/png' };
      }

      const { dispatchImageReplace } = await import('./imageReplaceDispatch.js');
      let result;
      try {
        result = await dispatchImageReplace({
          prompt,
          mode,
          model: imageModel,
          existingImage,
          referenceImages: refs.images,
          discordUser: webDiscordUser(req),
        });
      } catch (e) {
        if (e?.status === 400) return res.status(400).json({ error: e.message });
        throw e;
      }

      const file = await uploadGeneratedImage({
        buffer: result.buffer,
        contentType: result.contentType,
        prompt,
        generatedBy: result.model,
        ownerType: 'beat',
        ownerId: beatId,
        filename: `beat-${beatId}-${Date.now()}.png`,
      });
      const newMeta = {
        _id: file._id,
        filename: file.filename,
        content_type: file.content_type,
        size: file.size,
        source: 'generated',
        prompt,
        generated_by: result.model,
        uploaded_at: file.uploaded_at,
        ...(refs.ids.length ? { reference_image_ids: refs.ids } : {}),
      };
      const replaceResult = await replaceBeatImageViaGateway({
        beatId,
        oldImageId,
        newImageMeta: newMeta,
      });
      res.json({
        beat: replaceResult.beat,
        image: { _id: file._id, content_type: file.content_type },
        replaced: String(oldImageId),
        was_main: replaceResult.was_main,
        model: result.model,
      });
      announceBeatMedia({
        req,
        beat: replaceResult.beat || (await getBeat(beatId)),
        verb: mode === 'edit' ? 'edited an image on' : 'regenerated an image on',
        imageFileId: file._id,
        prompt,
      });
      kickoffImageVisionSeed(file._id, result.buffer, result.contentType, {
        ownerType: 'beat',
        ownerId: beatId,
      });
    } catch (e) {
      next(e);
    }
  });

  // Attach an existing GridFS image (from library or another entity) to a
  // beat's gallery. Picker uses this for the Library tab. The image is
  // re-parented: its prior owner loses it. Set `set_as_main: true` to also
  // mark it as the beat's main image.
  router.post('/beat/:id/image/attach', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const imageId = String(req.body?.image_id || '').trim();
      if (!isOidHex(imageId)) {
        return res.status(400).json({ error: 'image_id (24-hex) required' });
      }
      const setAsMain = !!req.body?.set_as_main;
      try {
        const result = await attachExistingImageToBeatViaGateway({
          beatId,
          imageId,
          setAsMain,
        });
        res.json(result);
        announceBeatMedia({
          req,
          beat: result?.beat || (await getBeat(beatId)),
          verb: 'attached an image to',
          imageFileId: imageId,
        });
      } catch (e) {
        if (/not found/i.test(e?.message || '')) {
          return res.status(404).json({ error: e.message });
        }
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  // Copy a GridFS image into this beat's gallery as a new GridFS file. Source
  // stays intact. Used by the picker's "Character"/"Beats" source tabs.
  router.post('/beat/:id/image/copy', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const imageId = String(req.body?.image_id || '').trim();
      if (!isOidHex(imageId)) {
        return res.status(400).json({ error: 'image_id (24-hex) required' });
      }
      const setAsMain = !!req.body?.set_as_main;
      try {
        const imageMeta = await copyImageToNewOwner({
          imageId,
          ownerType: 'beat',
          ownerId: beatId,
          filenameBase: `beat-${beatId}`,
        });
        const result = await addBeatImageViaGateway({
          beatId,
          imageMeta,
          setAsMain,
        });
        res.json(result);
        announceBeatMedia({
          req,
          beat: result?.beat || (await getBeat(beatId)),
          verb: 'copied an image to',
          imageFileId: imageMeta._id,
        });
      } catch (e) {
        if (e?.status === 404) return res.status(404).json({ error: e.message });
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  // Generate a fresh image from a custom prompt and attach to a beat's
  // gallery. Optional `reference_image_ids[]` are sent to the model along
  // with the prompt and persisted on the resulting image's metadata so the
  // Artwork tab can prefill them when the user revisits.
  router.post('/beat/:id/image/generate', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const prompt = String(req.body?.prompt || '').trim();
      if (!prompt) {
        return res.status(400).json({ error: 'prompt (non-empty) required' });
      }
      if (prompt.length > 4096) {
        return res.status(400).json({ error: 'prompt must be ≤ 4096 chars' });
      }
      const model = normalizeImageModel(req.body?.model);
      if (!isValidImageModel(model)) {
        return res.status(400).json({ error: IMAGE_MODEL_ERROR });
      }
      const refs = await loadReferenceImages(req.body?.reference_image_ids);
      if (refs.error) {
        return res.status(refs.status || 400).json({ error: refs.error });
      }
      const setAsMain = !!req.body?.set_as_main;
      const { dispatchImageReplace } = await import('./imageReplaceDispatch.js');
      const result = await dispatchImageReplace({
        prompt,
        mode: 'generate',
        model,
        referenceImages: refs.images,
        discordUser: webDiscordUser(req),
      });
      const file = await uploadGeneratedImage({
        buffer: result.buffer,
        contentType: result.contentType,
        prompt,
        generatedBy: result.model || model,
        ownerType: 'beat',
        ownerId: beatId,
        filename: `beat-${beatId}-gen-${Date.now()}.png`,
      });
      const updated = await addBeatImageViaGateway({
        beatId,
        imageMeta: {
          _id: file._id,
          filename: file.filename,
          content_type: file.content_type,
          size: file.size,
          source: 'generated',
          prompt,
          generated_by: result.model || model,
          uploaded_at: file.uploaded_at,
          ...(refs.ids.length ? { reference_image_ids: refs.ids } : {}),
        },
        setAsMain,
      });
      res.json({
        beat: updated.beat || updated,
        image: { _id: file._id, content_type: file.content_type },
      });
      announceBeatMedia({
        req,
        beat: updated.beat || (await getBeat(beatId)),
        verb:
          refs.ids.length >= 2
            ? 'composited images on'
            : refs.ids.length === 1
              ? 'edited an image on'
              : 'generated an image on',
        imageFileId: file._id,
        prompt,
      });
      kickoffImageVisionSeed(file._id, result.buffer, result.contentType, {
        ownerType: 'beat',
        ownerId: beatId,
      });
    } catch (e) {
      if (e?.status >= 400 && e?.status < 600) {
        return res.status(e.status).json({ error: e.message });
      }
      next(e);
    }
  });

  router.post('/beat/:id/image/:imageId/move-to-library', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const imageId = req.params.imageId;
      if (!isOidHex(imageId)) return res.status(400).json({ error: 'invalid image id' });
      try {
        const result = await moveBeatImageToLibraryViaGateway({ beatId, imageId });
        res.json({ ok: true, image_id: imageId, beat: result.beat });
      } catch (e) {
        if (/not attached/i.test(e?.message || '')) {
          return res.status(404).json({ error: e.message });
        }
        throw e;
      }
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
      announceBeatMedia({
        req,
        beat: await getBeat(beatId),
        verb: (file.content_type || '').startsWith('audio/')
          ? 'added audio to'
          : (file.content_type || '').startsWith('video/')
            ? 'added video to'
            : 'uploaded a file to',
        mediaFileId: file._id,
        mediaLabel: file.filename || 'file',
      });
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
      announceBeatMedia({
        req,
        beat: await getBeat(beatId),
        verb: 'deleted a file from',
      });
    } catch (e) {
      next(e);
    }
  });

  // Attach an existing GridFS attachment (from library or another entity) to
  // a beat. Picker uses this for the Library tab. Re-parents the attachment.
  router.post('/beat/:id/attachment/attach', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const attachmentId = String(req.body?.attachment_id || '').trim();
      if (!isOidHex(attachmentId)) {
        return res.status(400).json({ error: 'attachment_id (24-hex) required' });
      }
      try {
        const result = await attachExistingAttachmentToBeatViaGateway({
          beatId,
          attachmentId,
        });
        res.json(result);
        announceBeatMedia({
          req,
          beat: await getBeat(beatId),
          verb: 'attached a file to',
          mediaFileId: attachmentId,
          mediaLabel: 'file',
        });
      } catch (e) {
        if (/not found/i.test(e?.message || '')) {
          return res.status(404).json({ error: e.message });
        }
        throw e;
      }
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
      const sniffed = validateImageBuffer(req.file.buffer);
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
      announceCharacterMedia({
        req,
        character: await getCharacter(cid),
        verb: 'uploaded an image to',
        imageFileId: file._id,
      });
      kickoffImageVisionSeed(file._id, req.file.buffer, sniffed || req.file.mimetype, {
        ownerType: 'character',
        ownerId: cid,
      });
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
      announceCharacterMedia({
        req,
        character: await getCharacter(cid),
        verb: 'deleted an image from',
      });
    } catch (e) {
      next(e);
    }
  });

  // Replace a character's image with a model-generated one. See the beat-side
  // route above for the full body shape — this is the parallel endpoint.
  router.post('/character/:id/image/:imageId/regenerate', async (req, res, next) => {
    try {
      const cid = await resolveCharacterId(req);
      if (!cid) return res.status(404).json({ error: 'character not found' });
      const oldImageId = req.params.imageId;
      if (!isOidHex(oldImageId)) return res.status(400).json({ error: 'invalid image id' });
      const mode = String(req.body?.mode ?? 'edit');
      if (!['edit', 'generate'].includes(mode)) {
        return res.status(400).json({ error: 'mode must be edit|generate' });
      }
      const imageModel = normalizeImageModel(req.body?.image_model);
      if (!isValidImageModel(imageModel)) {
        return res.status(400).json({ error: IMAGE_MODEL_ERROR });
      }
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
      if (!prompt) {
        return res.status(400).json({ error: 'prompt (non-empty string) required' });
      }
      if (prompt.length > 4096) {
        return res.status(400).json({ error: 'prompt must be ≤ 4096 chars' });
      }

      const refs = await loadReferenceImages(req.body?.reference_image_ids);
      if (refs.error) {
        return res.status(refs.status || 400).json({ error: refs.error });
      }

      let existingImage = null;
      if (mode === 'edit') {
        const r = await readImageBuffer(oldImageId);
        if (!r) return res.status(404).json({ error: 'existing image not found' });
        const declared = r.file.contentType || r.file.metadata?.contentType || null;
        existingImage = { buffer: r.buffer, contentType: declared || 'image/png' };
      }

      const { dispatchImageReplace } = await import('./imageReplaceDispatch.js');
      let result;
      try {
        result = await dispatchImageReplace({
          prompt,
          mode,
          model: imageModel,
          existingImage,
          referenceImages: refs.images,
          discordUser: webDiscordUser(req),
        });
      } catch (e) {
        if (e?.status === 400) return res.status(400).json({ error: e.message });
        throw e;
      }

      const file = await uploadGeneratedImage({
        buffer: result.buffer,
        contentType: result.contentType,
        prompt,
        generatedBy: result.model,
        ownerType: 'character',
        ownerId: cid,
        filename: `character-${cid}-${Date.now()}.png`,
      });
      const newMeta = {
        _id: file._id,
        filename: file.filename,
        content_type: file.content_type,
        size: file.size,
        source: 'generated',
        prompt,
        generated_by: result.model,
        uploaded_at: file.uploaded_at,
        ...(refs.ids.length ? { reference_image_ids: refs.ids } : {}),
      };
      const replaceResult = await replaceCharacterImageViaGateway({
        character: cid,
        oldImageId,
        newImageMeta: newMeta,
      });
      res.json({
        character: replaceResult.character,
        image: { _id: file._id, content_type: file.content_type },
        replaced: String(oldImageId),
        was_main: replaceResult.was_main,
        model: result.model,
      });
      announceCharacterMedia({
        req,
        character: replaceResult.character || (await getCharacter(cid)),
        verb: mode === 'edit' ? 'edited an image on' : 'regenerated an image on',
        imageFileId: file._id,
        prompt,
      });
      kickoffImageVisionSeed(file._id, result.buffer, result.contentType, {
        ownerType: 'character',
        ownerId: cid,
      });
    } catch (e) {
      next(e);
    }
  });

  // Attach an existing GridFS image (from library or another entity) to a
  // character's gallery. Picker uses this for the Library tab.
  router.post('/character/:id/image/attach', async (req, res, next) => {
    try {
      const cid = await resolveCharacterId(req);
      if (!cid) return res.status(404).json({ error: 'character not found' });
      const imageId = String(req.body?.image_id || '').trim();
      if (!isOidHex(imageId)) {
        return res.status(400).json({ error: 'image_id (24-hex) required' });
      }
      const setAsMain = !!req.body?.set_as_main;
      try {
        const result = await attachExistingImageToCharacterViaGateway({
          character: cid,
          imageId,
          setAsMain,
        });
        res.json(result);
        announceCharacterMedia({
          req,
          character: result?.character || (await getCharacter(cid)),
          verb: 'attached an image to',
          imageFileId: imageId,
        });
      } catch (e) {
        if (/not found/i.test(e?.message || '')) {
          return res.status(404).json({ error: e.message });
        }
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  // Copy a GridFS image (owned by any entity, or by library) into this
  // character's gallery as a brand-new GridFS file. Source stays intact.
  // Picker uses this for the "Character" and "Beats" source tabs.
  router.post('/character/:id/image/copy', async (req, res, next) => {
    try {
      const cid = await resolveCharacterId(req);
      if (!cid) return res.status(404).json({ error: 'character not found' });
      const imageId = String(req.body?.image_id || '').trim();
      if (!isOidHex(imageId)) {
        return res.status(400).json({ error: 'image_id (24-hex) required' });
      }
      const setAsMain = !!req.body?.set_as_main;
      try {
        const imageMeta = await copyImageToNewOwner({
          imageId,
          ownerType: 'character',
          ownerId: cid,
          filenameBase: `character-${cid}`,
        });
        const result = await addCharacterImageViaGateway({
          character: cid,
          imageMeta,
          setAsMain,
        });
        res.json(result);
        announceCharacterMedia({
          req,
          character: result?.character || (await getCharacter(cid)),
          verb: 'copied an image to',
          imageFileId: imageMeta._id,
        });
      } catch (e) {
        if (e?.status === 404) return res.status(404).json({ error: e.message });
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  // Generate a fresh image from a custom prompt and attach to a character's
  // gallery. Optional `reference_image_ids[]` are sent to the model along
  // with the prompt and persisted on the image's metadata so the Artwork
  // tab can prefill them when the user revisits.
  router.post('/character/:id/image/generate', async (req, res, next) => {
    try {
      const cid = await resolveCharacterId(req);
      if (!cid) return res.status(404).json({ error: 'character not found' });
      const prompt = String(req.body?.prompt || '').trim();
      if (!prompt) {
        return res.status(400).json({ error: 'prompt (non-empty) required' });
      }
      if (prompt.length > 4096) {
        return res.status(400).json({ error: 'prompt must be ≤ 4096 chars' });
      }
      const model = normalizeImageModel(req.body?.model);
      if (!isValidImageModel(model)) {
        return res.status(400).json({ error: IMAGE_MODEL_ERROR });
      }
      const refs = await loadReferenceImages(req.body?.reference_image_ids);
      if (refs.error) {
        return res.status(refs.status || 400).json({ error: refs.error });
      }
      const setAsMain = !!req.body?.set_as_main;
      const { dispatchImageReplace } = await import('./imageReplaceDispatch.js');
      const result = await dispatchImageReplace({
        prompt,
        mode: 'generate',
        model,
        referenceImages: refs.images,
        discordUser: webDiscordUser(req),
      });
      const file = await uploadGeneratedImage({
        buffer: result.buffer,
        contentType: result.contentType,
        prompt,
        generatedBy: result.model || model,
        ownerType: 'character',
        ownerId: cid,
        filename: `character-${cid}-gen-${Date.now()}.png`,
      });
      const updated = await addCharacterImageViaGateway({
        character: cid,
        imageMeta: {
          _id: file._id,
          filename: file.filename,
          content_type: file.content_type,
          size: file.size,
          source: 'generated',
          prompt,
          generated_by: result.model || model,
          uploaded_at: file.uploaded_at,
          ...(refs.ids.length ? { reference_image_ids: refs.ids } : {}),
        },
        setAsMain,
      });
      res.json({
        character: updated.character || updated,
        image: { _id: file._id, content_type: file.content_type },
      });
      announceCharacterMedia({
        req,
        character: updated.character || (await getCharacter(cid)),
        verb:
          refs.ids.length >= 2
            ? 'composited images on'
            : refs.ids.length === 1
              ? 'edited an image on'
              : 'generated an image on',
        imageFileId: file._id,
        prompt,
      });
      kickoffImageVisionSeed(file._id, result.buffer, result.contentType, {
        ownerType: 'character',
        ownerId: cid,
      });
    } catch (e) {
      if (e?.status >= 400 && e?.status < 600) {
        return res.status(e.status).json({ error: e.message });
      }
      next(e);
    }
  });

  router.post('/character/:id/image/:imageId/move-to-library', async (req, res, next) => {
    try {
      const cid = await resolveCharacterId(req);
      if (!cid) return res.status(404).json({ error: 'character not found' });
      const imageId = req.params.imageId;
      if (!isOidHex(imageId)) return res.status(400).json({ error: 'invalid image id' });
      try {
        const result = await moveCharacterImageToLibraryViaGateway({
          character: cid,
          imageId,
        });
        res.json({ ok: true, image_id: imageId, character: result.character });
      } catch (e) {
        if (/not attached/i.test(e?.message || '')) {
          return res.status(404).json({ error: e.message });
        }
        throw e;
      }
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

  router.post('/character/:id/attachment', upload.single('file'), async (req, res, next) => {
    try {
      const cid = await resolveCharacterId(req);
      if (!cid) return res.status(404).json({ error: 'character not found' });
      if (!req.file) return res.status(400).json({ error: 'file required' });
      const file = await uploadAttachmentBuffer({
        buffer: req.file.buffer,
        filename: safeFilename(req.file.originalname, `attach-${Date.now()}.bin`),
        contentType: req.file.mimetype,
        ownerType: 'character',
        ownerId: cid,
      });
      const result = await addCharacterAttachmentViaGateway({
        character: cid,
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
      announceCharacterMedia({
        req,
        character: await getCharacter(cid),
        verb: (file.content_type || '').startsWith('audio/')
          ? 'added audio to'
          : (file.content_type || '').startsWith('video/')
            ? 'added video to'
            : 'uploaded a file to',
        mediaFileId: file._id,
        mediaLabel: file.filename || 'file',
      });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/character/:id/attachment/:attachId', async (req, res, next) => {
    try {
      const cid = await resolveCharacterId(req);
      if (!cid) return res.status(404).json({ error: 'character not found' });
      const result = await removeCharacterAttachmentViaGateway({
        character: cid,
        attachmentId: req.params.attachId,
      });
      res.json(result);
      announceCharacterMedia({
        req,
        character: await getCharacter(cid),
        verb: 'deleted a file from',
      });
    } catch (e) {
      next(e);
    }
  });

  // Attach an existing GridFS attachment (from library or another entity) to
  // a character. Picker uses this for the Library tab.
  router.post('/character/:id/attachment/attach', async (req, res, next) => {
    try {
      const cid = await resolveCharacterId(req);
      if (!cid) return res.status(404).json({ error: 'character not found' });
      const attachmentId = String(req.body?.attachment_id || '').trim();
      if (!isOidHex(attachmentId)) {
        return res.status(400).json({ error: 'attachment_id (24-hex) required' });
      }
      try {
        const result = await attachExistingAttachmentToCharacterViaGateway({
          character: cid,
          attachmentId,
        });
        res.json(result);
        announceCharacterMedia({
          req,
          character: await getCharacter(cid),
          verb: 'attached a file to',
          mediaFileId: attachmentId,
          mediaLabel: 'file',
        });
      } catch (e) {
        if (/not found/i.test(e?.message || '')) {
          return res.status(404).json({ error: e.message });
        }
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  // ── artwork routes (character + beat) ────────────────────────────────────
  //
  // An "artwork" is a generated image bundled with the prompt + reference
  // images that produced it, stored as an embedded array on the host doc
  // (character.artworks[] or beat.artworks[]). Unlike host.images[]
  // (reference uploads), an artwork can be reopened later, regenerated, or
  // in-line-edited (Nano Banana Pro via FAL). The result lives in GridFS
  // with owner_type matching the host.
  //
  // All generation paths are async: routes create a pending artwork doc
  // and return it immediately (~10ms); the SPA shows a pending tile while
  // the background job runs. Completion is pushed to connected SPAs via
  // the existing `fields_updated` Hocuspocus broadcast on the host's room.

  function validateArtworkSubmitBody(req, res, { requirePrompt = true } = {}) {
    const prompt = String(req.body?.prompt || '').trim();
    if (requirePrompt) {
      if (!prompt) {
        res.status(400).json({ error: 'prompt (non-empty) required' });
        return null;
      }
      if (prompt.length > 4096) {
        res.status(400).json({ error: 'prompt must be ≤ 4096 chars' });
        return null;
      }
    }
    const model = normalizeImageModel(req.body?.model);
    if (!isValidImageModel(model)) {
      res.status(400).json({ error: IMAGE_MODEL_ERROR });
      return null;
    }
    const name = String(req.body?.name || '').slice(0, 200);
    return { prompt, model, name };
  }

  async function validateArtworkRefs(req, res) {
    const refs = await loadReferenceImages(req.body?.reference_image_ids);
    if (refs.error) {
      res.status(refs.status || 400).json({ error: refs.error });
      return null;
    }
    return refs;
  }

  // Map errors thrown from the job-start path (e.g. host not found, invalid
  // model) into the right HTTP response. Anything unrecognized bubbles to
  // express's default error handler via `next(e)`.
  function handleArtworkError(e, res, next) {
    if (e?.status >= 400 && e?.status < 600) {
      return res.status(e.status).json({ error: e.message });
    }
    if (/not (found|attached)/i.test(e?.message || '')) {
      return res.status(404).json({ error: e.message });
    }
    return next(e);
  }

  function registerArtworkRoutes({ hostType, basePath, resolveHostId }) {
    // POST /<host>/:id/artwork — start a new artwork generation.
    router.post(`${basePath}/:id/artwork`, async (req, res, next) => {
      try {
        const hostId = await resolveHostId(req);
        if (!hostId) return res.status(404).json({ error: `${hostType} not found` });
        const body = validateArtworkSubmitBody(req, res);
        if (!body) return;
        const refs = await validateArtworkRefs(req, res);
        if (!refs) return;
        const artwork = await startGenerateArtworkJob({
          hostType,
          hostId,
          prompt: body.prompt,
          name: body.name,
          model: body.model,
          referenceImageIds: refs.ids,
          discordUser: webDiscordUser(req),
          announceUsername: req?.session?.username || null,
        });
        res.json({ artwork });
      } catch (e) {
        handleArtworkError(e, res, next);
      }
    });

    // POST /<host>/:id/artwork/:artworkId/regenerate — fresh provider call
    // on an existing artwork. The user can change prompt/model/refs.
    router.post(`${basePath}/:id/artwork/:artworkId/regenerate`, async (req, res, next) => {
      try {
        const hostId = await resolveHostId(req);
        if (!hostId) return res.status(404).json({ error: `${hostType} not found` });
        const artworkId = req.params.artworkId;
        if (!isOidHex(artworkId)) return res.status(400).json({ error: 'invalid artwork id' });
        const body = validateArtworkSubmitBody(req, res);
        if (!body) return;
        const refs = await validateArtworkRefs(req, res);
        if (!refs) return;
        const artwork = await startRegenerateArtworkJob({
          hostType,
          hostId,
          artworkId,
          prompt: body.prompt,
          name: body.name,
          model: body.model,
          referenceImageIds: refs.ids,
          discordUser: webDiscordUser(req),
          announceUsername: req?.session?.username || null,
        });
        res.json({ artwork });
      } catch (e) {
        handleArtworkError(e, res, next);
      }
    });

    // POST /<host>/:id/artwork/:artworkId/edit — in-line edit. Takes a prompt
    // and optional `model` (defaults to nano-banana-pro); uses the artwork's
    // current result_image_id as the input image. The old result becomes
    // previous_result_image_id for one-step undo.
    router.post(`${basePath}/:id/artwork/:artworkId/edit`, async (req, res, next) => {
      try {
        const hostId = await resolveHostId(req);
        if (!hostId) return res.status(404).json({ error: `${hostType} not found` });
        const artworkId = req.params.artworkId;
        if (!isOidHex(artworkId)) return res.status(400).json({ error: 'invalid artwork id' });
        const prompt = String(req.body?.prompt || '').trim();
        if (!prompt) return res.status(400).json({ error: 'prompt (non-empty) required' });
        if (prompt.length > 4096) {
          return res.status(400).json({ error: 'prompt must be ≤ 4096 chars' });
        }
        const model = normalizeImageModel(req.body?.model);
        if (!isValidImageModel(model)) {
          return res.status(400).json({ error: IMAGE_MODEL_ERROR });
        }
        const artwork = await startEditArtworkJob({
          hostType,
          hostId,
          artworkId,
          prompt,
          model,
          discordUser: webDiscordUser(req),
          announceUsername: req?.session?.username || null,
        });
        res.json({ artwork });
      } catch (e) {
        handleArtworkError(e, res, next);
      }
    });

    // POST /<host>/:id/artwork/:artworkId/undo — revert the most recent
    // edit. Synchronous; previous_result_image_id → result_image_id.
    router.post(`${basePath}/:id/artwork/:artworkId/undo`, async (req, res, next) => {
      try {
        const hostId = await resolveHostId(req);
        if (!hostId) return res.status(404).json({ error: `${hostType} not found` });
        const artworkId = req.params.artworkId;
        if (!isOidHex(artworkId)) return res.status(400).json({ error: 'invalid artwork id' });
        const artwork = await undoArtworkEdit({ hostType, hostId, artworkId });
        res.json({ artwork });
      } catch (e) {
        handleArtworkError(e, res, next);
      }
    });

    // PATCH /<host>/:id/artwork/:artworkId — metadata-only update (name).
    router.patch(`${basePath}/:id/artwork/:artworkId`, async (req, res, next) => {
      try {
        const hostId = await resolveHostId(req);
        if (!hostId) return res.status(404).json({ error: `${hostType} not found` });
        const artworkId = req.params.artworkId;
        if (!isOidHex(artworkId)) return res.status(400).json({ error: 'invalid artwork id' });
        const patch = {};
        if (typeof req.body?.name === 'string') patch.name = req.body.name.slice(0, 200);
        if (Object.keys(patch).length === 0) {
          return res.status(400).json({ error: 'no recognized fields to patch (expected: name)' });
        }
        const { artwork } = await patchArtworkViaGateway({
          hostType,
          hostId,
          artworkId,
          patch,
        });
        res.json({ artwork });
      } catch (e) {
        handleArtworkError(e, res, next);
      }
    });

    // DELETE /<host>/:id/artwork/:artworkId — remove the artwork and
    // purge both its current and previous result images from GridFS.
    router.delete(`${basePath}/:id/artwork/:artworkId`, async (req, res, next) => {
      try {
        const hostId = await resolveHostId(req);
        if (!hostId) return res.status(404).json({ error: `${hostType} not found` });
        const artworkId = req.params.artworkId;
        if (!isOidHex(artworkId)) return res.status(400).json({ error: 'invalid artwork id' });
        await deleteArtwork({ hostType, hostId, artworkId });
        res.json({ ok: true, removed: artworkId });
        if (hostType === 'beat') {
          announceBeatMedia({
            req,
            beat: await getBeat(hostId),
            verb: 'deleted artwork from',
          });
        } else if (hostType === 'character') {
          announceCharacterMedia({
            req,
            character: await getCharacter(hostId),
            verb: 'deleted artwork from',
          });
        }
      } catch (e) {
        handleArtworkError(e, res, next);
      }
    });
  }

  registerArtworkRoutes({
    hostType: 'character',
    basePath: '/character',
    resolveHostId: resolveCharacterId,
  });
  registerArtworkRoutes({
    hostType: 'beat',
    basePath: '/beat',
    resolveHostId: resolveBeatId,
  });

  // Picker support: returns every beat with its embedded images and
  // artworks (result image ids + names). The SPA's tabbed reference picker
  // loads this lazily when the user clicks the "Beats" tab.
  router.get('/beats/with-artwork', async (req, res, next) => {
    try {
      const beats = await listBeats();
      const out = beats.map((b) => ({
        _id: b._id,
        order: b.order,
        name: b.name,
        desc: b.desc,
        images: (b.images || []).map((img) => ({
          _id: img._id,
          filename: img.filename,
          name: img.name,
          description: img.description,
          content_type: img.content_type,
        })),
        artworks: (b.artworks || [])
          .filter((a) => a.status === 'done' && a.result_image_id)
          .map((a) => ({
            _id: a._id,
            name: a.name,
            prompt: a.prompt,
            result_image_id: a.result_image_id,
          })),
      }));
      res.json({ beats: out });
    } catch (e) {
      next(e);
    }
  });

  // ── notes mutations (non-text) ───────────────────────────────────────────

  async function fetchDirectorNote(noteId) {
    try {
      const doc = await getDirectorNotes();
      const notes = doc?.notes || [];
      return notes.find((n) => String(n._id) === String(noteId)) || null;
    } catch {
      return null;
    }
  }

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
      announceNoteMedia({
        req,
        note: await fetchDirectorNote(req.params.noteId),
        verb: 'uploaded an image to',
        imageFileId: file._id,
      });
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
      announceNoteMedia({
        req,
        note: await fetchDirectorNote(req.params.noteId),
        verb: 'deleted an image from',
      });
    } catch (e) {
      next(e);
    }
  });

  // Copy a GridFS image into this note's gallery as a new GridFS file. Source
  // stays intact. Used by the picker's "Character"/"Beats" source tabs.
  router.post('/notes/:noteId/image/copy', async (req, res, next) => {
    try {
      const noteId = req.params.noteId;
      if (!isOidHex(noteId)) return res.status(400).json({ error: 'invalid id' });
      const imageId = String(req.body?.image_id || '').trim();
      if (!isOidHex(imageId)) {
        return res.status(400).json({ error: 'image_id (24-hex) required' });
      }
      const setAsMain = !!req.body?.set_as_main;
      try {
        const imageMeta = await copyImageToNewOwner({
          imageId,
          ownerType: 'director_note',
          ownerId: noteId,
          filenameBase: `note-${noteId}`,
        });
        const result = await addDirectorNoteImageViaGateway({
          noteId,
          imageMeta,
          setAsMain,
        });
        res.json(result);
        announceNoteMedia({
          req,
          note: await fetchDirectorNote(noteId),
          verb: 'copied an image to',
          imageFileId: imageMeta._id,
        });
      } catch (e) {
        if (e?.status === 404) return res.status(404).json({ error: e.message });
        throw e;
      }
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
      announceNoteMedia({
        req,
        note: await fetchDirectorNote(req.params.noteId),
        verb: (file.content_type || '').startsWith('audio/')
          ? 'added audio to'
          : (file.content_type || '').startsWith('video/')
            ? 'added video to'
            : 'uploaded a file to',
        mediaFileId: file._id,
        mediaLabel: file.filename || 'file',
      });
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
      announceNoteMedia({
        req,
        note: await fetchDirectorNote(req.params.noteId),
        verb: 'deleted a file from',
      });
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

  // Edit shot metadata (duration / shot_type / transition / characters_in_scene).
  // Validation/clamping happens inside updateStoryboard; we surface its
  // human-readable error messages directly so the SPA can show them.
  router.patch('/storyboard/:id', async (req, res, next) => {
    try {
      const sbId = await resolveStoryboardId(req);
      if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
      const {
        duration_seconds,
        shot_type,
        transition_in,
        characters_in_scene,
        reverse_in_post,
      } = req.body || {};
      const patch = {};
      if (duration_seconds !== undefined) patch.duration_seconds = duration_seconds;
      if (shot_type !== undefined) patch.shot_type = shot_type;
      if (transition_in !== undefined) patch.transition_in = transition_in;
      if (characters_in_scene !== undefined)
        patch.characters_in_scene = characters_in_scene;
      if (reverse_in_post !== undefined) patch.reverse_in_post = reverse_in_post;
      if (!Object.keys(patch).length)
        return res.status(400).json({ error: 'no patch fields' });
      try {
        const result = await updateStoryboardScalarsViaGateway({
          storyboardId: sbId,
          patch,
        });
        res.json({ storyboard: result });
      } catch (e) {
        if (typeof e?.message === 'string' && e.message.startsWith('update_storyboard:')) {
          return res.status(400).json({ error: e.message });
        }
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  // Auto-generate a one-sentence summary of this shot from its current
  // text_prompt. The LLM result is written to the storyboard's `summary`
  // y-doc fragment via the gateway, so connected SPAs see the new text
  // appear live in the CollabField. Also returned in the response body so
  // callers can confirm the value without waiting for the y-doc round-trip.
  router.post('/storyboard/:id/generate-summary', async (req, res, next) => {
    try {
      const sbId = await resolveStoryboardId(req);
      if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
      const sb = await getStoryboard(sbId);
      if (!sb) return res.status(404).json({ error: 'storyboard not found' });
      if (!sb.text_prompt || !String(sb.text_prompt).trim()) {
        return res.status(400).json({ error: 'text_prompt is empty; nothing to summarize' });
      }
      const { summarizeStoryboardPrompt } = await import('../llm/storyboardSummarize.js');
      const summary = await summarizeStoryboardPrompt(sb.text_prompt);
      const { setStoryboardSummaryViaGateway } = await import('./gateway.js');
      await setStoryboardSummaryViaGateway({ storyboardId: sb._id, text: summary });
      res.json({ summary });
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

  // Upload a frame image (start_frame|end_frame). The image is owned by the
  // storyboard's beat for GridFS metadata bookkeeping.
  router.post('/storyboard/:id/image', upload.single('file'), async (req, res, next) => {
    try {
      const sbId = await resolveStoryboardId(req);
      if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
      if (!req.file) return res.status(400).json({ error: 'file required' });
      const role = String(req.body?.role || req.query.role || '').trim();
      if (!['start_frame', 'end_frame'].includes(role)) {
        return res.status(400).json({ error: 'role must be start_frame|end_frame' });
      }
      const sniffed = validateImageBuffer(req.file.buffer);
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
      announceStoryboardMedia({
        req,
        beat: await getBeat(String(sb.beat_id)),
        storyboard: result || sb,
        verb: role === 'start_frame' ? 'added a start frame to' : 'added an end frame to',
        imageFileId: file._id,
      });
      kickoffImageVisionSeed(file._id, req.file.buffer, sniffed || req.file.mimetype, {
        ownerType: 'beat',
        ownerId: sb.beat_id,
        kind: 'auto',
      });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/storyboard/:id/image/:role', async (req, res, next) => {
    try {
      const sbId = await resolveStoryboardId(req);
      if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
      const role = String(req.params.role);
      if (!['start_frame', 'end_frame'].includes(role)) {
        return res.status(400).json({ error: 'role must be start_frame|end_frame' });
      }
      const result = await setStoryboardImageViaGateway({
        storyboardId: sbId,
        role,
        imageId: null,
      });
      res.json({ storyboard: result });
      if (result?.beat_id) {
        announceStoryboardMedia({
          req,
          beat: await getBeat(String(result.beat_id)),
          storyboard: result,
          verb:
            role === 'start_frame'
              ? 'deleted the start frame from'
              : 'deleted the end frame from',
        });
      }
    } catch (e) {
      next(e);
    }
  });

  // Grab the last frame of the previous storyboard's generated video and
  // install it as this storyboard's start_frame. Used for seamless joining
  // between successive shots (Kling 3 Pro, Veo 3.1 first-last-frame).
  router.post('/storyboard/:id/grab-start-frame-from-previous', async (req, res, next) => {
    try {
      const sbId = await resolveStoryboardId(req);
      if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
      const sb = await getStoryboard(sbId);
      const prev = await getPreviousStoryboardInBeat(sb.beat_id, sb.order);
      if (!prev) {
        return res.status(400).json({ error: 'no previous storyboard in this beat' });
      }
      if (!prev.video_file_id) {
        return res.status(400).json({ error: 'previous shot has no generated video' });
      }
      try {
        const result = await grabStartFrameFromPrevious({ currentSbId: sbId, prev });
        res.json({ storyboard: result.storyboard, image: result.image });
        if (result?.storyboard?.beat_id) {
          announceStoryboardMedia({
            req,
            beat: await getBeat(String(result.storyboard.beat_id)),
            storyboard: result.storyboard,
            verb: 'grabbed the start frame from the previous shot in',
            imageFileId: result?.image?._id,
          });
        }
      } catch (e) {
        if (e instanceof FfmpegMissingError) {
          return res.status(500).json({ error: e.message });
        }
        if (e instanceof FfmpegFailedError) {
          return res.status(500).json({ error: e.message });
        }
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  // Regenerate a single start_frame or end_frame on an existing storyboard
  // row. The frame's persisted reference list is read server-side; the
  // caller supplies the prompt (which is also persisted back to the frame's
  // stored prompt field).
  router.post('/storyboard/:id/frame/:role/generate', async (req, res, next) => {
    try {
      const sbId = await resolveStoryboardId(req);
      if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
      const role = String(req.params.role);
      if (!['start_frame', 'end_frame'].includes(role)) {
        return res.status(400).json({ error: 'role must be start_frame|end_frame' });
      }
      const imageModel = normalizeImageModel(req.body?.image_model);
      if (!isValidImageModel(imageModel)) {
        return res.status(400).json({ error: IMAGE_MODEL_ERROR });
      }
      const mode = req.body?.mode ?? 'generate';
      if (!['generate', 'edit'].includes(mode)) {
        return res.status(400).json({ error: 'mode must be generate|edit' });
      }
      let editPrompt = null;
      let prompt = null;
      if (mode === 'edit') {
        const raw = req.body?.edit_prompt;
        if (typeof raw !== 'string' || !raw.trim()) {
          return res
            .status(400)
            .json({ error: 'edit_prompt (non-empty string) required when mode=edit' });
        }
        if (raw.length > 1024) {
          return res
            .status(400)
            .json({ error: 'edit_prompt must be ≤ 1024 chars' });
        }
        editPrompt = raw;
      } else {
        const raw = req.body?.prompt;
        if (typeof raw !== 'string' || !raw.trim()) {
          return res
            .status(400)
            .json({ error: 'prompt (non-empty string) required when mode=generate' });
        }
        if (raw.length > 4096) {
          return res
            .status(400)
            .json({ error: 'prompt must be ≤ 4096 chars' });
        }
        prompt = raw;
      }
      const {
        startFrameGenerationJob,
        BeatBusyError,
        EditModeError,
        FrameRoleError,
      } = await import('./storyboardGenerate.js');
      try {
        const jobId = await startFrameGenerationJob({
          storyboardId: sbId,
          role,
          imageModel,
          mode,
          editPrompt,
          prompt,
          announceUsername: req?.session?.username || null,
        });
        res.status(202).json({ job_id: jobId, storyboard_id: sbId, role });
      } catch (e) {
        if (e instanceof BeatBusyError) {
          return res.status(409).json({ error: e.message });
        }
        if (e instanceof EditModeError || e instanceof FrameRoleError) {
          return res.status(400).json({ error: e.message });
        }
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  // Inline edit of an existing frame image. Mirrors the artwork edit flow:
  // POST returns 202 with a job_id; the runner rotates current → previous and
  // installs the new image. Synchronous undo lives at .../undo.
  router.post('/storyboard/:id/frame/:role/edit', async (req, res, next) => {
    try {
      const sbId = await resolveStoryboardId(req);
      if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
      const role = String(req.params.role);
      if (!['start_frame', 'end_frame'].includes(role)) {
        return res.status(400).json({ error: 'role must be start_frame|end_frame' });
      }
      const model = normalizeImageModel(req.body?.model);
      if (!isValidImageModel(model)) {
        return res.status(400).json({ error: IMAGE_MODEL_ERROR });
      }
      const raw = req.body?.prompt;
      if (typeof raw !== 'string' || !raw.trim()) {
        return res
          .status(400)
          .json({ error: 'prompt (non-empty string) required' });
      }
      if (raw.length > 1024) {
        return res.status(400).json({ error: 'prompt must be ≤ 1024 chars' });
      }
      const {
        startFrameGenerationJob,
        BeatBusyError,
        EditModeError,
        FrameRoleError,
      } = await import('./storyboardGenerate.js');
      try {
        const jobId = await startFrameGenerationJob({
          storyboardId: sbId,
          role,
          imageModel: model,
          mode: 'edit',
          editPrompt: raw,
          rotateToPrevious: true,
          announceUsername: req?.session?.username || null,
        });
        res.status(202).json({ job_id: jobId, storyboard_id: sbId, role });
      } catch (e) {
        if (e instanceof BeatBusyError) {
          return res.status(409).json({ error: e.message });
        }
        if (e instanceof EditModeError || e instanceof FrameRoleError) {
          return res.status(400).json({ error: e.message });
        }
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  // Synchronous one-step undo of the last inline edit. Swaps
  // previous_*_frame_id → *_frame_id and deletes the displaced GridFS bytes.
  router.post('/storyboard/:id/frame/:role/undo', async (req, res, next) => {
    try {
      const sbId = await resolveStoryboardId(req);
      if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
      const role = String(req.params.role);
      if (!['start_frame', 'end_frame'].includes(role)) {
        return res.status(400).json({ error: 'role must be start_frame|end_frame' });
      }
      try {
        const storyboard = await undoStoryboardFrameEditViaGateway({
          storyboardId: sbId,
          role,
        });
        res.json({ storyboard });
      } catch (e) {
        if (e?.status === 400) {
          return res.status(400).json({ error: e.message });
        }
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  // Read-only preview of the auto-suggested prompt for a single frame slot.
  // The SPA's generate modal calls this on open when the stored frame prompt
  // is empty, so the user gets a sensible default they can keep or edit.
  router.post(
    '/storyboard/:id/frame/:role/preview-prompt',
    async (req, res, next) => {
      try {
        const sbId = await resolveStoryboardId(req);
        if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
        const role = String(req.params.role);
        if (!['start_frame', 'end_frame'].includes(role)) {
          return res
            .status(400)
            .json({ error: 'role must be start_frame|end_frame' });
        }
        const {
          previewFrameGenerationPrompt,
          BeatBusyError,
          FrameRoleError,
        } = await import('./storyboardGenerate.js');
        try {
          const preview = await previewFrameGenerationPrompt({
            storyboardId: sbId,
            role,
          });
          res.json(preview);
        } catch (e) {
          if (e instanceof BeatBusyError) {
            return res.status(409).json({ error: e.message });
          }
          if (e instanceof FrameRoleError) {
            return res.status(400).json({ error: e.message });
          }
          throw e;
        }
      } catch (e) {
        next(e);
      }
    },
  );

  // Reference-picker options for a single frame slot. Returns three sections
  // the SPA's "This beat" tab renders in order:
  //   sibling_frame — the opposite frame on this row (start when picking for
  //                   end, vice versa), so it's a one-click reference candidate
  //   beat_artwork  — beat.artworks[] filtered to status='done' with a
  //                   result_image_id, so artwork shows up labelled with its
  //                   prompt rather than as a bare GridFS thumbnail
  //   beat_images   — every non-thumbnail GridFS image owned by the beat;
  //                   the SPA dedupes against the two sections above so the
  //                   sibling frame / artwork results don't appear twice
  router.get(
    '/storyboard/:id/frame/:role/picker-options',
    async (req, res, next) => {
      try {
        const sbId = await resolveStoryboardId(req);
        if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
        const role = String(req.params.role);
        if (!['start_frame', 'end_frame'].includes(role)) {
          return res
            .status(400)
            .json({ error: 'role must be start_frame|end_frame' });
        }
        const sb = await getStoryboard(sbId);
        if (!sb) return res.status(404).json({ error: 'storyboard not found' });
        const beat = await getBeat(String(sb.beat_id));
        if (!beat) return res.status(404).json({ error: 'beat not found' });

        const siblingRole =
          role === 'start_frame' ? 'end_frame' : 'start_frame';
        const siblingImageId = sb[`${siblingRole}_id`] || null;
        const siblingLabel =
          siblingRole === 'start_frame' ? 'Start frame' : 'End frame';

        const beatArtwork = (beat.artworks || [])
          .filter((a) => a.status === 'done' && a.result_image_id)
          .map((a) => ({
            _id: String(a.result_image_id),
            name:
              a.name ||
              (a.prompt ? String(a.prompt).slice(0, 80) : '') ||
              'artwork',
            artwork_id: String(a._id),
          }));

        const files = await listImagesForBeat(beat._id);
        const beatImages = files
          .filter((f) => f.metadata?.kind !== 'thumbnail')
          .map(imageFileToMeta);

        res.json({
          sibling_frame: siblingImageId
            ? { image_id: String(siblingImageId), label: siblingLabel }
            : null,
          beat_artwork: beatArtwork,
          beat_images: beatImages,
        });
      } catch (e) {
        next(e);
      }
    },
  );

  // Persist the user's customized prompt for a single frame slot. Idempotent;
  // overwrites the prior stored value.
  router.put('/storyboard/:id/frame/:role/prompt', async (req, res, next) => {
    try {
      const sbId = await resolveStoryboardId(req);
      if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
      const role = String(req.params.role);
      if (!['start_frame', 'end_frame'].includes(role)) {
        return res.status(400).json({ error: 'role must be start_frame|end_frame' });
      }
      const raw = req.body?.text;
      if (typeof raw !== 'string') {
        return res.status(400).json({ error: 'text (string) required' });
      }
      if (raw.length > 8192) {
        return res.status(400).json({ error: 'text must be ≤ 8192 chars' });
      }
      const storyboard = await setStoryboardFramePromptViaGateway({
        storyboardId: sbId,
        role,
        text: raw,
      });
      res.json({ storyboard });
    } catch (e) {
      next(e);
    }
  });

  router.get('/storyboard/frame-generate/job/:jobId', async (req, res, next) => {
    try {
      const { getFrameGenerationJob } = await import('./storyboardGenerate.js');
      const job = getFrameGenerationJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'job not found' });
      res.json({ job });
    } catch (e) {
      next(e);
    }
  });

  function isFrameRole(role) {
    return role === 'start_frame' || role === 'end_frame';
  }

  // Upload a reference image scoped to a single frame (start_frame|end_frame).
  router.post(
    '/storyboard/:id/frame/:role/reference',
    upload.single('file'),
    async (req, res, next) => {
      try {
        const sbId = await resolveStoryboardId(req);
        if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
        const role = String(req.params.role);
        if (!isFrameRole(role)) {
          return res.status(400).json({ error: 'role must be start_frame|end_frame' });
        }
        if (!req.file) return res.status(400).json({ error: 'file required' });
        const sniffed = validateImageBuffer(req.file.buffer);
        const sb = await getStoryboard(sbId);
        const file = await uploadGeneratedImage({
          buffer: req.file.buffer,
          contentType: req.file.mimetype,
          ownerType: 'beat',
          ownerId: sb.beat_id,
          filename: safeFilename(
            req.file.originalname,
            `storyboard-${sbId}-${role}-ref-${Date.now()}.png`,
          ),
        });
        const result = await addStoryboardFrameReferenceImageViaGateway({
          storyboardId: sbId,
          role,
          imageId: file._id,
        });
        res.json({ storyboard: result, image: { _id: file._id, content_type: file.content_type } });
        kickoffImageVisionSeed(file._id, req.file.buffer, sniffed || req.file.mimetype, {
          ownerType: 'beat',
          ownerId: sb.beat_id,
          kind: 'auto',
        });
      } catch (e) {
        next(e);
      }
    },
  );

  router.delete(
    '/storyboard/:id/frame/:role/reference/:imageId',
    async (req, res, next) => {
      try {
        const sbId = await resolveStoryboardId(req);
        if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
        const role = String(req.params.role);
        if (!isFrameRole(role)) {
          return res.status(400).json({ error: 'role must be start_frame|end_frame' });
        }
        if (!isOidHex(req.params.imageId)) {
          return res.status(400).json({ error: 'invalid image_id' });
        }
        const result = await removeStoryboardFrameReferenceImageViaGateway({
          storyboardId: sbId,
          role,
          imageId: req.params.imageId,
        });
        res.json({ storyboard: result });
      } catch (e) {
        next(e);
      }
    },
  );

  // Attach an already-uploaded GridFS image as a per-frame reference.
  router.post(
    '/storyboard/:id/frame/:role/reference/attach',
    async (req, res, next) => {
      try {
        const sbId = await resolveStoryboardId(req);
        if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
        const role = String(req.params.role);
        if (!isFrameRole(role)) {
          return res.status(400).json({ error: 'role must be start_frame|end_frame' });
        }
        const imageId = String(req.body?.image_id || '').trim();
        if (!isOidHex(imageId)) {
          return res.status(400).json({ error: 'image_id (24-hex) required' });
        }
        const file = await findImageFile(imageId);
        if (!file) return res.status(404).json({ error: 'image not found' });
        const result = await addStoryboardFrameReferenceImageViaGateway({
          storyboardId: sbId,
          role,
          imageId,
        });
        res.json({
          storyboard: result,
          image: { _id: imageId, content_type: file.contentType || null },
        });
      } catch (e) {
        next(e);
      }
    },
  );

  // Aggregate every reasonable reference image for this storyboard's scene
  // context (beat images + each in-scene character's sheets/portraits/extras)
  // and append any that aren't already attached to the chosen frame.
  router.post(
    '/storyboard/:id/frame/:role/reference/auto-populate',
    async (req, res, next) => {
      try {
        const sbId = await resolveStoryboardId(req);
        if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
        const role = String(req.params.role);
        if (!isFrameRole(role)) {
          return res.status(400).json({ error: 'role must be start_frame|end_frame' });
        }
        const sb = await getStoryboard(sbId);
        if (!sb) return res.status(404).json({ error: 'storyboard not found' });
        const beat = await getBeat(String(sb.beat_id));
        const existing =
          role === 'start_frame'
            ? sb.start_frame_reference_ids
            : sb.end_frame_reference_ids;
        const { ids, added } = await collectStoryboardReferenceIds({
          beat,
          charactersInScene: sb.characters_in_scene || [],
          existingIds: existing || [],
        });
        const storyboard = added.length
          ? await setStoryboardFrameReferenceImagesViaGateway({
              storyboardId: sbId,
              role,
              imageIds: ids,
              mode: 'append',
            })
          : sb;
        res.json({ storyboard, added, total: ids.length });
      } catch (e) {
        next(e);
      }
    },
  );

  // Replace a frame's reference list with the exact list provided. Used by
  // the multi-select picker's Apply button so a single round-trip commits
  // both additions and removals.
  router.post(
    '/storyboard/:id/frame/:role/reference/set',
    async (req, res, next) => {
      try {
        const sbId = await resolveStoryboardId(req);
        if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
        const role = String(req.params.role);
        if (!isFrameRole(role)) {
          return res.status(400).json({ error: 'role must be start_frame|end_frame' });
        }
        const raw = req.body?.image_ids;
        if (!Array.isArray(raw)) {
          return res.status(400).json({ error: 'image_ids (array) required' });
        }
        const cleaned = [];
        for (const v of raw) {
          const s = String(v || '').trim();
          if (!isOidHex(s)) {
            return res.status(400).json({ error: `invalid image_id: ${s}` });
          }
          cleaned.push(s);
        }
        const storyboard = await setStoryboardFrameReferenceImagesViaGateway({
          storyboardId: sbId,
          role,
          imageIds: cleaned,
          mode: 'replace',
        });
        res.json({ storyboard });
      } catch (e) {
        next(e);
      }
    },
  );

  // Generate a fresh image from a custom prompt and attach as a per-frame
  // reference. The picker's Generate tab uses this when role is 'reference'.
  router.post(
    '/storyboard/:id/frame/:role/reference/generate',
    async (req, res, next) => {
      try {
        const sbId = await resolveStoryboardId(req);
        if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
        const role = String(req.params.role);
        if (!isFrameRole(role)) {
          return res.status(400).json({ error: 'role must be start_frame|end_frame' });
        }
        const prompt = String(req.body?.prompt || '').trim();
        if (!prompt) {
          return res.status(400).json({ error: 'prompt (non-empty) required' });
        }
        if (prompt.length > 2048) {
          return res.status(400).json({ error: 'prompt must be ≤ 2048 chars' });
        }
        const model = normalizeImageModel(req.body?.model);
        if (!isValidImageModel(model)) {
          return res.status(400).json({ error: IMAGE_MODEL_ERROR });
        }
        const sb = await getStoryboard(sbId);
        const { dispatchImageReplace } = await import('./imageReplaceDispatch.js');
        const result = await dispatchImageReplace({
          prompt,
          mode: 'generate',
          model,
          discordUser: webDiscordUser(req),
        });
        const file = await uploadGeneratedImage({
          buffer: result.buffer,
          contentType: result.contentType,
          prompt,
          generatedBy: result.model || model,
          ownerType: 'beat',
          ownerId: sb.beat_id,
          filename: `storyboard-${sbId}-${role}-ref-gen-${Date.now()}.png`,
        });
        const updated = await addStoryboardFrameReferenceImageViaGateway({
          storyboardId: sbId,
          role,
          imageId: file._id,
        });
        res.json({
          storyboard: updated,
          image: { _id: file._id, content_type: file.content_type },
        });
        kickoffImageVisionSeed(file._id, result.buffer, result.contentType, {
          ownerType: 'beat',
          ownerId: sb.beat_id,
          kind: 'auto',
        });
      } catch (e) {
        if (e?.status >= 400 && e?.status < 600) {
          return res.status(e.status).json({ error: e.message });
        }
        next(e);
      }
    },
  );

  // Install an already-uploaded GridFS image as start_frame / end_frame on a
  // storyboard. Picker uses this for the "this beat", "characters", and
  // "library" tabs when the user picks an existing image for one of the
  // single-image roles.
  router.post('/storyboard/:id/image/from-id', async (req, res, next) => {
    try {
      const sbId = await resolveStoryboardId(req);
      if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
      const role = String(req.body?.role || '').trim();
      if (!['start_frame', 'end_frame'].includes(role)) {
        return res.status(400).json({ error: 'role must be start_frame|end_frame' });
      }
      const imageId = String(req.body?.image_id || '').trim();
      if (!isOidHex(imageId)) {
        return res.status(400).json({ error: 'image_id (24-hex) required' });
      }
      const file = await findImageFile(imageId);
      if (!file) return res.status(404).json({ error: 'image not found' });
      const result = await setStoryboardImageViaGateway({
        storyboardId: sbId,
        role,
        imageId,
      });
      res.json({
        storyboard: result,
        image: { _id: imageId, content_type: file.contentType || null },
      });
      if (result?.beat_id) {
        announceStoryboardMedia({
          req,
          beat: await getBeat(String(result.beat_id)),
          storyboard: result,
          verb: role === 'start_frame' ? 'added a start frame to' : 'added an end frame to',
          imageFileId: imageId,
        });
      }
    } catch (e) {
      next(e);
    }
  });

  // Generate an image from a custom prompt and install it as start_frame /
  // end_frame. No scene context, no references — pure text-to-image.
  router.post('/storyboard/:id/image/generate', async (req, res, next) => {
    try {
      const sbId = await resolveStoryboardId(req);
      if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
      const role = String(req.body?.role || '').trim();
      if (!['start_frame', 'end_frame'].includes(role)) {
        return res.status(400).json({ error: 'role must be start_frame|end_frame' });
      }
      const prompt = String(req.body?.prompt || '').trim();
      if (!prompt) {
        return res.status(400).json({ error: 'prompt (non-empty) required' });
      }
      if (prompt.length > 2048) {
        return res.status(400).json({ error: 'prompt must be ≤ 2048 chars' });
      }
      const model = normalizeImageModel(req.body?.model);
      if (!isValidImageModel(model)) {
        return res.status(400).json({ error: IMAGE_MODEL_ERROR });
      }
      const sb = await getStoryboard(sbId);
      const { dispatchStoryboardImage } = await import('./storyboardImageDispatch.js');
      const result = await dispatchStoryboardImage({
        prompt,
        model,
        inputImages: [],
        mode: 'generate',
      });
      const file = await uploadGeneratedImage({
        buffer: result.buffer,
        contentType: result.contentType,
        prompt,
        generatedBy: result.model || model,
        ownerType: 'beat',
        ownerId: sb.beat_id,
        filename: `storyboard-${sbId}-${role}-gen-${Date.now()}.png`,
      });
      const updated = await setStoryboardImageViaGateway({
        storyboardId: sbId,
        role,
        imageId: file._id,
      });
      res.json({
        storyboard: updated,
        image: { _id: file._id, content_type: file.content_type },
      });
      announceStoryboardMedia({
        req,
        beat: await getBeat(String(sb.beat_id)),
        storyboard: updated || sb,
        verb:
          role === 'start_frame'
            ? 'generated a start frame on'
            : 'generated an end frame on',
        imageFileId: file._id,
        prompt,
      });
      kickoffImageVisionSeed(file._id, result.buffer, result.contentType, {
        ownerType: 'beat',
        ownerId: sb.beat_id,
        kind: 'auto',
      });
    } catch (e) {
      if (e?.status >= 400 && e?.status < 600) {
        return res.status(e.status).json({ error: e.message });
      }
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
      announceStoryboardMedia({
        req,
        beat: await getBeat(String(sb.beat_id)),
        storyboard: result || sb,
        verb: 'added audio to',
        mediaFileId: file._id,
        mediaLabel: file.filename || 'audio',
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
      if (result?.beat_id) {
        announceStoryboardMedia({
          req,
          beat: await getBeat(String(result.beat_id)),
          storyboard: result,
          verb: 'deleted audio from',
        });
      }
    } catch (e) {
      next(e);
    }
  });

  // fal.ai video generation. Returns 202 + { job_id } immediately; the SPA
  // opens an EventSource at /storyboard/:id/video-job/:jobId/events for
  // pushed status updates. `model_id` chooses which fal model — see
  // src/fal/videoModels.js for the registered list; defaults to the
  // configured default (kling-3-pro).
  // Build a preview of the exact payload the orchestrator would send to fal.
  // Returns the resolved prompt, duration, and per-input file metadata
  // (image_id / attachment_id, filename, content_type, size) plus a payload
  // object with screenplay-preview:// sentinel URLs in place of fal.media
  // URLs. The SPA renders this so the user can confirm exactly which assets
  // are about to leave the server before /video/generate is called for real.
  router.post('/storyboard/:id/video/preview', async (req, res, next) => {
    try {
      const sbId = await resolveStoryboardId(req);
      if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
      const prompt =
        typeof req.body?.prompt === 'string' && req.body.prompt.trim()
          ? req.body.prompt.trim()
          : null;
      if (prompt && prompt.length > 2000) {
        return res.status(400).json({ error: 'prompt must be ≤ 2000 chars' });
      }
      const rawDuration = req.body?.duration_seconds;
      let durationSeconds = null;
      if (rawDuration != null && rawDuration !== '') {
        const n = Number(rawDuration);
        if (!Number.isFinite(n) || n < 1 || n > 15) {
          return res
            .status(400)
            .json({ error: 'duration_seconds must be a number between 1 and 15' });
        }
        durationSeconds = n;
      }
      const modelId =
        typeof req.body?.model_id === 'string' && req.body.model_id.trim()
          ? req.body.model_id.trim()
          : null;
      const generateAudio =
        req.body?.generate_audio === undefined ? true : Boolean(req.body.generate_audio);
      const resolution = parseResolutionField(req.body?.resolution, res);
      if (resolution === ERR) return; // response already sent
      const fps = parseFpsField(req.body?.fps, res);
      if (fps === ERR) return; // response already sent
      try {
        const preview = await buildVideoPayloadPreview({
          storyboardId: sbId,
          modelId,
          prompt,
          durationSeconds,
          generateAudio,
          resolution,
          fps,
        });
        res.json(preview);
      } catch (e) {
        if (e instanceof MissingInputsError) {
          return res.status(400).json({ error: e.message, missing: e.missing });
        }
        if (e instanceof FalNotConfiguredError) {
          return res.status(503).json({ error: e.message });
        }
        if (e instanceof UnknownVideoModelError) {
          return res.status(400).json({ error: e.message });
        }
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  router.post('/storyboard/:id/video/generate', async (req, res, next) => {
    try {
      const sbId = await resolveStoryboardId(req);
      if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
      const prompt =
        typeof req.body?.prompt === 'string' && req.body.prompt.trim()
          ? req.body.prompt.trim()
          : null;
      if (prompt && prompt.length > 2000) {
        return res.status(400).json({ error: 'prompt must be ≤ 2000 chars' });
      }
      const rawDuration = req.body?.duration_seconds;
      let durationSeconds = null;
      if (rawDuration != null && rawDuration !== '') {
        const n = Number(rawDuration);
        if (!Number.isFinite(n) || n < 1 || n > 15) {
          return res
            .status(400)
            .json({ error: 'duration_seconds must be a number between 1 and 15' });
        }
        durationSeconds = n;
      }
      const modelId =
        typeof req.body?.model_id === 'string' && req.body.model_id.trim()
          ? req.body.model_id.trim()
          : null;
      const generateAudio =
        req.body?.generate_audio === undefined ? true : Boolean(req.body.generate_audio);
      const resolution = parseResolutionField(req.body?.resolution, res);
      if (resolution === ERR) return; // response already sent
      const fps = parseFpsField(req.body?.fps, res);
      if (fps === ERR) return; // response already sent
      try {
        const { job_id } = await startVideoGenerationJob({
          storyboardId: sbId,
          modelId,
          prompt,
          durationSeconds,
          generateAudio,
          resolution,
          fps,
          announceUsername: req?.session?.username || null,
        });
        res.status(202).json({ job_id });
      } catch (e) {
        if (e instanceof VideoBeatBusyError) {
          return res.status(409).json({ error: e.message });
        }
        if (e instanceof MissingInputsError) {
          return res.status(400).json({ error: e.message, missing: e.missing });
        }
        if (e instanceof FalNotConfiguredError) {
          return res.status(503).json({ error: e.message });
        }
        if (e instanceof UnknownVideoModelError) {
          return res.status(400).json({ error: e.message });
        }
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  // List the fal video models the SPA picker should expose. Combines the
  // server-side registry (hand-tuned, executable) with data/fal-models.json
  // (the wide catalog of i2v endpoints, browse-only). The SPA picker uses
  // `is_registered` to decide which rows are selectable for generation.
  router.get('/video-models', async (_req, res, next) => {
    try {
      const { loadCatalog } = await import('../fal/videoModels.js');
      const { config } = await import('../config.js');
      const catalog = await loadCatalog();
      res.json({
        default_model_id: config.fal.defaultModelId,
        configured: Boolean(config.fal.apiKey),
        catalog_generated_at: catalog.generated_at,
        catalog_error: catalog.catalog_error,
        models: catalog.models,
      });
    } catch (err) {
      next(err);
    }
  });

  // Discard the current video on a storyboard scene. Deletes the GridFS
  // attachment and clears video_file_id. The fal request can't be recalled,
  // but its output URL expires on fal's storage TTL anyway.
  router.delete('/storyboard/:id/video', async (req, res, next) => {
    try {
      const sbId = await resolveStoryboardId(req);
      if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
      const sb = await getStoryboard(sbId);
      const oldId = sb?.video_file_id || null;
      const result = await setStoryboardVideoViaGateway({
        storyboardId: sbId,
        videoFileId: null,
      });
      if (oldId) {
        try {
          await deleteAttachment(oldId);
        } catch (e) {
          logger.warn(`storyboard video delete: GridFS cleanup ${oldId} failed: ${e.message}`);
        }
      }
      res.json({ storyboard: result });
      if (result?.beat_id) {
        announceStoryboardMedia({
          req,
          beat: await getBeat(String(result.beat_id)),
          storyboard: result,
          verb: 'deleted video from',
        });
      }
    } catch (e) {
      next(e);
    }
  });

  // Copy a dialog item's audio onto this scene as an independent file. The
  // dialog and scene keep separate GridFS files — deleting one does not
  // affect the other.
  router.post('/storyboard/:id/audio/from-dialog', async (req, res, next) => {
    try {
      const sbId = await resolveStoryboardId(req);
      if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
      const dialogId = req.body?.dialog_id;
      if (!isOidHex(String(dialogId || ''))) {
        return res.status(400).json({ error: 'dialog_id required' });
      }
      try {
        const result = await copyDialogAudioToStoryboardViaGateway({
          storyboardId: sbId,
          dialogId: String(dialogId),
        });
        res.json(result);
        const sb = result?.storyboard || result;
        if (sb?.beat_id) {
          announceStoryboardMedia({
            req,
            beat: await getBeat(String(sb.beat_id)),
            storyboard: sb,
            verb: 'added audio (from a dialog) to',
            mediaFileId: sb.audio_file_id || null,
            mediaLabel: 'audio',
          });
        }
      } catch (e) {
        if (
          /no audio to copy|different beats|not found/i.test(e.message || '')
        ) {
          return res.status(400).json({ error: e.message });
        }
        throw e;
      }
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
      const imageModel = normalizeImageModel(req.body?.image_model);
      if (!isValidImageModel(imageModel)) {
        return res.status(400).json({ error: IMAGE_MODEL_ERROR });
      }
      const direction =
        typeof req.body?.direction === 'string' ? req.body.direction : '';
      const { startStoryboardGenerationJob, BeatBusyError } = await import(
        './storyboardGenerate.js'
      );
      try {
        const jobId = await startStoryboardGenerationJob({
          beatId: beat._id.toString(),
          targetCount: target,
          imageModel,
          direction,
          announceUsername: req?.session?.username || null,
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

  // LLM-suggested frame count for a beat. Returns { count, reason } where
  // count may be null on failure (missing API key, model didn't tool-call,
  // etc.) and reason carries either the rationale or an error code.
  router.post('/storyboards/analyze-count', async (req, res, next) => {
    try {
      const beatRef = req.body?.beat_id;
      if (!beatRef) return res.status(400).json({ error: 'beat_id required' });
      const beat = await getBeat(String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const direction =
        typeof req.body?.direction === 'string' ? req.body.direction : '';
      const { findCharactersInBeat } = await import('./storyboardGenerate.js');
      const characters = await findCharactersInBeat(beat);
      const { analyzeStoryboardCount } = await import(
        '../llm/storyboardCountAnalyze.js'
      );
      const result = await analyzeStoryboardCount({ beat, characters, direction });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  // Returns the exact Stage A (outline) system + user messages that would be
  // sent to the planner with the current settings. No LLM call; powers the
  // "Prompt Preview" tab on the storyboard generation dialog.
  router.post('/storyboards/preview-prompt', async (req, res, next) => {
    try {
      const beatRef = req.body?.beat_id;
      if (!beatRef) return res.status(400).json({ error: 'beat_id required' });
      const beat = await getBeat(String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const direction =
        typeof req.body?.direction === 'string' ? req.body.direction : '';
      const count =
        Number(req.body?.count) > 0 ? Number(req.body.count) : null;
      const {
        findCharactersInBeat,
        buildOutlineUserText,
        loadDirectorNotesForPlanner,
        OUTLINE_SYSTEM_PROMPT,
      } = await import('./storyboardGenerate.js');
      const characters = await findCharactersInBeat(beat);
      const directorNotes = await loadDirectorNotesForPlanner();
      const user = buildOutlineUserText({
        beat,
        characters,
        targetCount: count,
        direction,
        directorNotes,
      });
      res.json({ system: OUTLINE_SYSTEM_PROMPT, user });
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

  // Set the speaker on a dialog item. Roster character names are canonicalized
  // to their stored spelling; anything else is saved as a free-text speaker
  // (e.g. "radio", "TV ANCHOR"). Empty input is rejected.
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
        if (/character is required/.test(e.message)) {
          return res.status(400).json({ error: e.message });
        }
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  // Upload an audio recording or file for this dialog item. The file is
  // validated as audio/* and stored in the attachments GridFS bucket; the
  // dialog's audio_file_id is updated through the gateway so a stateless
  // ping refreshes connected SPAs.
  router.post('/dialog/:id/audio', upload.single('file'), async (req, res, next) => {
    try {
      const dId = await resolveDialogId(req);
      if (!dId) return res.status(404).json({ error: 'dialog not found' });
      if (!req.file) return res.status(400).json({ error: 'file required' });
      const ct = req.file.mimetype || 'audio/mpeg';
      if (!ct.startsWith('audio/')) {
        return res.status(400).json({ error: 'file must be audio/*' });
      }
      const dialog = await getDialog(dId);
      const file = await uploadAttachmentBuffer({
        buffer: req.file.buffer,
        filename: safeFilename(
          req.file.originalname,
          `dialog-${dId}-audio-${Date.now()}.bin`,
        ),
        contentType: ct,
        ownerType: 'dialog',
        ownerId: dialog._id,
      });
      const result = await setDialogAudioViaGateway({
        dialogId: dId,
        audioFileId: file._id,
      });
      res.json({
        dialog: result,
        audio: {
          _id: file._id,
          filename: file.filename,
          content_type: file.content_type,
          size: file.size,
        },
      });
      if (dialog?.beat_id) {
        announceBeatMedia({
          req,
          beat: await getBeat(String(dialog.beat_id)),
          verb: 'added dialog audio in',
          mediaFileId: file._id,
          mediaLabel: file.filename || 'audio',
        });
      }
    } catch (e) {
      next(e);
    }
  });

  router.delete('/dialog/:id/audio', async (req, res, next) => {
    try {
      const dId = await resolveDialogId(req);
      if (!dId) return res.status(404).json({ error: 'dialog not found' });
      const result = await setDialogAudioViaGateway({
        dialogId: dId,
        audioFileId: null,
      });
      res.json({ dialog: result });
      if (result?.beat_id) {
        announceBeatMedia({
          req,
          beat: await getBeat(String(result.beat_id)),
          verb: 'deleted dialog audio from',
        });
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
