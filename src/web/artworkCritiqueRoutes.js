// src/web/artworkCritiqueRoutes.js
// REST surface of the beat ARTWORK critique (the lower half of the Critique
// tab). Mounted on the main API router (after requireSession +
// requireProjectAccess) by entityRoutes.js:
//
//   GET    /beat/:id/artwork-critique                       the stored critique (null before a run)
//   POST   /beat/:id/artwork-critique                       run it (202 {job_id, beat_id}; 409 busy). Incremental: only
//                                                           artwork that changed since the last run is looked at again;
//                                                           {force: true} forgets the last run and re-checks everything
//                                                           {stage: 'coverage'}: start from nothing — requirements,
//                                                           description matching and proposals for what is missing; no
//                                                           image is looked at (the page empties and fills as it lands).
//                                                           {stage: 'quality'}: review the matched pieces again, in
//                                                           place (409 before a coverage check). Every manual run
//                                                           clears the last climb's status
//   POST   /beat/:id/artwork-critique/cancel                stop the manual run now (409 none running); what it
//                                                           had stored stays, status `cancelled`. The GET above returns
//                                                           `job` — the run still going — so a reopened page reattaches
//   GET    /beat/:id/artwork-critique/irrelevant            the artwork the critique set aside — flawed (reviewed and
//                                                           turned down), duplicate, or not relevant to this beat —
//                                                           with picture, description, why, and what still uses it
//   POST   /beat/:id/artwork-critique/irrelevant/delete     {artwork_ids} → {deleted, skipped}; only listed, unprotected
//                                                           pieces; irreversible; 409 busy
//   DELETE /beat/:id/artwork-critique                       clear the critique and the climb status (409 busy)
//          (pre-auth SSE twin: /beat/:id/artwork-critique/:jobId/events?session_id= in entityRoutes.js)
//   POST   /beat/:id/artwork-critique/climb                 edit the close / low-scoring artwork in place, render only
//                                                           what nothing on file is near, re-audit what changed — until
//                                                           the quality-weighted coverage reaches `target` % or stalls
//                                                           {target, model, direction?, stop_after?} → 202 {climb}
//                                                           (followed by polling the GET above, which returns `climb`)
//   POST   /beat/:id/artwork-critique/climb/cancel          stop after the step in flight
//   POST   /beat/:id/artwork-critique/generate              render the ticked proposals onto their sets / characters
//                                                           {proposal_ids, model, overrides?: {[pid]: {prompt?, reference_image_ids?}}}
//                                                           → 202 {job_id, planned}
//   GET    /beat/:id/artwork-critique/generate/:jobId       generation job snapshot (poll)
//   POST   /beat/:id/artwork-critique/proposals/:pid/dismiss
//   POST   /beat/:id/artwork-critique/proposals/:pid/restore
//   POST   /beat/:id/artwork-critique/artworks/:aid/fix     apply the audit's suggested edit (or `prompt`) as an
//                                                           in-line edit of that artwork on its host {prompt?, model?}
//                                                           → 202 {subject_id, host_type, artwork}; 409 busy / no image
//   GET    /beat/:id/artwork-critique/artworks/:aid         the audited entry with its fix state synced from the host (poll)
//   POST   /beat/:id/artwork-critique/artworks/:aid/fix/undo  one-step undo of a finished fix

import { getBeat } from '../mongo/plots.js';
import {
  startArtworkCritiqueJob,
  activeArtworkCritiqueJob,
  requestArtworkCritiqueCancel,
  serializeArtworkCritiqueJob,
  clearArtworkCritique,
  startArtworkGenerateJob,
  getArtworkGenerateJob,
  serializeArtworkGenerateJob,
  setProposalStatus,
  startArtworkFix,
  syncArtworkFix,
  syncArtworkFixes,
  undoArtworkFix,
} from './artworkCritique.js';

import { startArtworkClimb } from './artworkClimb.js';
import { listIrrelevantArtworks, deleteIrrelevantArtworks } from './artworkCritiqueIrrelevant.js';
import { getClimbView, requestClimbCancel } from './climbCore.js';

const HEX24 = /^[a-f0-9]{24}$/i;

function webDiscordUser(req) {
  const name = req?.session?.username;
  if (!name) return null;
  return { id: `web:${name}`, displayName: name };
}

export function registerArtworkCritiqueRoutes(router) {
  // Hex id or beat order; always verified against the project so an unknown
  // id is a 404, never a 200 with null.
  async function resolveBeatId(req) {
    const beat = await getBeat(req.projectId, String(req.params.id));
    return beat?._id?.toString() || null;
  }

  const fail = (res, next, e) => {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    return next(e);
  };

  router.get('/beat/:id/artwork-critique/irrelevant', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      res.json(await listIrrelevantArtworks({ projectId: req.projectId, beatId }));
    } catch (e) { fail(res, next, e); }
  });

  router.post('/beat/:id/artwork-critique/irrelevant/delete', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      res.json(await deleteIrrelevantArtworks({ projectId: req.projectId, beatId, artworkIds: req.body?.artwork_ids }));
    } catch (e) { fail(res, next, e); }
  });

  router.post('/beat/:id/artwork-critique/cancel', async (req, res, next) => {
    try {
      const job = await requestArtworkCritiqueCancel({ projectId: req.projectId, beatId: String(req.params.id) });
      res.json({ job: serializeArtworkCritiqueJob(job) });
    } catch (e) { fail(res, next, e); }
  });

  router.get('/beat/:id/artwork-critique', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const critique = await syncArtworkFixes({ projectId: req.projectId, beatId });
      res.json({
        artwork_critique: critique || null,
        climb: (await getClimbView(req.projectId, beatId, 'artwork')) || null,
        // The manual run still going for this beat: a reopened page follows it.
        job: serializeArtworkCritiqueJob(activeArtworkCritiqueJob(beatId)),
      });
    } catch (e) { next(e); }
  });

  router.post('/beat/:id/artwork-critique/climb', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const climb = await startArtworkClimb({ projectId: req.projectId, beatId, params: req.body || {}, discordUser: webDiscordUser(req) });
      res.status(202).json({ climb });
    } catch (e) { fail(res, next, e); }
  });

  router.post('/beat/:id/artwork-critique/climb/cancel', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      if (!requestClimbCancel('artwork', beatId)) return res.status(409).json({ error: 'No climb is running for this beat.' });
      res.json({ climb: await getClimbView(req.projectId, beatId, 'artwork') });
    } catch (e) { next(e); }
  });

  router.post('/beat/:id/artwork-critique/artworks/:aid/fix', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      if (!HEX24.test(String(req.params.aid))) return res.status(404).json({ error: 'artwork not found on this critique' });
      const body = req.body || {};
      const out = await startArtworkFix({
        projectId: req.projectId,
        beatId,
        artworkId: req.params.aid,
        prompt: body.prompt,
        model: body.model,
        discordUser: webDiscordUser(req),
        announceUsername: req?.session?.username || null,
      });
      res.status(202).json(out);
    } catch (e) { fail(res, next, e); }
  });

  router.get('/beat/:id/artwork-critique/artworks/:aid', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      if (!HEX24.test(String(req.params.aid))) return res.status(404).json({ error: 'artwork not found on this critique' });
      res.json(await syncArtworkFix({ projectId: req.projectId, beatId, artworkId: req.params.aid }));
    } catch (e) { fail(res, next, e); }
  });

  router.post('/beat/:id/artwork-critique/artworks/:aid/fix/undo', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      if (!HEX24.test(String(req.params.aid))) return res.status(404).json({ error: 'artwork not found on this critique' });
      res.json(await undoArtworkFix({ projectId: req.projectId, beatId, artworkId: req.params.aid }));
    } catch (e) { fail(res, next, e); }
  });

  router.post('/beat/:id/artwork-critique', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const stage = req.body?.stage;
      if (stage != null && !['coverage', 'quality', 'all'].includes(stage)) return res.status(400).json({ error: 'stage must be coverage, quality or all' });
      const jobId = await startArtworkCritiqueJob({ projectId: req.projectId, beatId, force: req.body?.force === true, stage: stage || 'all' });
      res.status(202).json({ job_id: jobId, beat_id: beatId });
    } catch (e) { fail(res, next, e); }
  });

  router.delete('/beat/:id/artwork-critique', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      await clearArtworkCritique({ projectId: req.projectId, beatId });
      res.json({ artwork_critique: null, climb: null });
    } catch (e) { fail(res, next, e); }
  });

  router.post('/beat/:id/artwork-critique/generate', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const body = req.body || {};
      const out = await startArtworkGenerateJob({
        projectId: req.projectId,
        beatId,
        proposalIds: body.proposal_ids,
        model: body.model,
        overrides: body.overrides && typeof body.overrides === 'object' ? body.overrides : {},
        discordUser: webDiscordUser(req),
      });
      res.status(202).json(out);
    } catch (e) { fail(res, next, e); }
  });

  router.get('/beat/:id/artwork-critique/generate/:jobId', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const job = getArtworkGenerateJob(req.params.jobId);
      if (!job || job.beat_id !== beatId || job.project_id !== req.projectId) return res.status(404).json({ error: 'job not found' });
      res.json({ job: serializeArtworkGenerateJob(job) });
    } catch (e) { next(e); }
  });

  for (const [action, status] of [['dismiss', 'dismissed'], ['restore', 'proposed']]) {
    router.post(`/beat/:id/artwork-critique/proposals/:pid/${action}`, async (req, res, next) => {
      try {
        const beatId = await resolveBeatId(req);
        if (!beatId) return res.status(404).json({ error: 'beat not found' });
        if (!HEX24.test(String(req.params.pid))) return res.status(404).json({ error: 'proposal not found' });
        const proposal = await setProposalStatus({ projectId: req.projectId, beatId, proposalId: req.params.pid, status });
        res.json({ proposal });
      } catch (e) { fail(res, next, e); }
    });
  }
}
