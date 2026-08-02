// /api/eleven — the ElevenLabs playground backend. Mounted inside
// buildApiRouter() AFTER resolveProject() and requireSession(), so every
// handler can rely on req.projectId. All generation endpoints are
// synchronous: ElevenLabs is direct HTTP (seconds, no queue), so there is no
// SSE job registry here — the SPA just shows a spinner on the request.
//
// Outputs persist to the GridFS `attachments` bucket with owner_type
// 'playground' (generated_by 'elevenlabs/<tool>'), which makes them show up
// in the existing playground History tab. Audio inputs come in as refs
// previously uploaded through POST /api/playground/upload.

import express from 'express';
import * as eleven from '../eleven/client.js';
import { AUDIO_TAGS } from '../eleven/tags.js';
import { enhanceWithAudioTags } from '../eleven/enhance.js';
import {
  listCollectionVoices,
  getCollectionVoice,
  addVoiceToCollection,
  removeVoiceFromCollection,
  markVoiceAddedToAccount,
} from '../mongo/elevenVoices.js';
import { readAttachmentBuffer, uploadAttachmentBuffer } from '../mongo/attachments.js';
import { logger } from '../log.js';

const TTS_MODELS = new Set([
  'eleven_v3', 'eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2_5',
]);
const MAX_TTS_CHARS = 10_000;

function sendError(res, e) {
  const status = Number(e?.status);
  res
    .status(Number.isInteger(status) && status >= 400 && status < 600 ? status : 502)
    .json({ error: e?.message || 'ElevenLabs request failed' });
}

function requireConfigured(req, res, next) {
  if (!eleven.isConfigured()) {
    res.status(503).json({ error: 'ElevenLabs is not configured on the server (ELEVEN_LABS_KEY missing).' });
    return;
  }
  next();
}

// Public fields for a shared-library voice card. The raw API rows carry many
// internal fields; the SPA gets only what it renders.
function libraryVoiceView(v) {
  return {
    voice_id: v.voice_id,
    public_owner_id: v.public_owner_id,
    name: v.name,
    description: v.description || null,
    preview_url: v.preview_url || null,
    category: v.category || null,
    gender: v.gender || null,
    age: v.age || null,
    accent: v.accent || null,
    language: v.language || null,
    use_case: v.use_case || null,
    descriptive: v.descriptive || null,
    free_users_allowed: v.free_users_allowed !== false,
  };
}

function collectionVoiceView(doc) {
  return {
    voice_id: doc.voice_id,
    public_owner_id: doc.public_owner_id,
    name: doc.name,
    description: doc.description,
    preview_url: doc.preview_url,
    labels: doc.labels || {},
    category: doc.category,
    source: doc.source,
    added_to_account: Boolean(doc.added_to_account),
  };
}

// Load an audio ref from GridFS, enforcing playground ownership within this
// project — stale/cross-project ids behave as not-found (same convention as
// playgroundGenerate.js#loadRef).
async function loadAudioRef(projectId, ref) {
  const fileId = String(ref?.file_id || '');
  if (!fileId) {
    throw Object.assign(new Error('ref.file_id required'), { status: 400 });
  }
  const read = await readAttachmentBuffer(fileId).catch(() => null);
  const meta = read?.file?.metadata || null;
  if (!read || !meta
    || String(meta.project_id) !== String(projectId)
    || meta.owner_type !== 'playground') {
    throw Object.assign(new Error(`Playground audio reference not found: ${fileId}`), { status: 404 });
  }
  const contentType = String(meta.content_type || '');
  if (!contentType.startsWith('audio/') && !contentType.startsWith('video/')) {
    throw Object.assign(new Error('Reference must be an audio (or video) file.'), { status: 400 });
  }
  return { buffer: read.buffer, contentType, filename: read.file.filename || 'audio' };
}

// Shared-library voices can't be used for TTS/STS until they're in the
// account's My Voices. Proactively add un-added library voices; an
// "already added" style failure counts as success (e.g. added from another
// project or the ElevenLabs site).
async function ensureVoiceUsable(projectId, voiceDoc) {
  if (voiceDoc.added_to_account || voiceDoc.source !== 'library' || !voiceDoc.public_owner_id) return;
  try {
    await eleven.addSharedVoice({
      publicOwnerId: voiceDoc.public_owner_id,
      voiceId: voiceDoc.voice_id,
      newName: voiceDoc.name,
    });
  } catch (e) {
    if (!/already|exist|added|duplicate/i.test(e?.message || '')) throw e;
  }
  await markVoiceAddedToAccount(projectId, voiceDoc.voice_id);
}

async function requireCollectionVoice(projectId, voiceId) {
  const id = String(voiceId || '').trim();
  if (!id) throw Object.assign(new Error('voice_id required'), { status: 400 });
  const doc = await getCollectionVoice(projectId, id);
  if (!doc) {
    throw Object.assign(
      new Error("Voice is not in this project's collection — add it from the library first."),
      { status: 404 },
    );
  }
  return doc;
}

async function persistAudioOutput(projectId, { buffer, contentType, tool, prompt = null }) {
  const ext = /wav/.test(contentType || '') ? 'wav' : 'mp3';
  const file = await uploadAttachmentBuffer(projectId, {
    buffer,
    filename: `eleven-${tool}-${Date.now()}.${ext}`,
    contentType: contentType || 'audio/mpeg',
    ownerType: 'playground',
    prompt: prompt ? String(prompt).slice(0, 500) : null,
    generatedBy: `elevenlabs/${tool}`,
  });
  return { kind: 'audio', file_id: file._id.toString() };
}

export function buildElevenRouter() {
  const router = express.Router();

  router.get('/info', (_req, res) => {
    res.json({ configured: eleven.isConfigured(), tags: AUDIO_TAGS });
  });

  router.get('/library', requireConfigured, async (req, res) => {
    try {
      const q = req.query || {};
      const r = await eleven.searchSharedVoices({
        page: Number.parseInt(q.page, 10) || 0,
        search: q.search || undefined,
        category: q.category || undefined,
        gender: q.gender || undefined,
        age: q.age || undefined,
        accent: q.accent || undefined,
        language: q.language || undefined,
        useCase: q.use_case || undefined,
        descriptive: q.descriptive || undefined,
        featured: q.featured === 'true',
      });
      res.json({
        voices: (r?.voices || []).map(libraryVoiceView),
        has_more: Boolean(r?.has_more),
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  router.get('/collection', async (req, res, next) => {
    try {
      const voices = await listCollectionVoices(req.projectId);
      res.json({ voices: voices.map(collectionVoiceView) });
    } catch (e) {
      next(e);
    }
  });

  router.post('/collection', async (req, res, next) => {
    try {
      const b = req.body || {};
      if (!String(b.voice_id || '').trim()) {
        res.status(400).json({ error: 'voice_id required' });
        return;
      }
      const doc = await addVoiceToCollection(req.projectId, {
        voice_id: b.voice_id,
        public_owner_id: b.public_owner_id,
        name: b.name,
        description: b.description,
        preview_url: b.preview_url,
        labels: b.labels,
        category: b.category,
        source: 'library',
      });
      res.json({ voice: collectionVoiceView(doc) });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/collection/:voiceId', async (req, res, next) => {
    try {
      const removed = await removeVoiceFromCollection(req.projectId, req.params.voiceId);
      if (!removed) {
        res.status(404).json({ error: 'voice not in collection' });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.post('/enhance', async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) {
      res.status(400).json({ error: 'text required' });
      return;
    }
    try {
      res.json({ text: await enhanceWithAudioTags(text) });
    } catch (e) {
      sendError(res, e);
    }
  });

  router.post('/tts', requireConfigured, async (req, res) => {
    try {
      const text = String(req.body?.text || '').trim();
      if (!text) throw Object.assign(new Error('text required'), { status: 400 });
      if (text.length > MAX_TTS_CHARS) {
        throw Object.assign(new Error(`text too long (max ${MAX_TTS_CHARS} characters)`), { status: 400 });
      }
      const modelId = TTS_MODELS.has(req.body?.model_id) ? req.body.model_id : 'eleven_v3';
      const voiceDoc = await requireCollectionVoice(req.projectId, req.body?.voice_id);
      await ensureVoiceUsable(req.projectId, voiceDoc);
      const { buffer, contentType } = await eleven.textToSpeech({
        voiceId: voiceDoc.voice_id, text, modelId,
      });
      const output = await persistAudioOutput(req.projectId, {
        buffer, contentType, tool: 'tts', prompt: text,
      });
      logger.info(`eleven tts ok voice=${voiceDoc.voice_id} chars=${text.length}`);
      res.json({ outputs: [output] });
    } catch (e) {
      sendError(res, e);
    }
  });

  router.post('/voice-changer', requireConfigured, async (req, res) => {
    try {
      const voiceDoc = await requireCollectionVoice(req.projectId, req.body?.voice_id);
      const ref = await loadAudioRef(req.projectId, req.body?.ref);
      await ensureVoiceUsable(req.projectId, voiceDoc);
      const { buffer, contentType } = await eleven.speechToSpeech({
        voiceId: voiceDoc.voice_id, buffer: ref.buffer, contentType: ref.contentType,
      });
      const output = await persistAudioOutput(req.projectId, {
        buffer, contentType, tool: 'voice-changer',
      });
      res.json({ outputs: [output] });
    } catch (e) {
      sendError(res, e);
    }
  });

  router.post('/isolate', requireConfigured, async (req, res) => {
    try {
      const ref = await loadAudioRef(req.projectId, req.body?.ref);
      const { buffer, contentType } = await eleven.isolateAudio({
        buffer: ref.buffer, contentType: ref.contentType,
      });
      const output = await persistAudioOutput(req.projectId, {
        buffer, contentType, tool: 'isolate',
      });
      res.json({ outputs: [output] });
    } catch (e) {
      sendError(res, e);
    }
  });

  router.post('/stt', requireConfigured, async (req, res) => {
    try {
      const ref = await loadAudioRef(req.projectId, req.body?.ref);
      const r = await eleven.speechToText({ buffer: ref.buffer, contentType: ref.contentType });
      const transcript = String(r?.text ?? r?.transcript ?? '').trim();
      const file = await uploadAttachmentBuffer(req.projectId, {
        buffer: Buffer.from(transcript, 'utf8'),
        filename: `eleven-transcript-${Date.now()}.txt`,
        contentType: 'text/plain',
        ownerType: 'playground',
        generatedBy: 'elevenlabs/stt',
      });
      res.json({
        transcript,
        language: r?.language_code || r?.language || null,
        outputs: [{ kind: 'text', file_id: file._id.toString() }],
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  router.post('/clone', requireConfigured, async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim();
      const refs = Array.isArray(req.body?.refs) ? req.body.refs : [];
      if (!name) throw Object.assign(new Error('name required'), { status: 400 });
      if (!refs.length) {
        throw Object.assign(new Error('at least one audio sample required'), { status: 400 });
      }
      const samples = [];
      for (const ref of refs) samples.push(await loadAudioRef(req.projectId, ref));
      const created = await eleven.createIvcVoice({
        name,
        description: String(req.body?.description || '').trim() || null,
        removeNoise: Boolean(req.body?.remove_noise),
        samples,
      });
      const doc = await addVoiceToCollection(req.projectId, {
        voice_id: created.voice_id,
        name,
        description: String(req.body?.description || '').trim() || null,
        source: 'clone',
        added_to_account: true,
      });
      res.json({ voice: collectionVoiceView(doc) });
    } catch (e) {
      sendError(res, e);
    }
  });

  router.post('/design', requireConfigured, async (req, res) => {
    try {
      const voiceDescription = String(req.body?.voice_description || '').trim();
      if (voiceDescription.length < 20) {
        throw Object.assign(
          new Error('voice_description must be at least 20 characters'), { status: 400 },
        );
      }
      const previewText = String(req.body?.preview_text || '').trim() || null;
      const r = await eleven.designVoice({ voiceDescription, previewText });
      res.json({
        previews: (r?.previews || []).map((p) => ({
          generated_voice_id: p.generated_voice_id,
          audio_data_url: `data:${p.media_type || 'audio/mpeg'};base64,${p.audio_base_64}`,
          duration_secs: p.duration_secs ?? null,
        })),
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  router.post('/design/save', requireConfigured, async (req, res) => {
    try {
      const voiceName = String(req.body?.voice_name || '').trim();
      const voiceDescription = String(req.body?.voice_description || '').trim();
      const generatedVoiceId = String(req.body?.generated_voice_id || '').trim();
      if (!voiceName || !voiceDescription || !generatedVoiceId) {
        throw Object.assign(
          new Error('voice_name, voice_description, and generated_voice_id required'),
          { status: 400 },
        );
      }
      const created = await eleven.createVoiceFromPreview({ voiceName, voiceDescription, generatedVoiceId });
      const doc = await addVoiceToCollection(req.projectId, {
        voice_id: created.voice_id,
        name: voiceName,
        description: voiceDescription,
        source: 'design',
        added_to_account: true,
      });
      res.json({ voice: collectionVoiceView(doc) });
    } catch (e) {
      sendError(res, e);
    }
  });

  return router;
}
