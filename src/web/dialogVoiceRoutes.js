// ElevenLabs voices on characters and dialogue, mounted from entityRoutes.js:
//
//   PUT  /character/:id/eleven-voice   { voice_id | null } — the character's voice
//        (must be a voice of the ElevenLabs account; null clears)
//   PUT  /dialog/:id/eleven-voice      { voice_id | null } — one line's own voice;
//        it outranks the speaker's character voice, null goes back to it
//   GET  /dialogs/voices?beat_id=      { preview, job | null } — counts for the
//        confirm dialog + the beat's latest batch (what the page polls)
//   POST /dialogs/voices/generate-all  202 { job } — { beat_id, overwrite? }
//   POST /dialogs/voices/cancel        { job } — { beat_id }; stops before the lines still waiting
//
// The batch runner is dialogVoiceGenerate.js.

import * as eleven from '../eleven/client.js';
import { getCharacter } from '../mongo/characters.js';
import { getDialog } from '../mongo/dialogs.js';
import { getBeat } from '../mongo/plots.js';
import { getAccountVoices } from './elevenRoutes.js';
import {
  DialogVoiceError,
  cancelDialogVoiceJob,
  getDialogVoiceJobForBeat,
  previewDialogVoices,
  serializeDialogVoiceJob,
  startDialogVoiceJob,
} from './dialogVoiceGenerate.js';
import { setCharacterElevenVoiceViaGateway, setDialogElevenVoiceViaGateway } from './gateway.js';

const OID_HEX = /^[a-f0-9]{24}$/i;

// The account voice a request's `voice_id` names: `{ voice }` (null = clear),
// or `{ status, error }` when it cannot be accepted.
async function resolveRequestedVoice(voiceId) {
  if (voiceId === null || voiceId === undefined || voiceId === '') return { voice: null };
  if (!eleven.isConfigured()) {
    return { status: 503, error: 'ElevenLabs is not configured on the server (ELEVEN_LABS_KEY missing).' };
  }
  let voices;
  try {
    voices = await getAccountVoices();
  } catch (e) {
    const status = Number(e?.status);
    return {
      status: Number.isInteger(status) && status >= 400 && status < 600 ? status : 502,
      error: e?.message || 'ElevenLabs request failed',
    };
  }
  const voice = voices.find((v) => v.voice_id === String(voiceId)) || null;
  if (!voice) return { status: 400, error: 'voice is not in the ElevenLabs account' };
  return { voice };
}

export function registerDialogVoiceRoutes(router) {
  router.put('/dialog/:id/eleven-voice', async (req, res, next) => {
    try {
      const d = OID_HEX.test(req.params.id) ? await getDialog(req.projectId, req.params.id) : null;
      if (!d) return res.status(404).json({ error: 'dialog not found' });
      const { voice, status, error } = await resolveRequestedVoice(req.body?.voice_id);
      if (error) return res.status(status).json({ error });
      const dialog = await setDialogElevenVoiceViaGateway({
        projectId: req.projectId,
        dialogId: d._id.toString(),
        voice,
      });
      res.json({ dialog });
    } catch (e) {
      next(e);
    }
  });

  router.put('/character/:id/eleven-voice', async (req, res, next) => {
    try {
      const c = OID_HEX.test(req.params.id) ? await getCharacter(req.projectId, req.params.id) : null;
      if (!c) return res.status(404).json({ error: 'character not found' });
      const { voice, status, error } = await resolveRequestedVoice(req.body?.voice_id);
      if (error) return res.status(status).json({ error });
      const character = await setCharacterElevenVoiceViaGateway({
        projectId: req.projectId,
        character: c._id.toString(),
        voice,
      });
      res.json({ character });
    } catch (e) {
      next(e);
    }
  });

  router.get('/dialogs/voices', async (req, res, next) => {
    try {
      const beat = req.query.beat_id ? await getBeat(req.projectId, String(req.query.beat_id)) : null;
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      res.json({
        preview: await previewDialogVoices({ projectId: req.projectId, beatId: beat._id }),
        job: serializeDialogVoiceJob(getDialogVoiceJobForBeat(beat._id)),
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/dialogs/voices/generate-all', async (req, res, next) => {
    try {
      if (!req.body?.beat_id) return res.status(400).json({ error: 'beat_id required' });
      const job = await startDialogVoiceJob({
        projectId: req.projectId,
        beatId: String(req.body.beat_id),
        overwrite: req.body?.overwrite === true,
      });
      res.status(202).json({ job: serializeDialogVoiceJob(job) });
    } catch (e) {
      if (e instanceof DialogVoiceError) return res.status(e.status).json({ error: e.message, code: e.code });
      next(e);
    }
  });

  router.post('/dialogs/voices/cancel', async (req, res, next) => {
    try {
      const beat = req.body?.beat_id ? await getBeat(req.projectId, String(req.body.beat_id)) : null;
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const job = cancelDialogVoiceJob(beat._id);
      if (!job) return res.status(409).json({ error: 'no voice generation is running for this beat' });
      res.json({ job: serializeDialogVoiceJob(job) });
    } catch (e) {
      next(e);
    }
  });
}
