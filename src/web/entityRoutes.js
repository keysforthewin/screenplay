// REST routes for the SPA. All require a valid session via X-Session-Id header.
//
// Reads are direct Mongo lookups (no gateway involvement).
// Mutations go through src/web/gateway.js so the y-doc and stateless ping fire.

import express from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { logger } from '../log.js';
import { contentTypeFromFilename } from '../util/contentType.js';
import { convertToMp3 } from './audioTranscode.js';
import { requireSession } from './auth.js';
import { runAsEditor } from './editAttribution.js';
import { resolveProject } from './projectMiddleware.js';
import { requireProjectAccess, requireAdmin, listProjectsFor } from './permissions.js';
import { buildAdminRouter } from './adminRoutes.js';
import { buildElevenRouter } from './elevenRoutes.js';
import { buildComfyRouter, registerCutVideoRoutes } from './comfyRoutes.js';
import { registerCutRoutes } from './cutRoutes.js';
import { registerCutFalVideoRoutes, cutVideoJobEventsHandler } from './cutVideoRoutes.js';
import {
  countProjects,
  createProject,
  getProjectById,
  getProjectByTitle,
  normalizeProjectTitle,
  renameProject,
} from '../mongo/projects.js';
import { deleteProjectCascade } from './projectDelete.js';
import { seedProjectDefaults } from '../seed/defaults.js';
import {
  DEFAULT_IMAGE_MODEL,
  normalizeImageModel,
  isValidImageModel,
  IMAGE_MODEL_ERROR,
} from './imageModelValidate.js';
import { listImageModelInfo } from './imageModelInfo.js';
import { getSession, touchSession } from '../mongo/auth.js';
import {
  announceBeatMedia,
  announceCharacterMedia,
  announceSetMedia,
  announceNoteMedia,
  announceLibraryMedia,
} from './announceHelpers.js';
import {
  startPlaygroundJob,
  getPlaygroundJob,
  subscribeToPlaygroundJob,
  unsubscribeFromPlaygroundJob,
  serializePlaygroundJob,
} from './playgroundGenerate.js';
import { loadPlaygroundCatalog, classifyMediaKind } from '../fal/playgroundModels.js';
import {
  startChatRun,
  getChatRun,
  subscribeToChatRun,
  unsubscribeFromChatRun,
  serializeChatRun,
} from './chatRuns.js';
import { webChannelId, loadWebDisplayHistory, computeHistoryStats } from './chatHistory.js';
import { setHistoryClearedAt } from '../mongo/channelState.js';
import {
  addBeatImageViaGateway,
  addBeatAttachmentViaGateway,
  addCharacterAttachmentViaGateway,
  addCharacterImageViaGateway,
  addDirectorNoteAttachmentViaGateway,
  addDirectorNoteImageViaGateway,
  addDirectorNoteViaGateway,
  addLibraryImageViaGateway,
  attachExistingAttachmentToBeatViaGateway,
  attachExistingAttachmentToCharacterViaGateway,
  attachExistingImageToBeatViaGateway,
  attachExistingImageToCharacterViaGateway,
  createDialogViaGateway,
  deleteDialogViaGateway,
  removeBeatAttachmentViaGateway,
  removeBeatImageViaGateway,
  removeCharacterAttachmentViaGateway,
  removeCharacterImageViaGateway,
  removeDirectorNoteAttachmentViaGateway,
  removeDirectorNoteImageViaGateway,
  removeDirectorNoteViaGateway,
  removeLibraryImageViaGateway,
  replaceBeatImageViaGateway,
  replaceCharacterImageViaGateway,
  moveBeatImageToLibraryViaGateway,
  moveCharacterImageToLibraryViaGateway,
  reorderDialogsViaGateway,
  reorderBeatsViaGateway,
  createBeatViaGateway,
  deleteBeatViaGateway,
  setBeatMainImageViaGateway,
  setCharacterMainImageViaGateway,
  setDirectorNoteMainImageViaGateway,
  setDialogAudioViaGateway,
  setEntityFieldMarkdown,
  updateBeatViaGateway,
  addSetImageViaGateway,
  addSetAttachmentViaGateway,
  removeSetImageViaGateway,
  removeSetAttachmentViaGateway,
  setSetMainImageViaGateway,
  replaceSetImageViaGateway,
  attachExistingImageToSetViaGateway,
  attachExistingAttachmentToSetViaGateway,
  moveSetImageToLibraryViaGateway,
  createSetViaGateway,
  createCharacterViaGateway,
} from './gateway.js';
import {
  kickoffLibraryVisionSeed,
  kickoffImageVisionSeed,
} from './libraryVisionWorker.js';
import {
  describeArtwork,
  kickoffArtworkVisionSeed,
} from './artworkVisionWorker.js';
import { getPlot, listBeats, getBeat } from '../mongo/plots.js';
import {
  startGenerateArtworkJob,
  startRegenerateArtworkJob,
  startEditArtworkJob,
  undoArtworkEdit,
  deleteArtwork,
} from './artworkJobs.js';
import {
  patchArtworkViaGateway,
  createArtworkFromImageViaGateway,
} from './gateway.js';
import {
  countDialogsByBeat,
  getDialog,
  listDialogs,
} from '../mongo/dialogs.js';
import {
  countVideoPromptsByBeat,
} from '../mongo/videoPrompts.js';
import { getCharacter, findAllCharacters } from '../mongo/characters.js';
import { getSet, findAllSets } from '../mongo/sets.js';
import { getDirectorNotes } from '../mongo/directorNotes.js';
import {
  deleteImage,
  listLibraryImages,
  listImagesForBeat,
  listImagesForCharacter,
  listImagesForSet,
  listImagesByOwnerType,
  listPlaygroundGeneratedImages,
  imageFileToMeta,
  uploadGeneratedImage,
  findImageFile,
  readImageBuffer,
} from '../mongo/images.js';
import { copyImageToNewOwner } from '../mongo/imageCopy.js';
import { validateImageBuffer } from '../mongo/imageBytes.js';
import {
  listLibraryAttachments,
  listPlaygroundGeneratedAttachments,
  attachmentFileToMeta,
  uploadAttachmentBuffer,
  deleteAttachment,
  findAttachmentFile,
} from '../mongo/attachments.js';
import { getCharacterTemplate, getPlotTemplate } from '../mongo/prompts.js';
import { stripMarkdown } from '../util/markdown.js';
import { buildTocResponse } from './toc.js';
import { exportToPdf, slugifyFilename } from '../pdf/export.js';

const HEX24 = /^[a-f0-9]{24}$/i;

const ALLOWED_CONTEXT_KINDS = new Set([
  'overview', 'beat', 'character', 'notes', 'library',
  'dialog', 'dialog-index', 'about',
]);

// Parse the SPA's optional page-context hint from a /chat body. Unknown/malformed
// context returns null and is simply not forwarded — a stale SPA bundle must
// never turn a chat message into a 400.
function parseChatContext(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kind = String(raw.kind || '');
  if (!ALLOWED_CONTEXT_KINDS.has(kind)) return null;
  let ref = null;
  if (typeof raw.ref === 'string' || typeof raw.ref === 'number') {
    ref = String(raw.ref).trim().slice(0, 80) || null;
  }
  return { kind, ref };
}

function isOidHex(s) {
  return typeof s === 'string' && HEX24.test(s);
}

function safeFilename(name, fallback) {
  const s = String(name || '').trim();
  if (!s) return fallback;
  return s.replace(/[\\/]+/g, '_').slice(0, 200);
}

// Swap any extension for `.mp3` (fallback names end in `.bin`; recordings in
// `.webm`/`.m4a`).
function mp3Filename(name) {
  return String(name).replace(/\.[^.\/]*$/, '') + '.mp3';
}

// Normalize a freshly uploaded audio file to MP3 so every fal model — notably
// seedance r2v, which only accepts MP3 — can ingest it. Already-MP3 uploads
// pass through untouched. Throws FfmpegMissingError / AudioTranscodeError;
// callers map those to HTTP statuses (the upload routes fail loudly rather
// than silently storing a format fal will reject later).
async function normalizeUploadedAudioToMp3({ file, contentType, fallbackName }) {
  const bareCt = String(contentType || '').split(';')[0].trim().toLowerCase();
  const filename = safeFilename(file.originalname, fallbackName);
  if (bareCt === 'audio/mpeg') {
    return { buffer: file.buffer, contentType: 'audio/mpeg', filename };
  }
  const buffer = await convertToMp3(file.buffer);
  return { buffer, contentType: 'audio/mpeg', filename: mp3Filename(filename) };
}

// Shared error→status mapping for the audio upload routes.
function sendAudioTranscodeError(res, e) {
  // Match on the stable `code` rather than `instanceof` — the latter is
  // unreliable across module-instance boundaries (e.g. test harness imports).
  if (e?.code === 'FFMPEG_MISSING') {
    return res.status(503).json({ error: 'audio upload requires ffmpeg on the server' });
  }
  if (e?.code === 'AUDIO_TRANSCODE_FAILED') {
    return res.status(422).json({ error: 'could not convert audio to MP3' });
  }
  return null;
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

  // Resolve the viewer's project for every /api route. Mounted BEFORE the SSE
  // route below (not next to requireSession) because EventSource cannot set
  // custom headers — the SSE route relies on this middleware's ?project_id=
  // query fallback. resolveProject never reads the session, so the early
  // mount grants nothing to unauthenticated callers beyond a 404 oracle.
  // Carried improvement 3: GET /projects is exempted inside resolveProject
  // (see projectMiddleware.js) so a stale X-Project-Id for a vanished project
  // can't 404 the recovery fetch. POST stays behind resolution for symmetry.
  router.use(resolveProject());

  // Pre-auth SSE routes: EventSource cannot set custom headers, so each of
  // these validates a session id from the query string instead.
  // Cut renders (ComfyUI or fal) stream through the shared cut job lookup
  // (src/web/cutVideoRoutes.js).
  router.get('/cut/:id/video-job/:jobId/events', cutVideoJobEventsHandler);

  // Server-Sent Events stream of a Prompts-tab cut render job
  // (src/web/cutBeatRender.js). Same pre-auth session_id handshake.
  // Cut planner (Auto generate / Replan) live progress: steps, activity log
  // and the model's streamed output counters. Same auth + framing as the
  // render feed above.
  router.get('/video-scenes/generate/:jobId/events', async (req, res, next) => {
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

      const { getCutPlanJob, subscribeToCutPlanJob, unsubscribeFromCutPlanJob, serializeCutPlanJob } =
        await import('./cutPlanner.js');
      const job = getCutPlanJob(req.params.jobId);
      if (!job) {
        res.status(404).json({ error: 'job not found' });
        return;
      }
      const isTerminal = (s) => s === 'done' || s === 'partial' || s === 'error';
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      res.write(`event: snapshot\ndata: ${JSON.stringify(serializeCutPlanJob(job))}\n\n`);

      const listener = (snap) => {
        const terminal = isTerminal(snap.status);
        res.write(`event: ${terminal ? snap.status : 'update'}\ndata: ${JSON.stringify(snap)}\n\n`);
        if (terminal) {
          unsubscribeFromCutPlanJob(snap.job_id, listener);
          res.end();
        }
      };
      subscribeToCutPlanJob(req.params.jobId, listener);

      if (isTerminal(job.status)) {
        unsubscribeFromCutPlanJob(req.params.jobId, listener);
        res.end();
        return;
      }

      const keepalive = setInterval(() => {
        res.write(`: keepalive ${Date.now()}\n\n`);
      }, 20_000);
      keepalive.unref?.();

      req.on('close', () => {
        clearInterval(keepalive);
        unsubscribeFromCutPlanJob(req.params.jobId, listener);
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/cuts/render/job/:jobId/events', async (req, res, next) => {
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

      const { getCutBeatRenderJob, subscribeToCutBeatJob, unsubscribeFromCutBeatJob, serializeCutBeatJob } =
        await import('./cutBeatRender.js');
      const job = getCutBeatRenderJob(req.params.jobId);
      if (!job) {
        res.status(404).json({ error: 'job not found' });
        return;
      }
      const isTerminal = (s) => s === 'done' || s === 'partial' || s === 'error';
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      res.write(`event: snapshot\ndata: ${JSON.stringify(serializeCutBeatJob(job))}\n\n`);

      const listener = (snap) => {
        const terminal = isTerminal(snap.status);
        const eventName = terminal ? snap.status : 'update';
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(snap)}\n\n`);
        if (terminal) {
          unsubscribeFromCutBeatJob(snap.job_id, listener);
          res.end();
        }
      };
      subscribeToCutBeatJob(req.params.jobId, listener);

      if (isTerminal(job.status)) {
        unsubscribeFromCutBeatJob(req.params.jobId, listener);
        res.end();
        return;
      }

      const keepalive = setInterval(() => {
        res.write(`: keepalive ${Date.now()}\n\n`);
      }, 20_000);
      keepalive.unref?.();

      req.on('close', () => {
        clearInterval(keepalive);
        unsubscribeFromCutBeatJob(req.params.jobId, listener);
      });
    } catch (e) {
      next(e);
    }
  });

  // Server-Sent Events stream of a web chat agent run. Registered BEFORE
  // requireSession() for the same EventSource-can't-set-headers reason as
  // the video-job stream above.
  router.get('/chat/:runId/events', async (req, res, next) => {
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

      const run = getChatRun(req.params.runId);
      if (!run) {
        res.status(404).json({ error: 'run not found' });
        return;
      }
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      // Initial snapshot replays accumulated progress for reconnects.
      res.write(`event: snapshot\ndata: ${JSON.stringify(serializeChatRun(run))}\n\n`);

      const listener = (snap) => {
        const terminal = snap.status === 'done' || snap.status === 'error';
        const eventName = terminal ? snap.status : 'progress';
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(snap)}\n\n`);
        if (terminal) {
          unsubscribeFromChatRun(snap.run_id, listener);
          res.end();
        }
      };
      subscribeToChatRun(req.params.runId, listener);

      // Already terminal at connect time — the snapshot said everything.
      if (run.status === 'done' || run.status === 'error') {
        unsubscribeFromChatRun(req.params.runId, listener);
        res.end();
        return;
      }

      const keepalive = setInterval(() => {
        res.write(`: keepalive ${Date.now()}\n\n`);
      }, 20_000);
      keepalive.unref?.();

      req.on('close', () => {
        clearInterval(keepalive);
        unsubscribeFromChatRun(req.params.runId, listener);
      });
    } catch (e) {
      next(e);
    }
  });

  // SSE stream of a beat critique run. Registered BEFORE requireSession() —
  // EventSource cannot set headers, so the session id arrives in the query.
  router.get('/beat/:id/critique/:jobId/events', async (req, res, next) => {
    try {
      const sid = String(req.query?.session_id || '');
      if (!sid) { res.status(401).json({ error: 'missing session' }); return; }
      const session = await getSession(sid);
      if (!session) { res.status(401).json({ error: 'invalid session' }); return; }
      touchSession(sid).catch(() => {});
      req.session = session;

      const {
        getCritiqueJob, subscribeToCritiqueJob, unsubscribeFromCritiqueJob, serializeCritiqueJob,
      } = await import('./critiqueGenerate.js');
      // Keyed on the server-minted job id (an unguessable ObjectId returned only
      // to the authenticated starter of the run) — same capability model as the
      // video-job SSE route. The mutating routes enforce project scoping.
      const job = getCritiqueJob(req.params.jobId);
      if (!job) { res.status(404).json({ error: 'job not found' }); return; }

      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      res.write(`event: snapshot\ndata: ${JSON.stringify(serializeCritiqueJob(job))}\n\n`);

      const listener = (snap) => {
        const terminal = snap.status === 'done' || snap.status === 'partial' || snap.status === 'error';
        const eventName = terminal ? (snap.status === 'error' ? 'error' : 'done') : 'update';
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(snap)}\n\n`);
        if (terminal) { unsubscribeFromCritiqueJob(snap.job_id, listener); res.end(); }
      };
      subscribeToCritiqueJob(req.params.jobId, listener);

      if (job.status === 'done' || job.status === 'partial' || job.status === 'error') {
        unsubscribeFromCritiqueJob(req.params.jobId, listener);
        res.end();
        return;
      }

      const keepalive = setInterval(() => { res.write(`: keepalive ${Date.now()}\n\n`); }, 20_000);
      keepalive.unref?.();
      req.on('close', () => { clearInterval(keepalive); unsubscribeFromCritiqueJob(req.params.jobId, listener); });
    } catch (e) { next(e); }
  });

  // Server-Sent Events stream of a playground generation job. Registered
  // BEFORE requireSession() for the same EventSource-can't-set-headers
  // reason as the video-job stream above.
  router.get('/playground/job/:jobId/events', async (req, res, next) => {
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

      const job = getPlaygroundJob(req.params.jobId);
      if (!job) {
        res.status(404).json({ error: 'job not found' });
        return;
      }
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      res.write(`event: snapshot\ndata: ${JSON.stringify(serializePlaygroundJob(job))}\n\n`);

      const listener = (snap) => {
        const terminal = snap.status === 'done' || snap.status === 'error';
        const eventName = terminal ? snap.status : 'update';
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(snap)}\n\n`);
        if (terminal) {
          unsubscribeFromPlaygroundJob(snap.job_id, listener);
          res.end();
        }
      };
      subscribeToPlaygroundJob(req.params.jobId, listener);

      if (job.status === 'done' || job.status === 'error') {
        unsubscribeFromPlaygroundJob(req.params.jobId, listener);
        res.end();
        return;
      }

      const keepalive = setInterval(() => {
        res.write(`: keepalive ${Date.now()}\n\n`);
      }, 20_000);
      keepalive.unref?.();
      req.on('close', () => {
        clearInterval(keepalive);
        unsubscribeFromPlaygroundJob(req.params.jobId, listener);
      });
    } catch (e) {
      next(e);
    }
  });

  router.use(requireSession());

  // Per-project authorization (no-op unless ADMIN_USERNAME is set — see
  // src/web/permissions.js). Mounted right after requireSession so every
  // project-scoped route below (including /eleven) 403s a user who was never
  // granted req.projectId — this also covers resolveProject's default-project
  // fallback for headerless requests, which fails closed here. Note the four
  // SSE routes above run BEFORE this: they validate a session inline and are
  // capability-keyed by unguessable in-memory job ids, accepted for v1.
  router.use(requireProjectAccess());

  // Admin page backend: list users, set a user's granted projects.
  router.use('/admin', requireAdmin(), buildAdminRouter());

  // ElevenLabs playground backend — voice library/collection, TTS, voice
  // changer, isolator, STT, cloning, design. Kept in its own module.
  router.use('/eleven', buildElevenRouter());

  // ComfyUI video provider (src/web/comfyRoutes.js): model registry + slots
  // under /comfy, and the per-cut render routes on this router.
  router.use('/comfy', buildComfyRouter());
  registerCutVideoRoutes(router);

  // Scenes & cuts (src/web/cutRoutes.js): the Prompts tab's planner, scene
  // and cut CRUD, and start-frame rendering.
  registerCutRoutes(router);
  registerCutFalVideoRoutes(router);

  // Attribute every gateway text/cast edit made during an authenticated request
  // to the logged-in user, so AI-assist features (beat rewrite, restore, dialog
  // edits, etc.) announce like manual edits. Pure reads and edits to
  // non-announce-worthy rooms wrap harmlessly. The chat run sets its own scope
  // (chatRuns.js) because it detaches onto the channel mutex.
  router.use((req, _res, next) => runAsEditor(req.session?.username, () => next()));

  // Start a web chat agent run against the viewer's current project. The
  // agent shares the Discord channel's conversation history but the run is
  // scoped to the browser's project and never moves the channel's pointer.
  router.post('/chat', async (req, res, next) => {
    try {
      const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
      if (!text) {
        return res.status(400).json({ error: 'text is required' });
      }
      if (text.length > 4000) {
        return res.status(400).json({ error: 'text too long (max 4000 chars)' });
      }
      const context = parseChatContext(req.body?.context);
      const run = startChatRun({
        projectId: req.projectId,
        projectTitle: req.projectTitle,
        session: req.session,
        text,
        context,
      });
      res.status(202).json({ run_id: run.run_id });
    } catch (e) {
      next(e);
    }
  });

  // Persisted transcript + token stats for this user's isolated thread.
  router.get('/chat/history', async (req, res, next) => {
    try {
      const channelId = webChannelId(req.projectId, req.session?.username);
      const [messages, stats] = await Promise.all([
        loadWebDisplayHistory(channelId),
        computeHistoryStats(channelId),
      ]);
      res.json({ messages, ...stats });
    } catch (e) {
      next(e);
    }
  });

  // Non-destructive clear: set the history watermark for this user's thread.
  router.post('/chat/clear', async (req, res, next) => {
    try {
      const channelId = webChannelId(req.projectId, req.session?.username);
      await setHistoryClearedAt(channelId);
      res.json({ ok: true, estimated_tokens: 0, last_input_tokens: null });
    } catch (e) {
      next(e);
    }
  });

  // Connection metadata for the SPA so it knows where to open WebSockets.
  // screenplay_title was dropped (no SPA consumers remain; project title is
  // available via project_title and via GET /api/projects).
  router.get('/info', async (req, res) => {
    const wsUrl =
      config.web.hocuspocusPublicUrl ||
      `ws://${'localhost'}:${config.web.hocuspocusPort}`;
    res.set('Vary', 'X-Project-Id');
    res.json({
      hocuspocus_url: wsUrl,
      bot_color: config.web.botColor,
      project_id: req.projectId,
      project_title: req.projectTitle,
    });
  });

  // ── projects ─────────────────────────────────────────────────────────────

  // {projects:[...]} envelope deliberately wraps the spec's bare array for
  // forward-compat; SPA consumers read data.projects.
  // resolveProject() skips this path (see projectMiddleware.js, carried
  // improvement 3) so a stale header pointing at a vanished project can't
  // 404 the recovery fetch.
  router.get('/projects', async (req, res, next) => {
    try {
      // Filtered to the viewer's grants (admin sees all; legacy open mode
      // returns everything). The SPA treats this list as its authorization
      // oracle — selector contents, URL resolution, redirect targets.
      const projects = await listProjectsFor(req.session?.username);
      res.json({
        projects: projects.map((p) => ({
          id: p._id.toString(),
          title: p.title,
          created_at: p.created_at || null,
        })),
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/projects', requireAdmin(), async (req, res, next) => {
    try {
      // Pre-validate with normalizeProjectTitle so validation errors always
      // map to 400 (covers empty, slash, >120-char, and "."/"..").
      let title;
      try {
        title = normalizeProjectTitle(req.body?.title ?? '');
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      if (await getProjectByTitle(title)) {
        return res.status(409).json({ error: 'a project with that title already exists' });
      }
      let project;
      try {
        project = await createProject(title);
      } catch (e) {
        // Unique-index race on title_lower (two simultaneous creates). The
        // fake Mongo never throws this — the getProjectByTitle pre-check above
        // is what the test suite exercises.
        if (e?.code === 11000) {
          return res.status(409).json({ error: 'a project with that title already exists' });
        }
        throw e;
      }
      await seedProjectDefaults(project._id.toString());
      res.status(201).json({ id: project._id.toString(), title: project.title });
    } catch (e) {
      next(e);
    }
  });

  // Rename. Addressed by path id (not the X-Project-Id header) so renaming a
  // project you aren't currently viewing works. Only the title changes — every
  // room name, GridFS file, and content row keys off project_id.
  router.patch('/projects/:id', requireAdmin(), async (req, res, next) => {
    try {
      let title;
      try {
        title = normalizeProjectTitle(req.body?.title ?? '');
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      if (!await getProjectById(req.params.id)) {
        return res.status(404).json({ error: 'unknown project' });
      }
      let renamed;
      try {
        renamed = await renameProject(req.params.id, title);
      } catch (e) {
        if (e?.code === 11000) {
          return res.status(409).json({ error: 'a project with that title already exists' });
        }
        throw e;
      }
      if (!renamed) return res.status(404).json({ error: 'unknown project' });
      res.json({ id: renamed._id.toString(), title: renamed.title });
    } catch (e) {
      next(e);
    }
  });

  // Irreversible full delete of one project and everything it owns. Refuses to
  // delete the last remaining project: an empty projects collection makes the
  // bot lazily recreate a blank "Screenplay" mid-request, which is a confusing
  // way to end up with a project you didn't ask for.
  router.delete('/projects/:id', requireAdmin(), async (req, res, next) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project) return res.status(404).json({ error: 'unknown project' });
      if ((await countProjects()) <= 1) {
        return res.status(409).json({ error: 'cannot delete the only project' });
      }
      const result = await deleteProjectCascade(req.params.id);
      if (!result) return res.status(404).json({ error: 'unknown project' });
      res.json({ ok: true, id: result.id, title: result.title, deleted: result.deleted });
    } catch (e) {
      next(e);
    }
  });

  // ── reads ────────────────────────────────────────────────────────────────

  router.get('/toc', async (req, res) => {
    // findAllCharacters (not listCharacters) — we need fields.{...} content for
    // the deep filter to match on description/body-style template fields.
    // listDialogs() unfiltered returns every row; we group them per beat in
    // buildTocResponse to back the dialog tab filter without N+1 round trips.
    const [characters, sets, beatList, notes, dialogCounts, allDialogs, videoPromptCounts] =
      await Promise.all([
        findAllCharacters(req.projectId),
        findAllSets(req.projectId),
        listBeats(req.projectId),
        getDirectorNotes(req.projectId),
        countDialogsByBeat(req.projectId),
        listDialogs({ projectId: req.projectId }),
        countVideoPromptsByBeat(req.projectId),
      ]);
    res.json(
      buildTocResponse(
        characters,
        beatList,
        (notes.notes || []).length,
        dialogCounts,
        { allDialogs, sets, videoPromptCounts },
      ),
    );
  });

  // Two lists in one response:
  //   models  — curated metadata for the hand-wired models (resolution, speed,
  //             reference caps). The bulk-generate dialog reads this.
  //   catalog — the whole fal.ai image catalog, filtered to endpoints we can
  //             drive from a prompt + references and priced for the picker.
  router.get('/image-models', async (_req, res, next) => {
    try {
      const { loadImageModelCatalog } = await import('../fal/imageModelCatalog.js');
      const { config } = await import('../config.js');
      const catalog = await loadImageModelCatalog();
      res.json({
        models: listImageModelInfo(),
        default_model_id: DEFAULT_IMAGE_MODEL,
        configured: Boolean(config.fal.apiKey),
        catalog_generated_at: catalog.generated_at,
        catalog_error: catalog.catalog_error,
        catalog: catalog.models,
      });
    } catch (err) {
      next(err);
    }
  });

  // Regenerate the image half of the fal catalog (same scrape as
  // `npm run refresh:playground-models`). Single-flight; the SPA polls the GET.
  router.post('/image-models/refresh', async (_req, res, next) => {
    try {
      const { config } = await import('../config.js');
      if (!config.fal.apiKey) {
        return res.status(503).json({ error: 'fal.ai is not configured (FAL_KEY missing).' });
      }
      const { startCatalogRefresh } = await import('../fal/catalogRefresh.js');
      res.json(startCatalogRefresh('image'));
    } catch (err) {
      next(err);
    }
  });

  router.get('/image-models/refresh', async (_req, res, next) => {
    try {
      const { getCatalogRefreshState } = await import('../fal/catalogRefresh.js');
      res.json(getCatalogRefreshState('image'));
    } catch (err) {
      next(err);
    }
  });

  router.get('/template', async (req, res) => {
    const [character_template, plot_template] = await Promise.all([
      getCharacterTemplate(req.projectId),
      getPlotTemplate(req.projectId),
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

  // Same idea for the host's artwork: any rendered plate with no description
  // gets one. This is what fills in galleries generated before descriptions
  // existed — new artwork is described by the render pipeline itself. Pending
  // and errored artwork is skipped (nothing to look at). Fire-and-forget; the
  // worker dedups in-flight artwork ids across concurrent page loads.
  function backfillArtworkDescriptions(projectId, hostType, hostId, artworks) {
    if (!hostId) return;
    for (const art of artworks || []) {
      if (art?.status !== 'done' || !art.result_image_id) continue;
      if (String(art.description || '').trim()) continue;
      kickoffArtworkVisionSeed({
        projectId,
        hostType,
        hostId,
        artworkId: art._id?.toString?.() || String(art._id),
      });
    }
  }

  router.get('/beat', async (req, res) => {
    const { order, id } = req.query;
    let beat = null;
    if (id && isOidHex(String(id))) {
      beat = await getBeat(req.projectId, String(id));
    } else if (order != null) {
      beat = await getBeat(req.projectId, String(order));
    }
    if (!beat) return res.status(404).json({ error: 'beat not found' });
    res.json({ beat });
    backfillOwnedImageCaptions('beat', beat._id?.toString?.(), beat.images).catch(() => {});
    backfillArtworkDescriptions(req.projectId, 'beat', beat._id?.toString?.(), beat.artworks);
  });

  // Resolve every character named in a beat to its current Mongo doc, with
  // per-character sheet metadata for the artwork reference picker. Uses the
  // shared name-resolution path (findCharactersInBeat).
  router.get('/beat/:id/characters', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const beat = await getBeat(req.projectId, beatId);
      const { findCharactersInBeat } = await import('./beatPlanShared.js');
      const docs = await findCharactersInBeat(req.projectId, beat);
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

  // Every GridFS image owned by this beat — superset of beat.images[] because
  // it includes generated stills such as cut start frames (those write to GridFS
  // with owner_type='beat' but don't mutate the embedded gallery array).
  // Filters out thumbnails and artwork result images (the latter live on the
  // beat's Artwork tab, so the References tab and frame picker shouldn't
  // surface them as plain reference images).
  router.get('/beat/:id/images', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const [files, beat] = await Promise.all([
        listImagesForBeat(req.projectId, beatId),
        getBeat(req.projectId, beatId),
      ]);
      const artworkImageIds = new Set(
        (beat?.artworks || [])
          .flatMap((a) => [a?.result_image_id, a?.previous_result_image_id])
          .filter(Boolean)
          .map((id) => String(id)),
      );
      const filtered = files.filter(
        (f) =>
          f.metadata?.kind !== 'thumbnail'
          && !artworkImageIds.has(String(f._id)),
      );
      res.json({ images: filtered.map(imageFileToMeta) });
    } catch (e) {
      next(e);
    }
  });

  // Every GridFS image owned by this character — superset of character.images[]
  // because it includes any orphan files that didn't land in the embedded
  // gallery. Filters out thumbnails and artwork result images so the References
  // tab stays disjoint from the Artwork tab.
  router.get('/character/:id/images', async (req, res, next) => {
    try {
      const c = await getCharacter(req.projectId, req.params.id);
      if (!c) return res.status(404).json({ error: 'character not found' });
      const files = await listImagesForCharacter(req.projectId, c._id);
      const artworkImageIds = new Set(
        (c.artworks || [])
          .flatMap((a) => [a?.result_image_id, a?.previous_result_image_id])
          .filter(Boolean)
          .map((aid) => String(aid)),
      );
      const filtered = files.filter(
        (f) =>
          f.metadata?.kind !== 'thumbnail'
          && !artworkImageIds.has(String(f._id)),
      );
      res.json({ images: filtered.map(imageFileToMeta) });
    } catch (e) {
      next(e);
    }
  });

  router.get('/character', async (req, res) => {
    const name = String(req.query.name || '');
    if (!name) return res.status(400).json({ error: 'name required' });
    const c = await getCharacter(req.projectId, name);
    if (!c) return res.status(404).json({ error: 'character not found' });
    res.json({ character: c });
    backfillOwnedImageCaptions('character', c._id?.toString?.(), c.images).catch(() => {});
    backfillArtworkDescriptions(req.projectId, 'character', c._id?.toString?.(), c.artworks);
  });

  // Every GridFS image owned by this set — mirrors /character/:id/images
  // (filters thumbnails + artwork result images so References stays disjoint
  // from Artwork).
  router.get('/set/:id/images', async (req, res, next) => {
    try {
      const s = await getSet(req.projectId, req.params.id);
      if (!s) return res.status(404).json({ error: 'set not found' });
      const files = await listImagesForSet(req.projectId, s._id);
      const artworkImageIds = new Set(
        (s.artworks || [])
          .flatMap((a) => [a?.result_image_id, a?.previous_result_image_id])
          .filter(Boolean)
          .map((aid) => String(aid)),
      );
      const filtered = files.filter(
        (f) =>
          f.metadata?.kind !== 'thumbnail'
          && !artworkImageIds.has(String(f._id)),
      );
      res.json({ images: filtered.map(imageFileToMeta) });
    } catch (e) {
      next(e);
    }
  });

  router.get('/set', async (req, res) => {
    const name = String(req.query.name || '');
    if (!name) return res.status(400).json({ error: 'name required' });
    const s = await getSet(req.projectId, name);
    if (!s) return res.status(404).json({ error: 'set not found' });
    res.json({ set: s });
    backfillOwnedImageCaptions('set', s._id?.toString?.(), s.images).catch(() => {});
    backfillArtworkDescriptions(req.projectId, 'set', s._id?.toString?.(), s.artworks);
  });

  router.get('/notes', async (req, res) => {
    const doc = await getDirectorNotes(req.projectId);
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

  // Per-project default generation models (About page → Models tab; also
  // auto-remembered from the image-sheet dialog's model selectors). GET returns
  // every known slot (null = unset); PUT merges a partial {slot: id|null} patch
  // and returns the full merged object. Unknown slots / bad values → 400.
  router.get('/model-defaults', async (req, res, next) => {
    try {
      const { getModelDefaults } = await import('../mongo/projectSettings.js');
      res.json({ model_defaults: await getModelDefaults(req.projectId) });
    } catch (e) {
      next(e);
    }
  });

  router.put('/model-defaults', async (req, res, next) => {
    try {
      const patch = req.body;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return res.status(400).json({ error: 'body must be an object of {slot: model_id|null}' });
      }
      const { setModelDefaults } = await import('../mongo/projectSettings.js');
      res.json({ model_defaults: await setModelDefaults(req.projectId, patch) });
    } catch (e) {
      if (/^(unknown model default|invalid model id|patch must be)/.test(e.message)) {
        return res.status(400).json({ error: e.message });
      }
      next(e);
    }
  });

  router.get('/library', async (req, res) => {
    const [images, attachments] = await Promise.all([
      listLibraryImages(req.projectId),
      listLibraryAttachments(req.projectId),
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
      const files = await listImagesByOwnerType(req.projectId, 'character');
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
        const all = await findAllCharacters(req.projectId);
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

  // All set-owned GridFS images, joined with the owning set's name. Used by
  // the picker modal's "Sets" source tab. Optional ?exclude_id drops images
  // owned by that set.
  router.get('/images/by-owner/sets', async (req, res, next) => {
    try {
      const exclude = String(req.query?.exclude_id || '').trim();
      const files = await listImagesByOwnerType(req.projectId, 'set');
      const nameById = new Map();
      const hasOwners = files.some((f) => f.metadata?.owner_id);
      if (hasOwners) {
        for (const s of await findAllSets(req.projectId)) {
          nameById.set(s._id.toString(), s.name || '(unnamed)');
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
        listImagesByOwnerType(req.projectId, 'beat'),
        getPlot(req.projectId),
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

  // Full-screenplay PDF (cover, director's notes, characters, plot, library) —
  // the About page's "Download Screenplay" button. Mirrors the agent's
  // export_pdf tool with no filters. Generation can take a few seconds.
  router.get('/export/pdf', async (req, res, next) => {
    try {
      const result = await exportToPdf({ projectId: req.projectId });
      if (result?.error) {
        return res.status(400).json({ error: result.error });
      }
      const filename = `${slugifyFilename(req.projectTitle || 'screenplay')}.pdf`;
      res.download(result.path, filename, (err) => {
        if (err && !res.headersSent) next(err);
      });
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
      const meta = await uploadGeneratedImage(req.projectId, {
        buffer,
        contentType,
        prompt: null,
        generatedBy: null,
        ownerType: null,
        ownerId: null,
        filename: safeFilename(req.file.originalname, `library-${Date.now()}.png`),
      });
      await addLibraryImageViaGateway({ projectId: req.projectId, imageMeta: meta });
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
      await removeLibraryImageViaGateway({ projectId: req.projectId, imageId: id });
      res.json({ ok: true });
      announceLibraryMedia({ req, verb: 'deleted a library image from' });
    } catch (e) {
      next(e);
    }
  });

  router.post('/library/attachment', upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'file required' });
      const meta = await uploadAttachmentBuffer(req.projectId, {
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
    const beat = await getBeat(req.projectId, id);
    return beat?._id?.toString() || null;
  }

  router.get('/beat/:id/critique', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const { getBeatCritique } = await import('../mongo/critiques.js');
      const critique = await getBeatCritique(req.projectId, beatId);
      res.json({ critique: critique || null });
    } catch (e) { next(e); }
  });

  router.post('/beat/:id/critique', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const { startCritiqueJob } = await import('./critiqueGenerate.js');
      const jobId = await startCritiqueJob({ projectId: req.projectId, beatId });
      res.status(202).json({ job_id: jobId, beat_id: beatId });
    } catch (e) {
      if (e?.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  router.post('/beat/:id/regenerate', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const { regenerateBeat } = await import('./beatRewrite.js');
      const result = await regenerateBeat(req.projectId, beatId);
      res.json(result);
    } catch (e) {
      if (e?.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  router.post('/beat/:id/normalize', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const { normalizeBeat } = await import('./beatRewrite.js');
      const result = await normalizeBeat(req.projectId, beatId);
      res.json(result);
    } catch (e) {
      if (e?.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  router.post('/beat/:id/restore-body', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const { restoreBeatBody } = await import('./beatRewrite.js');
      const result = await restoreBeatBody(req.projectId, beatId);
      res.json(result);
    } catch (e) {
      if (e?.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  router.post('/beat/:id/image', upload.single('file'), async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      if (!req.file) return res.status(400).json({ error: 'file required' });
      const sniffed = validateImageBuffer(req.file.buffer);
      const file = await uploadGeneratedImage(req.projectId, {
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
        ownerType: 'beat',
        ownerId: beatId,
        filename: safeFilename(req.file.originalname, `beat-${beatId}-${Date.now()}.png`),
      });
      const setAsMain = req.body?.set_as_main === 'true' || req.query.set_as_main === '1';
      const result = await addBeatImageViaGateway({
        projectId: req.projectId,
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
      res.json({ ...result, image_id: String(file._id) });
      announceBeatMedia({
        req,
        beat: await getBeat(req.projectId, beatId),
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
      const result = await removeBeatImageViaGateway({ projectId: req.projectId, beatId, imageId: req.params.imageId });
      res.json(result);
      announceBeatMedia({
        req,
        beat: await getBeat(req.projectId, beatId),
        verb: 'deleted an image from',
      });
    } catch (e) {
      next(e);
    }
  });

  // Delete a beat-owned GridFS image that is NOT in beat.images[] (a leftover
  // generated still). Removes the GridFS bytes.
  router.delete('/beat/:id/orphan-image/:imageId', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const imageId = req.params.imageId;
      if (!isOidHex(imageId)) return res.status(400).json({ error: 'invalid image id' });
      const file = await findImageFile(imageId);
      if (!file) return res.status(404).json({ error: 'image not found' });
      const ownerType = file.metadata?.owner_type;
      const ownerId = file.metadata?.owner_id?.toString?.();
      if (ownerType !== 'beat' || ownerId !== String(beatId)) {
        return res.status(409).json({ error: 'image is not owned by this beat' });
      }
      const beat = await getBeat(req.projectId, beatId);
      const inGallery = (beat?.images || []).some(
        (i) => (i._id?.toString?.() || String(i._id)) === String(imageId),
      );
      if (inGallery) {
        return res.status(409).json({
          error: 'image is in beat.images[] — use DELETE /beat/:id/image/:imageId',
        });
      }
      await deleteImage(imageId);
      res.json({ ok: true });
      announceBeatMedia({
        req,
        beat: await getBeat(req.projectId, beatId),
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
      if (!await isValidImageModel(imageModel)) {
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

      const file = await uploadGeneratedImage(req.projectId, {
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
        projectId: req.projectId,
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
        beat: replaceResult.beat || (await getBeat(req.projectId, beatId)),
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
          projectId: req.projectId,
          beatId,
          imageId,
          setAsMain,
        });
        res.json(result);
        announceBeatMedia({
          req,
          beat: result?.beat || (await getBeat(req.projectId, beatId)),
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
          projectId: req.projectId,
          imageId,
          ownerType: 'beat',
          ownerId: beatId,
          filenameBase: `beat-${beatId}`,
        });
        const result = await addBeatImageViaGateway({
          projectId: req.projectId,
          beatId,
          imageMeta,
          setAsMain,
        });
        res.json(result);
        announceBeatMedia({
          req,
          beat: result?.beat || (await getBeat(req.projectId, beatId)),
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
      if (!await isValidImageModel(model)) {
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
      const file = await uploadGeneratedImage(req.projectId, {
        buffer: result.buffer,
        contentType: result.contentType,
        prompt,
        generatedBy: result.model || model,
        ownerType: 'beat',
        ownerId: beatId,
        filename: `beat-${beatId}-gen-${Date.now()}.png`,
      });
      const updated = await addBeatImageViaGateway({
        projectId: req.projectId,
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
        beat: updated.beat || (await getBeat(req.projectId, beatId)),
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
        const result = await moveBeatImageToLibraryViaGateway({ projectId: req.projectId, beatId, imageId });
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
      const result = await setBeatMainImageViaGateway({ projectId: req.projectId, beatId, imageId });
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
      const file = await uploadAttachmentBuffer(req.projectId, {
        buffer: req.file.buffer,
        filename: safeFilename(req.file.originalname, `attach-${Date.now()}.bin`),
        contentType: req.file.mimetype,
        ownerType: 'beat',
        ownerId: beatId,
      });
      const result = await addBeatAttachmentViaGateway({
        projectId: req.projectId,
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
        beat: await getBeat(req.projectId, beatId),
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
        projectId: req.projectId,
        beatId,
        attachmentId: req.params.attachId,
      });
      res.json(result);
      announceBeatMedia({
        req,
        beat: await getBeat(req.projectId, beatId),
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
          projectId: req.projectId,
          beatId,
          attachmentId,
        });
        res.json(result);
        announceBeatMedia({
          req,
          beat: await getBeat(req.projectId, beatId),
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
      const { characters, sets, order } = req.body || {};
      const patch = {};
      if (Array.isArray(characters)) patch.characters = characters;
      if (Array.isArray(sets)) patch.sets = sets;
      if (typeof order === 'number') patch.order = order;
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'no patch fields' });

      const result = await updateBeatViaGateway(req.projectId, beatId, patch);
      res.json({ beat: result });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/beat/:id', async (req, res, next) => {
    try {
      // getBeat (not resolveBeatId) so an unknown or cross-project hex id is a
      // 404 rather than a gateway throw.
      const beat = await getBeat(req.projectId, String(req.params.id));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const result = await deleteBeatViaGateway(req.projectId, beat._id.toString());
      res.json({
        ok: true,
        deleted: {
          _id: String(result._id),
          name: result.name,
          dialogs_removed: result.dialogs_removed,
        },
      });
    } catch (e) {
      next(e);
    }
  });

  // Restore a beat's text fields to a prior snapshot. Used by the AI-chat
  // undo/redo controls. Each field is written through the gateway so the change
  // applies as a CRDT op to any open editor (and falls back to a direct Mongo
  // write when Hocuspocus isn't running). Always overwrites current text — no
  // concurrent-edit guard (see the design spec).
  router.patch('/beat/:id/text', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const { name, desc, body } = req.body || {};
      const fields = [];
      if (typeof name === 'string') fields.push(['name', name]);
      if (typeof desc === 'string') fields.push(['desc', desc]);
      if (typeof body === 'string') fields.push(['body', body]);
      if (!fields.length) return res.status(400).json({ error: 'no text fields' });
      for (const [field, markdown] of fields) {
        await setEntityFieldMarkdown({
          projectId: req.projectId,
          entityType: 'beat',
          entityId: beatId,
          field,
          markdown,
        });
      }
      const beat = await getBeat(req.projectId, beatId);
      res.json({ beat });
    } catch (e) {
      next(e);
    }
  });

  // ── character mutations (non-text) ───────────────────────────────────────

  async function resolveCharacterId(req) {
    const { id } = req.params;
    if (isOidHex(id)) return id;
    const c = await getCharacter(req.projectId, id);
    return c?._id?.toString() || null;
  }

  router.post('/character/:id/image', upload.single('file'), async (req, res, next) => {
    try {
      const cid = await resolveCharacterId(req);
      if (!cid) return res.status(404).json({ error: 'character not found' });
      if (!req.file) return res.status(400).json({ error: 'file required' });
      const sniffed = validateImageBuffer(req.file.buffer);
      const file = await uploadGeneratedImage(req.projectId, {
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
        ownerType: 'character',
        ownerId: cid,
        filename: safeFilename(req.file.originalname, `character-${cid}-${Date.now()}.png`),
      });
      const setAsMain = req.body?.set_as_main === 'true' || req.query.set_as_main === '1';
      const result = await addCharacterImageViaGateway({
        projectId: req.projectId,
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
      res.json({ ...result, image_id: String(file._id) });
      announceCharacterMedia({
        req,
        character: await getCharacter(req.projectId, cid),
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
        projectId: req.projectId,
        character: cid,
        imageId: req.params.imageId,
      });
      res.json(result);
      announceCharacterMedia({
        req,
        character: await getCharacter(req.projectId, cid),
        verb: 'deleted an image from',
      });
    } catch (e) {
      next(e);
    }
  });

  // Delete a character-owned GridFS image that is NOT in character.images[] —
  // a counterpart to the beat orphan-image route. We just verify
  // ownership and drop the bytes.
  router.delete('/character/:id/orphan-image/:imageId', async (req, res, next) => {
    try {
      const cid = await resolveCharacterId(req);
      if (!cid) return res.status(404).json({ error: 'character not found' });
      const imageId = req.params.imageId;
      if (!isOidHex(imageId)) return res.status(400).json({ error: 'invalid image id' });
      const file = await findImageFile(imageId);
      if (!file) return res.status(404).json({ error: 'image not found' });
      const ownerType = file.metadata?.owner_type;
      const ownerId = file.metadata?.owner_id?.toString?.();
      if (ownerType !== 'character' || ownerId !== String(cid)) {
        return res.status(409).json({ error: 'image is not owned by this character' });
      }
      const character = await getCharacter(req.projectId, cid);
      const inGallery = (character?.images || []).some(
        (i) => (i._id?.toString?.() || String(i._id)) === String(imageId),
      );
      if (inGallery) {
        return res.status(409).json({
          error:
            'image is in character.images[] — use DELETE /character/:id/image/:imageId',
        });
      }
      await deleteImage(imageId);
      res.json({ ok: true });
      announceCharacterMedia({
        req,
        character: await getCharacter(req.projectId, cid),
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
      if (!await isValidImageModel(imageModel)) {
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

      const file = await uploadGeneratedImage(req.projectId, {
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
        projectId: req.projectId,
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
        character: replaceResult.character || (await getCharacter(req.projectId, cid)),
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
          projectId: req.projectId,
          character: cid,
          imageId,
          setAsMain,
        });
        res.json(result);
        announceCharacterMedia({
          req,
          character: result?.character || (await getCharacter(req.projectId, cid)),
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
          projectId: req.projectId,
          imageId,
          ownerType: 'character',
          ownerId: cid,
          filenameBase: `character-${cid}`,
        });
        const result = await addCharacterImageViaGateway({
          projectId: req.projectId,
          character: cid,
          imageMeta,
          setAsMain,
        });
        res.json(result);
        announceCharacterMedia({
          req,
          character: result?.character || (await getCharacter(req.projectId, cid)),
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
      if (!await isValidImageModel(model)) {
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
      const file = await uploadGeneratedImage(req.projectId, {
        buffer: result.buffer,
        contentType: result.contentType,
        prompt,
        generatedBy: result.model || model,
        ownerType: 'character',
        ownerId: cid,
        filename: `character-${cid}-gen-${Date.now()}.png`,
      });
      const updated = await addCharacterImageViaGateway({
        projectId: req.projectId,
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
        character: updated.character || (await getCharacter(req.projectId, cid)),
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
          projectId: req.projectId,
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
      const result = await setCharacterMainImageViaGateway({ projectId: req.projectId, character: cid, imageId });
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
      const file = await uploadAttachmentBuffer(req.projectId, {
        buffer: req.file.buffer,
        filename: safeFilename(req.file.originalname, `attach-${Date.now()}.bin`),
        contentType: req.file.mimetype,
        ownerType: 'character',
        ownerId: cid,
      });
      const result = await addCharacterAttachmentViaGateway({
        projectId: req.projectId,
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
        character: await getCharacter(req.projectId, cid),
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
        projectId: req.projectId,
        character: cid,
        attachmentId: req.params.attachId,
      });
      res.json(result);
      announceCharacterMedia({
        req,
        character: await getCharacter(req.projectId, cid),
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
          projectId: req.projectId,
          character: cid,
          attachmentId,
        });
        res.json(result);
        announceCharacterMedia({
          req,
          character: await getCharacter(req.projectId, cid),
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

  // ── set mutations ────────────────────────────────────────────────────────
  // Mirrors the character block above 1:1 (sets have a fixed schema of
  // name + description; text edits flow through the set:<id> y-doc room).

  async function resolveSetId(req) {
    const { id } = req.params;
    if (isOidHex(id)) return id;
    const s = await getSet(req.projectId, id);
    return s?._id?.toString() || null;
  }

  // Create is SPA-first (characters are agent-only for historical reasons;
  // sets get both surfaces — the agent has its own create_set tool). Deleting
  // a set is agent-only (deleteSetViaGateway via the Discord/chat agent); the
  // SPA deliberately has no delete path.
  router.post('/set', async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name (non-empty) required' });
      if (name.length > 200) return res.status(400).json({ error: 'name must be ≤ 200 chars' });
      const description = typeof req.body?.description === 'string' ? req.body.description : '';
      const set = await createSetViaGateway({ projectId: req.projectId, name, description });
      res.status(201).json({ set });
    } catch (e) {
      if (e?.status === 409) return res.status(409).json({ error: e.message });
      next(e);
    }
  });

  // GET /set/:id/beats — every beat whose `sets` roster names this set, for
  // the set page's beat multi-selects (description generation, shot planning,
  // auto image sheets). `body_empty` flags beats that contribute no text.
  router.get('/set/:id/beats', async (req, res, next) => {
    try {
      const sid = await resolveSetId(req);
      if (!sid) return res.status(404).json({ error: 'set not found' });
      const set = await getSet(req.projectId, sid);
      if (!set) return res.status(404).json({ error: 'set not found' });
      const { findBeatsReferencingSet } = await import('./beatPlanShared.js');
      const beats = await findBeatsReferencingSet(req.projectId, set);
      res.json({
        beats: beats.map((b) => ({
          _id: b._id.toString(),
          order: b.order,
          name: b.name || '',
          plain_name: stripMarkdown(b.name || '').trim(),
          desc: b.desc || '',
          body_empty: !stripMarkdown(b.body || '').trim(),
        })),
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/character', async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name (non-empty) required' });
      if (name.length > 200) return res.status(400).json({ error: 'name must be ≤ 200 chars' });
      const hollywood_actor =
        typeof req.body?.hollywood_actor === 'string' && req.body.hollywood_actor.trim()
          ? req.body.hollywood_actor.trim()
          : null;
      const character = await createCharacterViaGateway({
        projectId: req.projectId,
        name,
        hollywood_actor,
      });
      res.status(201).json({ character });
    } catch (e) {
      if (e?.status === 409) return res.status(409).json({ error: e.message });
      next(e);
    }
  });

  router.post('/set/:id/image', upload.single('file'), async (req, res, next) => {
    try {
      const sid = await resolveSetId(req);
      if (!sid) return res.status(404).json({ error: 'set not found' });
      if (!req.file) return res.status(400).json({ error: 'file required' });
      const sniffed = validateImageBuffer(req.file.buffer);
      const file = await uploadGeneratedImage(req.projectId, {
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
        ownerType: 'set',
        ownerId: sid,
        filename: safeFilename(req.file.originalname, `set-${sid}-${Date.now()}.png`),
      });
      const setAsMain = req.body?.set_as_main === 'true' || req.query.set_as_main === '1';
      const result = await addSetImageViaGateway({
        projectId: req.projectId,
        set: sid,
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
      res.json({ ...result, image_id: String(file._id) });
      announceSetMedia({
        req,
        set: await getSet(req.projectId, sid),
        verb: 'uploaded an image to',
        imageFileId: file._id,
      });
      kickoffImageVisionSeed(file._id, req.file.buffer, sniffed || req.file.mimetype, {
        ownerType: 'set',
        ownerId: sid,
      });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/set/:id/image/:imageId', async (req, res, next) => {
    try {
      const sid = await resolveSetId(req);
      if (!sid) return res.status(404).json({ error: 'set not found' });
      const result = await removeSetImageViaGateway({
        projectId: req.projectId,
        set: sid,
        imageId: req.params.imageId,
      });
      res.json(result);
      announceSetMedia({
        req,
        set: await getSet(req.projectId, sid),
        verb: 'deleted an image from',
      });
    } catch (e) {
      next(e);
    }
  });

  // Delete a set-owned GridFS image that is NOT in set.images[] — the orphan
  // counterpart, mirroring the character route.
  router.delete('/set/:id/orphan-image/:imageId', async (req, res, next) => {
    try {
      const sid = await resolveSetId(req);
      if (!sid) return res.status(404).json({ error: 'set not found' });
      const imageId = req.params.imageId;
      if (!isOidHex(imageId)) return res.status(400).json({ error: 'invalid image id' });
      const file = await findImageFile(imageId);
      if (!file) return res.status(404).json({ error: 'image not found' });
      const ownerType = file.metadata?.owner_type;
      const ownerId = file.metadata?.owner_id?.toString?.();
      if (ownerType !== 'set' || ownerId !== String(sid)) {
        return res.status(409).json({ error: 'image is not owned by this set' });
      }
      const set = await getSet(req.projectId, sid);
      const inGallery = (set?.images || []).some(
        (i) => (i._id?.toString?.() || String(i._id)) === String(imageId),
      );
      if (inGallery) {
        return res.status(409).json({
          error: 'image is in set.images[] — use DELETE /set/:id/image/:imageId',
        });
      }
      await deleteImage(imageId);
      res.json({ ok: true });
      announceSetMedia({
        req,
        set: await getSet(req.projectId, sid),
        verb: 'deleted an image from',
      });
    } catch (e) {
      next(e);
    }
  });

  // Replace a set's image with a model-generated one — parallel to the beat
  // and character regenerate endpoints.
  router.post('/set/:id/image/:imageId/regenerate', async (req, res, next) => {
    try {
      const sid = await resolveSetId(req);
      if (!sid) return res.status(404).json({ error: 'set not found' });
      const oldImageId = req.params.imageId;
      if (!isOidHex(oldImageId)) return res.status(400).json({ error: 'invalid image id' });
      const mode = String(req.body?.mode ?? 'edit');
      if (!['edit', 'generate'].includes(mode)) {
        return res.status(400).json({ error: 'mode must be edit|generate' });
      }
      const imageModel = normalizeImageModel(req.body?.image_model);
      if (!await isValidImageModel(imageModel)) {
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

      const file = await uploadGeneratedImage(req.projectId, {
        buffer: result.buffer,
        contentType: result.contentType,
        prompt,
        generatedBy: result.model,
        ownerType: 'set',
        ownerId: sid,
        filename: `set-${sid}-${Date.now()}.png`,
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
      const replaceResult = await replaceSetImageViaGateway({
        projectId: req.projectId,
        set: sid,
        oldImageId,
        newImageMeta: newMeta,
      });
      res.json({
        set: replaceResult.set,
        image: { _id: file._id, content_type: file.content_type },
        replaced: String(oldImageId),
        was_main: replaceResult.was_main,
        model: result.model,
      });
      announceSetMedia({
        req,
        set: await getSet(req.projectId, sid),
        verb: mode === 'edit' ? 'edited an image on' : 'regenerated an image on',
        imageFileId: file._id,
        prompt,
      });
      kickoffImageVisionSeed(file._id, result.buffer, result.contentType, {
        ownerType: 'set',
        ownerId: sid,
      });
    } catch (e) {
      next(e);
    }
  });

  // Attach an existing GridFS image (from library or another entity) to a
  // set's gallery. Picker uses this for the Library tab.
  router.post('/set/:id/image/attach', async (req, res, next) => {
    try {
      const sid = await resolveSetId(req);
      if (!sid) return res.status(404).json({ error: 'set not found' });
      const imageId = String(req.body?.image_id || '').trim();
      if (!isOidHex(imageId)) {
        return res.status(400).json({ error: 'image_id (24-hex) required' });
      }
      const setAsMain = !!req.body?.set_as_main;
      try {
        const result = await attachExistingImageToSetViaGateway({
          projectId: req.projectId,
          set: sid,
          imageId,
          setAsMain,
        });
        res.json(result);
        announceSetMedia({
          req,
          set: await getSet(req.projectId, sid),
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

  // Copy a GridFS image (owned by any entity, or by library) into this set's
  // gallery as a brand-new GridFS file. Source stays intact.
  router.post('/set/:id/image/copy', async (req, res, next) => {
    try {
      const sid = await resolveSetId(req);
      if (!sid) return res.status(404).json({ error: 'set not found' });
      const imageId = String(req.body?.image_id || '').trim();
      if (!isOidHex(imageId)) {
        return res.status(400).json({ error: 'image_id (24-hex) required' });
      }
      const setAsMain = !!req.body?.set_as_main;
      try {
        const imageMeta = await copyImageToNewOwner({
          projectId: req.projectId,
          imageId,
          ownerType: 'set',
          ownerId: sid,
          filenameBase: `set-${sid}`,
        });
        const result = await addSetImageViaGateway({
          projectId: req.projectId,
          set: sid,
          imageMeta,
          setAsMain,
        });
        res.json(result);
        announceSetMedia({
          req,
          set: await getSet(req.projectId, sid),
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

  // Generate a fresh image from a custom prompt and attach to a set's
  // gallery — parallel to the character generate endpoint.
  router.post('/set/:id/image/generate', async (req, res, next) => {
    try {
      const sid = await resolveSetId(req);
      if (!sid) return res.status(404).json({ error: 'set not found' });
      const prompt = String(req.body?.prompt || '').trim();
      if (!prompt) {
        return res.status(400).json({ error: 'prompt (non-empty) required' });
      }
      if (prompt.length > 4096) {
        return res.status(400).json({ error: 'prompt must be ≤ 4096 chars' });
      }
      const model = normalizeImageModel(req.body?.model);
      if (!await isValidImageModel(model)) {
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
      const file = await uploadGeneratedImage(req.projectId, {
        buffer: result.buffer,
        contentType: result.contentType,
        prompt,
        generatedBy: result.model || model,
        ownerType: 'set',
        ownerId: sid,
        filename: `set-${sid}-gen-${Date.now()}.png`,
      });
      const updated = await addSetImageViaGateway({
        projectId: req.projectId,
        set: sid,
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
        set: updated.set || updated,
        image: { _id: file._id, content_type: file.content_type },
      });
      announceSetMedia({
        req,
        set: await getSet(req.projectId, sid),
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
        ownerType: 'set',
        ownerId: sid,
      });
    } catch (e) {
      if (e?.status >= 400 && e?.status < 600) {
        return res.status(e.status).json({ error: e.message });
      }
      next(e);
    }
  });

  router.post('/set/:id/image/:imageId/move-to-library', async (req, res, next) => {
    try {
      const sid = await resolveSetId(req);
      if (!sid) return res.status(404).json({ error: 'set not found' });
      const imageId = req.params.imageId;
      if (!isOidHex(imageId)) return res.status(400).json({ error: 'invalid image id' });
      try {
        const result = await moveSetImageToLibraryViaGateway({
          projectId: req.projectId,
          set: sid,
          imageId,
        });
        res.json({ ok: true, image_id: imageId, set: result.set });
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

  router.post('/set/:id/main-image', async (req, res, next) => {
    try {
      const sid = await resolveSetId(req);
      if (!sid) return res.status(404).json({ error: 'set not found' });
      const imageId = req.body?.image_id;
      if (!isOidHex(String(imageId))) return res.status(400).json({ error: 'image_id required' });
      const result = await setSetMainImageViaGateway({ projectId: req.projectId, set: sid, imageId });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  router.post('/set/:id/attachment', upload.single('file'), async (req, res, next) => {
    try {
      const sid = await resolveSetId(req);
      if (!sid) return res.status(404).json({ error: 'set not found' });
      if (!req.file) return res.status(400).json({ error: 'file required' });
      const file = await uploadAttachmentBuffer(req.projectId, {
        buffer: req.file.buffer,
        filename: safeFilename(req.file.originalname, `attach-${Date.now()}.bin`),
        contentType: req.file.mimetype,
        ownerType: 'set',
        ownerId: sid,
      });
      const result = await addSetAttachmentViaGateway({
        projectId: req.projectId,
        set: sid,
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
      announceSetMedia({
        req,
        set: await getSet(req.projectId, sid),
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

  router.delete('/set/:id/attachment/:attachId', async (req, res, next) => {
    try {
      const sid = await resolveSetId(req);
      if (!sid) return res.status(404).json({ error: 'set not found' });
      const result = await removeSetAttachmentViaGateway({
        projectId: req.projectId,
        set: sid,
        attachmentId: req.params.attachId,
      });
      res.json(result);
      announceSetMedia({
        req,
        set: await getSet(req.projectId, sid),
        verb: 'deleted a file from',
      });
    } catch (e) {
      next(e);
    }
  });

  // Attach an existing GridFS attachment (from library or another entity) to
  // a set. Picker uses this for the Library tab.
  router.post('/set/:id/attachment/attach', async (req, res, next) => {
    try {
      const sid = await resolveSetId(req);
      if (!sid) return res.status(404).json({ error: 'set not found' });
      const attachmentId = String(req.body?.attachment_id || '').trim();
      if (!isOidHex(attachmentId)) {
        return res.status(400).json({ error: 'attachment_id (24-hex) required' });
      }
      try {
        const result = await attachExistingAttachmentToSetViaGateway({
          projectId: req.projectId,
          set: sid,
          attachmentId,
        });
        res.json(result);
        announceSetMedia({
          req,
          set: await getSet(req.projectId, sid),
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

  // Descriptions come from the vision describer, which writes a detailed
  // single paragraph — roomier than the 200-char name cap, still bounded.
  const ARTWORK_DESCRIPTION_MAX = 4000;

  async function validateArtworkSubmitBody(req, res, { requirePrompt = true } = {}) {
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
    if (!await isValidImageModel(model)) {
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
        const body = await validateArtworkSubmitBody(req, res);
        if (!body) return;
        const refs = await validateArtworkRefs(req, res);
        if (!refs) return;
        const artwork = await startGenerateArtworkJob({
          projectId: req.projectId,
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

    // POST /<host>/:id/artwork/from-image — import an existing GridFS image
    // as a brand-new done artwork. Used by the unified artwork picker's
    // non-Generate tabs (existing artwork, beat refs, characters, library).
    // Cross-owner imports snapshot the bytes; same-owner reuses the id.
    router.post(`${basePath}/:id/artwork/from-image`, async (req, res, next) => {
      try {
        const hostId = await resolveHostId(req);
        if (!hostId) return res.status(404).json({ error: `${hostType} not found` });
        const imageId = String(req.body?.image_id || '').trim();
        if (!isOidHex(imageId)) {
          return res.status(400).json({ error: 'image_id (24-hex) required' });
        }
        const name = String(req.body?.name || '').slice(0, 200);
        const { artwork } = await createArtworkFromImageViaGateway({
          projectId: req.projectId,
          hostType,
          hostId,
          imageId,
          name,
        });
        res.json({ artwork });
        if (hostType === 'beat') {
          announceBeatMedia({
            req,
            beat: await getBeat(req.projectId, hostId),
            verb: 'imported artwork to',
          });
        } else if (hostType === 'character') {
          announceCharacterMedia({
            req,
            character: await getCharacter(req.projectId, hostId),
            verb: 'imported artwork to',
          });
        }
      } catch (e) {
        handleArtworkError(e, res, next);
      }
    });

    // POST /<host>/:id/artwork/from-upload — upload a file and import it as
    // a done artwork in one step. Same as from-image but the source bytes
    // come from the request body instead of an existing GridFS file.
    router.post(
      `${basePath}/:id/artwork/from-upload`,
      upload.single('file'),
      async (req, res, next) => {
        try {
          const hostId = await resolveHostId(req);
          if (!hostId) return res.status(404).json({ error: `${hostType} not found` });
          if (!req.file) return res.status(400).json({ error: 'file required' });
          validateImageBuffer(req.file.buffer);
          const name = String(req.body?.name || '').slice(0, 200);
          const file = await uploadGeneratedImage(req.projectId, {
            buffer: req.file.buffer,
            contentType: req.file.mimetype,
            ownerType: hostType,
            ownerId: hostId,
            filename: safeFilename(
              req.file.originalname,
              `${hostType}-${hostId}-artwork-upload-${Date.now()}.png`,
            ),
            name,
          });
          const { artwork } = await createArtworkFromImageViaGateway({
            projectId: req.projectId,
            hostType,
            hostId,
            imageId: file._id,
            name,
          });
          res.json({ artwork });
          if (hostType === 'beat') {
            announceBeatMedia({
              req,
              beat: await getBeat(req.projectId, hostId),
              verb: 'imported artwork to',
            });
          } else if (hostType === 'character') {
            announceCharacterMedia({
              req,
              character: await getCharacter(req.projectId, hostId),
              verb: 'imported artwork to',
            });
          }
        } catch (e) {
          handleArtworkError(e, res, next);
        }
      },
    );

    // POST /<host>/:id/artwork/:artworkId/regenerate — fresh provider call
    // on an existing artwork. The user can change prompt/model/refs.
    router.post(`${basePath}/:id/artwork/:artworkId/regenerate`, async (req, res, next) => {
      try {
        const hostId = await resolveHostId(req);
        if (!hostId) return res.status(404).json({ error: `${hostType} not found` });
        const artworkId = req.params.artworkId;
        if (!isOidHex(artworkId)) return res.status(400).json({ error: 'invalid artwork id' });
        const body = await validateArtworkSubmitBody(req, res);
        if (!body) return;
        const refs = await validateArtworkRefs(req, res);
        if (!refs) return;
        const artwork = await startRegenerateArtworkJob({
          projectId: req.projectId,
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
    // previous_result_image_id for one-step undo. Optional
    // `reference_image_ids[]` are passed alongside the existing image so the
    // model can incorporate them.
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
        if (!await isValidImageModel(model)) {
          return res.status(400).json({ error: IMAGE_MODEL_ERROR });
        }
        const refs = await loadReferenceImages(req.body?.reference_image_ids);
        if (refs.error) {
          return res.status(refs.status || 400).json({ error: refs.error });
        }
        const artwork = await startEditArtworkJob({
          projectId: req.projectId,
          hostType,
          hostId,
          artworkId,
          prompt,
          model,
          referenceImageIds: refs.ids,
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
        const artwork = await undoArtworkEdit({ projectId: req.projectId, hostType, hostId, artworkId });
        res.json({ artwork });
      } catch (e) {
        handleArtworkError(e, res, next);
      }
    });

    // PATCH /<host>/:id/artwork/:artworkId — metadata-only update
    // (name / description). `description` is what the plate DEPICTS; the
    // generation `prompt` is deliberately not patchable here, since editing it
    // would silently change what Regenerate sends to the image model.
    router.patch(`${basePath}/:id/artwork/:artworkId`, async (req, res, next) => {
      try {
        const hostId = await resolveHostId(req);
        if (!hostId) return res.status(404).json({ error: `${hostType} not found` });
        const artworkId = req.params.artworkId;
        if (!isOidHex(artworkId)) return res.status(400).json({ error: 'invalid artwork id' });
        const patch = {};
        if (typeof req.body?.name === 'string') patch.name = req.body.name.slice(0, 200);
        if (typeof req.body?.description === 'string') {
          patch.description = req.body.description.slice(0, ARTWORK_DESCRIPTION_MAX);
        }
        if (Object.keys(patch).length === 0) {
          return res
            .status(400)
            .json({ error: 'no recognized fields to patch (expected: name, description)' });
        }
        const { artwork } = await patchArtworkViaGateway({
          projectId: req.projectId,
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

    // POST /<host>/:id/artwork/:artworkId/describe — run the vision describer
    // over the rendered plate and write the result back. Awaited rather than
    // queued: the user clicked a button and is watching for the text. Fills a
    // blank name too, but never overwrites one that's already set.
    router.post(`${basePath}/:id/artwork/:artworkId/describe`, async (req, res, next) => {
      try {
        const hostId = await resolveHostId(req);
        if (!hostId) return res.status(404).json({ error: `${hostType} not found` });
        const artworkId = req.params.artworkId;
        if (!isOidHex(artworkId)) return res.status(400).json({ error: 'invalid artwork id' });
        const { artwork, changed } = await describeArtwork({
          projectId: req.projectId,
          hostType,
          hostId,
          artworkId,
        });
        res.json({ artwork, changed });
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
        await deleteArtwork({ projectId: req.projectId, hostType, hostId, artworkId });
        res.json({ ok: true, removed: artworkId });
        if (hostType === 'beat') {
          announceBeatMedia({
            req,
            beat: await getBeat(req.projectId, hostId),
            verb: 'deleted artwork from',
          });
        } else if (hostType === 'character') {
          announceCharacterMedia({
            req,
            character: await getCharacter(req.projectId, hostId),
            verb: 'deleted artwork from',
          });
        }
      } catch (e) {
        handleArtworkError(e, res, next);
      }
    });

    // POST /<host>/:id/image-sheet — start a batch "image sheet" generation
    // job. Characters get a fixed portrait/turnaround set; beats get a
    // dynamically-planned set of environment/background plates. Returns 202 +
    // { job_id, planned, host_type, host_id } immediately; each generated image
    // lands as a pending→done artwork the gallery already renders live, and the
    // SPA polls GET /image-sheet/:jobId for the aggregate progress.
    router.post(`${basePath}/:id/image-sheet`, async (req, res, next) => {
      try {
        const hostId = await resolveHostId(req);
        if (!hostId) return res.status(404).json({ error: `${hostType} not found` });
        const model = normalizeImageModel(req.body?.model);
        if (!await isValidImageModel(model)) {
          return res.status(400).json({ error: IMAGE_MODEL_ERROR });
        }
        const refs = await validateArtworkRefs(req, res);
        if (!refs) return;
        const shotCount = req.body?.shot_count != null ? Number(req.body.shot_count) : undefined;
        const shotNames = Array.isArray(req.body?.shot_names)
          ? req.body.shot_names.map((s) => String(s)).filter(Boolean)
          : undefined;
        const shots = Array.isArray(req.body?.shots) ? req.body.shots : undefined;
        // Sets only: linked sets whose gallery images join the render
        // reference pool (entries are hex-filtered downstream).
        if (hostType === 'set' && req.body?.reference_set_ids != null && !Array.isArray(req.body.reference_set_ids)) {
          return res.status(400).json({ error: 'reference_set_ids must be an array' });
        }
        const referenceSetIds = hostType === 'set' && Array.isArray(req.body?.reference_set_ids)
          ? req.body.reference_set_ids
          : [];
        const { startImageSheetJob } = await import('./imageSheetJobs.js');
        const result = await startImageSheetJob({
          projectId: req.projectId,
          hostType,
          hostId,
          model,
          referenceImageIds: refs.ids,
          referenceSetIds,
          shotNames,
          shotCount,
          shots,
          discordUser: webDiscordUser(req),
          announceUsername: req?.session?.username || null,
        });
        if (hostType === 'beat') {
          // Remember the references this sheet used (tune-dialog prefill).
          // Per-plate assignments replaced the sheet-level pool, so persist
          // the union of both — and never wipe the stored set with nothing.
          const shotRefIds = (Array.isArray(shots) ? shots : []).flatMap((s) =>
            Array.isArray(s?.reference_image_ids) ? s.reference_image_ids.map(String) : []);
          const usedRefIds = [...new Set([...refs.ids.map(String), ...shotRefIds])];
          if (usedRefIds.length) {
            const { setBeatImageSheetReferences } = await import('../mongo/plots.js');
            await setBeatImageSheetReferences(req.projectId, hostId, usedRefIds).catch((e) =>
              logger.warn(`image-sheet: persist reference set failed: ${e.message}`));
          }
        }
        res.status(202).json(result);
      } catch (e) {
        handleArtworkError(e, res, next);
      }
    });

    // POST /<host>/:id/shot-plan — start a two-phase plate DERIVATION job
    // (beats and sets). Renders nothing; returns 202 + { job_id }. The SPA
    // polls GET /image-sheet/:jobId until status==='derived', shows job.shots
    // for review, then POSTs the reviewed list to /<host>/:id/image-sheet.
    if (hostType === 'beat' || hostType === 'set') {
      router.post(`${basePath}/:id/shot-plan`, async (req, res, next) => {
        try {
          const hostId = await resolveHostId(req);
          if (!hostId) return res.status(404).json({ error: `${hostType} not found` });
          const refs = await validateArtworkRefs(req, res);
          if (!refs) return;
          const direction = String(req.body?.direction || '').slice(0, 4000);
          const previousPlates = Array.isArray(req.body?.previous_plates) ? req.body.previous_plates : undefined;
          // Sets only: plates are planned for the main beat when one is
          // chosen; `beat_ids` is then the context-only selection. Without a
          // main beat the legacy rule holds (beat_ids narrows the flattened
          // selection, empty/omitted = all referencing beats).
          const mainBeatRaw = hostType === 'set' ? req.body?.main_beat_id : null;
          if (mainBeatRaw != null && !(typeof mainBeatRaw === 'string' && /^[a-f0-9]{24}$/i.test(mainBeatRaw))) {
            return res.status(400).json({ error: 'main_beat_id must be a 24-hex string' });
          }
          if (hostType === 'set' && req.body?.reference_set_ids != null && !Array.isArray(req.body.reference_set_ids)) {
            return res.status(400).json({ error: 'reference_set_ids must be an array' });
          }
          const beatIds = hostType === 'set' && Array.isArray(req.body?.beat_ids) ? req.body.beat_ids : [];
          const referenceSetIds = hostType === 'set' && Array.isArray(req.body?.reference_set_ids)
            ? req.body.reference_set_ids
            : [];
          const { startShotPlanJob } = await import('./imageSheetJobs.js');
          const result = await startShotPlanJob({
            projectId: req.projectId,
            hostType,
            hostId,
            referenceImageIds: refs.ids,
            mainBeatId: mainBeatRaw || null,
            beatIds,
            referenceSetIds,
            direction,
            previousPlates,
          });
          res.status(202).json(result);
        } catch (e) {
          handleArtworkError(e, res, next);
        }
      });

      // GET /<host>/:id/image-sheet-references — the reference set to pre-fill
      // the derive dialog with. Beats: saved set, else the beat's artwork refs.
      // Sets: the set's own gallery images.
      router.get(`${basePath}/:id/image-sheet-references`, async (req, res, next) => {
        try {
          const hostId = await resolveHostId(req);
          if (!hostId) return res.status(404).json({ error: `${hostType} not found` });
          if (hostType === 'set') {
            const s = await getSet(req.projectId, hostId);
            if (!s) return res.status(404).json({ error: 'set not found' });
            res.json({
              reference_ids: (s.images || []).map((i) => String(i._id)).filter(Boolean),
            });
            return;
          }
          const { computeImageSheetPrefillIds } = await import('../mongo/plots.js');
          const beat = await getBeat(req.projectId, hostId);
          if (!beat) return res.status(404).json({ error: 'beat not found' });
          res.json({ reference_ids: computeImageSheetPrefillIds(beat) });
        } catch (e) {
          next(e);
        }
      });
    }
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
  registerArtworkRoutes({
    hostType: 'set',
    basePath: '/set',
    resolveHostId: resolveSetId,
  });

  // Picker support: returns every beat with its embedded images and
  // artworks (result image ids + names). The SPA's tabbed reference picker
  // loads this lazily when the user clicks the "Beats" tab.
  router.get('/beats/with-artwork', async (req, res, next) => {
    try {
      const beats = await listBeats(req.projectId);
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

  // Picker support for the Character page artwork picker — same shape as
  // /beats/with-artwork but filtered to beats that feature the given
  // character (resolved by name via findCharactersInBeat, mirroring the
  // renderer's matching path).
  router.get('/beats-featuring-character', async (req, res, next) => {
    try {
      const characterId = String(req.query?.character_id || '').trim();
      if (!isOidHex(characterId)) {
        return res.status(400).json({ error: 'character_id (24-hex) required' });
      }
      const target = await getCharacter(req.projectId, characterId);
      if (!target) return res.status(404).json({ error: 'character not found' });
      const targetIdStr = target._id?.toString?.() || String(target._id);
      const { findCharactersInBeat } = await import('./beatPlanShared.js');
      const beats = await listBeats(req.projectId);
      const out = [];
      for (const b of beats) {
        const chars = await findCharactersInBeat(req.projectId, b);
        const features = chars.some(
          (c) => (c._id?.toString?.() || String(c._id)) === targetIdStr,
        );
        if (!features) continue;
        out.push({
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
        });
      }
      res.json({ beats: out });
    } catch (e) {
      next(e);
    }
  });

  // ── notes mutations (non-text) ───────────────────────────────────────────

  async function fetchDirectorNote(noteId, projectId) {
    try {
      const doc = await getDirectorNotes(projectId);
      const notes = doc?.notes || [];
      return notes.find((n) => String(n._id) === String(noteId)) || null;
    } catch {
      return null;
    }
  }

  router.post('/notes', async (req, res, next) => {
    try {
      const text = String(req.body?.text || '').trim() || '_New note_';
      const note = await addDirectorNoteViaGateway({ projectId: req.projectId, text });
      res.json({ note });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/notes/:noteId', async (req, res, next) => {
    try {
      if (!isOidHex(req.params.noteId)) return res.status(400).json({ error: 'invalid id' });
      await removeDirectorNoteViaGateway({ projectId: req.projectId, noteId: req.params.noteId });
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
      const file = await uploadGeneratedImage(req.projectId, {
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
        ownerType: 'director_note',
        ownerId: req.params.noteId,
        filename: safeFilename(req.file.originalname, `note-${req.params.noteId}-${Date.now()}.png`),
      });
      const setAsMain = req.body?.set_as_main === 'true' || req.query.set_as_main === '1';
      const result = await addDirectorNoteImageViaGateway({
        projectId: req.projectId,
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
        note: await fetchDirectorNote(req.params.noteId, req.projectId),
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
        projectId: req.projectId,
        noteId: req.params.noteId,
        imageId: req.params.imageId,
      });
      res.json(result);
      announceNoteMedia({
        req,
        note: await fetchDirectorNote(req.params.noteId, req.projectId),
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
          projectId: req.projectId,
          imageId,
          ownerType: 'director_note',
          ownerId: noteId,
          filenameBase: `note-${noteId}`,
        });
        const result = await addDirectorNoteImageViaGateway({
          projectId: req.projectId,
          noteId,
          imageMeta,
          setAsMain,
        });
        res.json(result);
        announceNoteMedia({
          req,
          note: await fetchDirectorNote(noteId, req.projectId),
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
        projectId: req.projectId,
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
      const file = await uploadAttachmentBuffer(req.projectId, {
        buffer: req.file.buffer,
        filename: safeFilename(req.file.originalname, `note-attach-${Date.now()}.bin`),
        contentType: req.file.mimetype,
        ownerType: 'director_note',
        ownerId: req.params.noteId,
      });
      const result = await addDirectorNoteAttachmentViaGateway({
        projectId: req.projectId,
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
        note: await fetchDirectorNote(req.params.noteId, req.projectId),
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
        projectId: req.projectId,
        noteId: req.params.noteId,
        attachmentId: req.params.attachId,
      });
      res.json(result);
      announceNoteMedia({
        req,
        note: await fetchDirectorNote(req.params.noteId, req.projectId),
        verb: 'deleted a file from',
      });
    } catch (e) {
      next(e);
    }
  });

  // Auto-fill the scene bible from the beat. Synchronous (one LLM pass, a few
  // seconds — like the dialogue critic).
  router.post('/beat/:beatId/scene-bible/autofill', async (req, res, next) => {
    try {
      const beat = await getBeat(req.projectId, String(req.params.beatId));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const { autofillSceneBible } = await import('./sceneBibleAutofill.js');
      const result = await autofillSceneBible({ projectId: req.projectId, beatId: beat._id.toString() });
      res.json(result);
    } catch (e) {
      if (e?.code === 'BEAT_BUSY') return res.status(409).json({ error: e.message });
      next(e);
    }
  });

  // Auto-generate a set's description from the beats that stage in it.
  // Synchronous like the scene-bible autofill above: the gateway write makes an
  // open description editor fill in live before the response even lands.
  router.post('/set/:id/generate-description', async (req, res, next) => {
    try {
      if (!config.anthropic?.apiKey) {
        return res.status(400).json({ error: 'ANTHROPIC_API_KEY is not configured.' });
      }
      const sid = await resolveSetId(req);
      if (!sid) return res.status(404).json({ error: 'set not found' });
      const beatIds = (Array.isArray(req.body?.beat_ids) ? req.body.beat_ids : [])
        .map(String)
        .filter(isOidHex)
        .slice(0, 50);
      const direction = String(req.body?.direction || '').slice(0, 2000);
      const { generateSetDescription } = await import('./setDescriptionGenerate.js');
      const result = await generateSetDescription({
        projectId: req.projectId,
        setId: sid,
        beatIds,
        direction,
      });
      res.json(result);
    } catch (e) {
      if (e?.status >= 400 && e?.status < 500) return res.status(e.status).json({ error: e.message });
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

  // Kick off a server-side catalog regeneration (the same scrape as
  // `npm run refresh:fal-models`). Single-flight — a second POST while one is
  // running just returns the in-flight state. The SPA polls the GET below and
  // re-fetches /video-models when `running` flips back to false.
  router.post('/video-models/refresh', async (_req, res, next) => {
    try {
      const { config } = await import('../config.js');
      if (!config.fal.apiKey) {
        return res.status(503).json({ error: 'fal.ai is not configured (FAL_KEY missing).' });
      }
      const { startCatalogRefresh } = await import('../fal/catalogRefresh.js');
      res.json(startCatalogRefresh());
    } catch (err) {
      next(err);
    }
  });

  router.get('/video-models/refresh', async (_req, res, next) => {
    try {
      const { getCatalogRefreshState } = await import('../fal/catalogRefresh.js');
      res.json(getCatalogRefreshState());
    } catch (err) {
      next(err);
    }
  });

  // ── Playground ────────────────────────────────────────────────────────
  // A scratchpad for trying any fal.ai model with drag-and-dropped reference
  // media. Models come from data/fal-playground-models.json (see
  // scripts/build-fal-playground-catalog.js); outputs persist as
  // project-scoped GridFS files tagged owner_type 'playground'.

  router.get('/playground/models', async (_req, res, next) => {
    try {
      const { config } = await import('../config.js');
      const catalog = await loadPlaygroundCatalog();
      res.json({
        configured: Boolean(config.fal.apiKey),
        catalog_generated_at: catalog.generated_at ?? null,
        catalog_error: catalog.catalog_error,
        models: catalog.models,
      });
    } catch (err) {
      next(err);
    }
  });

  // Past generated outputs for this project, newest first, both buckets
  // merged. Reference uploads are excluded (see the listers).
  router.get('/playground/history', async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
      const [images, attachments] = await Promise.all([
        listPlaygroundGeneratedImages(req.projectId),
        listPlaygroundGeneratedAttachments(req.projectId),
      ]);
      const toItem = (f) => ({
        file_id: String(f._id),
        filename: f.filename || null,
        content_type: f.contentType || f.metadata?.content_type || null,
        size: f.length ?? null,
        prompt: f.metadata?.prompt || null,
        model: f.metadata?.generated_by || null,
        created_at: f.uploadDate || null,
      });
      const items = [
        ...images.map((f) => ({ ...toItem(f), kind: 'image' })),
        ...attachments.map((f) => {
          const item = toItem(f);
          return { ...item, kind: classifyMediaKind(item.content_type) || 'file' };
        }),
      ]
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
        .slice(0, limit);
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  // Upload one reference file (image/audio/video). Images land in the images
  // bucket (magic-byte validated inside uploadGeneratedImage); audio/video in
  // the attachments bucket.
  router.post('/playground/upload', upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'file required' });
      const mime = String(req.file.mimetype || '');
      const kind = mime.startsWith('image/') ? 'image'
        : mime.startsWith('audio/') ? 'audio'
        : mime.startsWith('video/') ? 'video'
        : null;
      if (!kind) {
        return res.status(400).json({ error: 'file must be an image, audio, or video file' });
      }
      let file;
      if (kind === 'image') {
        try {
          file = await uploadGeneratedImage(req.projectId, {
            buffer: req.file.buffer,
            contentType: mime,
            ownerType: 'playground',
            filename: safeFilename(req.file.originalname, `playground-${Date.now()}.png`),
          });
        } catch (e) {
          return res.status(400).json({ error: `invalid image: ${e.message}` });
        }
      } else {
        file = await uploadAttachmentBuffer(req.projectId, {
          buffer: req.file.buffer,
          filename: safeFilename(req.file.originalname, `playground-${Date.now()}.bin`),
          contentType: mime,
          ownerType: 'playground',
        });
      }
      res.json({
        ref: {
          file_id: file._id.toString(),
          kind,
          filename: file.filename,
          size: file.size ?? req.file.buffer.length,
          content_type: file.content_type ?? mime,
        },
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/playground/generate', async (req, res, next) => {
    try {
      const { job_id } = await startPlaygroundJob({
        projectId: req.projectId,
        modelId: String(req.body?.model_id || ''),
        prompt: typeof req.body?.prompt === 'string' ? req.body.prompt : null,
        refs: Array.isArray(req.body?.refs) ? req.body.refs : [],
        options: req.body?.options && typeof req.body.options === 'object' ? req.body.options : {},
      });
      res.status(202).json({ job_id });
    } catch (err) {
      if (err?.code === 'FAL_NOT_CONFIGURED') {
        return res.status(503).json({ error: err.message });
      }
      if (err?.code === 'UNKNOWN_MODEL') {
        return res.status(404).json({ error: err.message });
      }
      if (err?.code === 'MISSING_INPUTS') {
        return res.status(400).json({ error: err.message, missing: err.missing || [] });
      }
      if (err?.code === 'BAD_OPTIONS') {
        return res.status(400).json({ error: err.message, errors: err.errors || [] });
      }
      next(err);
    }
  });

  // Remove an uploaded reference. Only files this project uploaded through
  // the playground are deletable — anything else behaves as not-found.
  router.delete('/playground/ref/:kind/:id', async (req, res, next) => {
    try {
      const kind = String(req.params.kind || '');
      if (!['image', 'audio', 'video'].includes(kind)) {
        return res.status(404).json({ error: 'not found' });
      }
      const file = kind === 'image'
        ? await findImageFile(req.params.id).catch(() => null)
        : await findAttachmentFile(req.params.id).catch(() => null);
      const meta = file?.metadata || null;
      if (!meta || String(meta.project_id) !== String(req.projectId) || meta.owner_type !== 'playground') {
        return res.status(404).json({ error: 'not found' });
      }
      if (kind === 'image') await deleteImage(req.params.id);
      else await deleteAttachment(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // Poll an image-sheet job started via POST /:host/:id/image-sheet. Job ids are
  // global (not host-scoped), so verify the job belongs to the caller's project
  // before returning it.
  router.get('/image-sheet/:jobId', async (req, res, next) => {
    try {
      const { getImageSheetJob } = await import('./imageSheetJobs.js');
      const job = getImageSheetJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'job not found' });
      if (job.project_id && String(job.project_id) !== String(req.projectId)) {
        return res.status(404).json({ error: 'job not found' });
      }
      res.json({ job });
    } catch (e) {
      next(e);
    }
  });

  // The canonical character-sheet shot list, so the SPA can render a checklist
  // the user ticks/unticks before generating. Static — the same source the
  // generator selects from.
  router.get('/character-sheet-shots', async (req, res, next) => {
    try {
      const { CHARACTER_SHEET_SHOTS } = await import('./characterSheetShots.js');
      res.json({ shots: CHARACTER_SHEET_SHOTS.map((s) => ({ name: s.name, hint: s.fragment })) });
    } catch (e) {
      next(e);
    }
  });

  // ── dialog mutations ────────────────────────────────────────────────────

  async function resolveDialogId(req) {
    const { id } = req.params;
    if (!isOidHex(id)) return null;
    const d = await getDialog(req.projectId, id);
    return d?._id?.toString() || null;
  }

  router.get('/dialogs', async (req, res, next) => {
    try {
      const beatRef = req.query.beat_id;
      if (beatRef == null || beatRef === '') {
        return res.status(400).json({ error: 'beat_id required' });
      }
      const beat = await getBeat(req.projectId, String(beatRef));
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
      const beat = await getBeat(req.projectId, String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const d = await createDialogViaGateway({
        projectId: req.projectId,
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
      const result = await deleteDialogViaGateway({ projectId: req.projectId, dialogId: dId });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  // Update a dialog item's speaker and/or body. Roster character names are
  // canonicalized to their stored spelling; anything else is saved as a
  // free-text speaker (e.g. "radio", "TV ANCHOR"). `body` is written through
  // the y-doc so the change reflects in connected SPAs — used when the user
  // applies a regenerated alternative. At least one field is required.
  router.patch('/dialog/:id', async (req, res, next) => {
    try {
      const dId = await resolveDialogId(req);
      if (!dId) return res.status(404).json({ error: 'dialog not found' });
      const { character, body } = req.body || {};
      const hasCharacter = typeof character === 'string';
      const hasBody = typeof body === 'string';
      if (!hasCharacter && !hasBody) {
        return res
          .status(400)
          .json({ error: 'character and/or body (string) required' });
      }
      const {
        setDialogCharacterViaGateway,
        setDialogTextFieldViaGateway,
      } = await import('./gateway.js');
      try {
        if (hasBody) {
          await setDialogTextFieldViaGateway({ projectId: req.projectId, dialogId: dId, field: 'body', text: body });
        }
        let dialog;
        if (hasCharacter) {
          dialog = await setDialogCharacterViaGateway({
            projectId: req.projectId,
            dialogId: dId,
            characterName: character,
          });
        } else {
          dialog = await getDialog(req.projectId, dId);
        }
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
      let ct = req.file.mimetype || 'audio/mpeg';
      if (!ct.startsWith('audio/')) {
        // Recover a codec-qualified type the multipart parser couldn't read
        // (see the video-upload route) from the filename extension.
        const inferred = contentTypeFromFilename(req.file.originalname);
        if (inferred?.startsWith('audio/')) ct = inferred;
        else return res.status(400).json({ error: 'file must be audio/*' });
      }
      const dialog = await getDialog(req.projectId, dId);
      let audio;
      try {
        audio = await normalizeUploadedAudioToMp3({
          file: req.file,
          contentType: ct,
          fallbackName: `dialog-${dId}-audio-${Date.now()}.bin`,
        });
      } catch (e) {
        const handled = sendAudioTranscodeError(res, e);
        if (handled) return handled;
        throw e;
      }
      const file = await uploadAttachmentBuffer(req.projectId, {
        buffer: audio.buffer,
        filename: audio.filename,
        contentType: audio.contentType,
        ownerType: 'dialog',
        ownerId: dialog._id,
      });
      const result = await setDialogAudioViaGateway({
        projectId: req.projectId,
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
          beat: await getBeat(req.projectId, String(dialog.beat_id)),
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
        projectId: req.projectId,
        dialogId: dId,
        audioFileId: null,
      });
      res.json({ dialog: result });
      if (result?.beat_id) {
        announceBeatMedia({
          req,
          beat: await getBeat(req.projectId, String(result.beat_id)),
          verb: 'deleted dialog audio from',
        });
      }
    } catch (e) {
      next(e);
    }
  });

  // Manual beat create from the TOC's "+ New beat" button: an empty beat
  // appended at the end of the list. The name is a placeholder the user
  // renames on the beat page (beat names aren't unique, so no 409 path).
  router.post('/beat', async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim() || 'New beat';
      if (name.length > 200) return res.status(400).json({ error: 'name must be ≤ 200 chars' });
      const beat = await createBeatViaGateway({ projectId: req.projectId, name });
      res.status(201).json({ beat });
    } catch (e) {
      next(e);
    }
  });

  router.post('/beats/reorder', async (req, res, next) => {
    try {
      const orderedIds = req.body?.ordered_ids;
      if (!Array.isArray(orderedIds)) {
        return res.status(400).json({ error: 'ordered_ids must be an array' });
      }
      const beats = await reorderBeatsViaGateway({
        projectId: req.projectId,
        orderedIds,
      });
      res.json({ beats });
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
      const beat = await getBeat(req.projectId, String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const result = await reorderDialogsViaGateway({
        projectId: req.projectId,
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
      const beat = await getBeat(req.projectId, String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const { startDialogGenerationJob, BeatBusyError } = await import(
        './dialogGenerate.js'
      );
      try {
        const jobId = await startDialogGenerationJob({
          projectId: req.projectId,
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
      const beat = await getBeat(req.projectId, String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const { isBeatLocked } = await import('./beatLocks.js');
      if (isBeatLocked(beat._id)) {
        return res
          .status(409)
          .json({ error: 'Dialog work in progress for this beat; try again' });
      }
      const { deleteAllDialogsForBeatViaGateway } = await import('./gateway.js');
      const result = await deleteAllDialogsForBeatViaGateway({ projectId: req.projectId, beatId: beat._id });
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
      const beat = await getBeat(req.projectId, String(beatRef));
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
          editDialog({ projectId: req.projectId, beatId: beat._id, instructions }),
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

  // Per-line regenerate: propose alternative rewrites for one dialog line,
  // keeping the speaker and the surrounding lines fixed. Read-only — the SPA
  // shows the options and applies a choice via PATCH /dialog/:id { body }.
  router.post('/dialog/:id/alternatives', async (req, res, next) => {
    try {
      const dId = await resolveDialogId(req);
      if (!dId) return res.status(404).json({ error: 'dialog not found' });
      const { generateAlternatives } = await import('./dialogRegenerate.js');
      const result = await generateAlternatives({ projectId: req.projectId, dialogId: dId });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  // Advisory critic: score every line of a beat's dialogue. Synchronous,
  // persists nothing — the SPA renders the scores as flags.
  router.post('/dialogs/critique', async (req, res, next) => {
    try {
      const beatRef = req.body?.beat_id;
      if (!beatRef) return res.status(400).json({ error: 'beat_id required' });
      const beat = await getBeat(req.projectId, String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const { critiqueDialog } = await import('./dialogCritique.js');
      const result = await critiqueDialog({ projectId: req.projectId, beatId: beat._id.toString() });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  // Generate (or regenerate) the per-line "Direction" note — the voice-actor
  // performance note: what's happening in the scene at this moment + how to play
  // this line. The result is written to the dialog's collaborative `direction`
  // field through the gateway, so it lands live in any open editor.
  router.post('/dialog/:id/direction', async (req, res, next) => {
    try {
      const dId = await resolveDialogId(req);
      if (!dId) return res.status(404).json({ error: 'dialog not found' });
      const { generateDirectionForLine } = await import('./dialogDirection.js');
      const { setDialogTextFieldViaGateway } = await import('./gateway.js');
      const { direction } = await generateDirectionForLine({
        projectId: req.projectId,
        dialogId: dId,
      });
      await setDialogTextFieldViaGateway({
        projectId: req.projectId,
        dialogId: dId,
        field: 'direction',
        text: direction,
      });
      const dialog = await getDialog(req.projectId, dId);
      res.json({ dialog, direction });
    } catch (e) {
      next(e);
    }
  });

  // Whole-beat "Prepare notes": one Direction note per line in a single pass,
  // each written back through the gateway. Locked like /dialogs/edit because it
  // writes to every line.
  router.post('/dialogs/direction', async (req, res, next) => {
    try {
      const beatRef = req.body?.beat_id;
      if (!beatRef) return res.status(400).json({ error: 'beat_id required' });
      const beat = await getBeat(req.projectId, String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const { isBeatLocked, withBeatLock } = await import('./beatLocks.js');
      if (isBeatLocked(beat._id)) {
        return res
          .status(409)
          .json({ error: 'Dialog work in progress for this beat; try again' });
      }
      const { generateDirectionForBeat } = await import('./dialogDirection.js');
      const { setDialogTextFieldViaGateway } = await import('./gateway.js');
      const notes = await withBeatLock(beat._id, async () => {
        const { notes } = await generateDirectionForBeat({
          projectId: req.projectId,
          beatId: beat._id.toString(),
        });
        for (const n of notes) {
          await setDialogTextFieldViaGateway({
            projectId: req.projectId,
            dialogId: n.dialog_id,
            field: 'direction',
            text: n.direction,
          });
        }
        return notes;
      });
      res.json({ count: notes.length });
    } catch (e) {
      next(e);
    }
  });

  // Project-level dialogue style / influences (steers every dialogue op).
  router.get('/plot/dialogue-style', async (req, res, next) => {
    try {
      const { getPlot } = await import('../mongo/plots.js');
      const plot = await getPlot(req.projectId);
      res.json({ dialogue_style: plot.dialogue_style || '' });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/plot/dialogue-style', async (req, res, next) => {
    try {
      const { text } = req.body || {};
      if (typeof text !== 'string') {
        return res.status(400).json({ error: 'text (string) required' });
      }
      const { updatePlot } = await import('../mongo/plots.js');
      const plot = await updatePlot(req.projectId, { dialogue_style: text });
      res.json({ dialogue_style: plot.dialogue_style || '' });
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
