import { useCallback, useEffect, useRef, useState } from 'react';
import { apiDelete, apiDownload, apiGet, apiPostJson } from '../api.js';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { SceneCard } from './SceneCard.jsx';
import { ComfyCutJobsProvider, comfyQueueSummary, useComfyCutJobStore } from './comfyCutJobs.jsx';
import { CutFrameJobsProvider, useCutFrameJobStore } from './cutFrameJobs.jsx';
import { CutBatchBanner, CutVideoBatchProvider, useCutVideoBatchStore } from './cutVideoBatch.jsx';
import { ConfirmDialog, Modal } from './Modal.jsx';

function readError(e) {
  let msg = e?.message || 'Request failed.';
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.error) msg = parsed.error;
  } catch {}
  return msg;
}

// The Scenes panel of the beat page (routes/Beat.jsx): the beat's scenes, each
// with its cuts (name, duration, video prompt, start and end frames, clip).
// The page mounts it on the first visit to the tab and keeps it mounted,
// hidden, afterwards; `active` says whether it is the tab on screen.
export function ScenesPanel({ beat, session, active = true }) {
  const beatKey = String(beat._id);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [videoDefault, setVideoDefault] = useState(undefined); // the admin's default video renderer; undefined while loading
  const [queuing, setQueuing] = useState(false);
  const [askRender, setAskRender] = useState(false); // the "re-render every cut?" question
  const [download, setDownload] = useState(null); // the step shown while ffmpeg joins the clips
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  const mounted = useRef(true);
  // Set on every mount: StrictMode runs this cleanup once right after the
  // first mount, and a ref left false would make every async action bail.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiGet(`/video-scenes?beat_id=${encodeURIComponent(beatKey)}`);
        if (!cancelled) {
          setData(r);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(readError(e));
      }
    })();
    return () => { cancelled = true; };
  }, [beatKey, refreshKey]);

  // "Generate all videos" renders with the admin's default video renderer
  // (Admin → Video renderer) — set once, so the button asks for no model.
  useEffect(() => {
    let cancelled = false;
    apiGet('/video-default')
      .then((r) => { if (!cancelled) setVideoDefault(r?.default?.model_id ? r.default : null); })
      .catch(() => { if (!cancelled) setVideoDefault(null); });
    return () => { cancelled = true; };
  }, []);

  const onRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const beatId = data?.beat?._id ? String(data.beat._id) : null;
  // Renders are background jobs on the server: frame renders and queued /
  // running ComfyUI clips, shared by every cut on the page.
  const frameJobs = useCutFrameJobStore(beatId, onRefresh);
  const comfyJobs = useComfyCutJobStore(beatId, onRefresh);
  // "Generate all videos": a server-side batch over every cut of the beat.
  const videoBatch = useCutVideoBatchStore(beatId, onRefresh);

  // Opening a beat picks up whatever is still rendering for it.
  useEffect(() => {
    if (!beatId) return undefined;
    let cancelled = false;
    apiGet(`/cuts/jobs?beat_id=${encodeURIComponent(beatId)}`)
      .then((r) => {
        if (cancelled) return;
        frameJobs.hydrate(r.frames);
        comfyJobs.hydrate(r.comfy_videos);
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beatId]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <p style={{ color: 'var(--fg-muted)' }}>Loading scenes…</p>;

  const scenes = data.scenes || [];
  const comfyQueue = comfyQueueSummary(comfyJobs.jobs);
  const allCuts = scenes.flatMap((s) => s.cuts || []);
  const withVideo = allCuts.filter((c) => c.video_file_id).length;
  const renderable = allCuts.filter((c) => c.start_frame?.image_id && c.end_frame?.image_id).length;
  const rendererLabel = videoDefault ? videoDefault.label || videoDefault.model_id : null;

  // What the batch can render: every cut with both frames and a video prompt.
  const eligible = allCuts.filter((c) => c.start_frame?.image_id && c.end_frame?.image_id && String(c.prompt || '').trim());
  const missingVideo = eligible.filter((c) => !c.video_file_id).length;

  // Every eligible cut — or, when the user says not to re-render, only those
  // without a video — through the default video renderer.
  async function startBatch(skipExisting) {
    setAskRender(false);
    setQueuing(true);
    setActionError(null);
    try {
      const r = await apiPostJson('/cuts/videos/generate-all', {
        beat_id: beatId,
        skip_existing: skipExisting,
        ...(videoDefault.spends_credits ? { confirm_spend: true } : {}),
      });
      videoBatch.started(r?.batch || null);
    } catch (e) {
      if (mounted.current) setActionError(readError(e));
    } finally {
      if (mounted.current) setQueuing(false);
    }
  }

  const generateTitle = videoBatch.running
    ? 'A batch is already running for this beat'
    : !renderable
      ? 'No cut has both a start frame and an end frame yet'
      : videoDefault === null
        ? 'No default video renderer is set (Admin → Video renderer)'
        : `Render the cuts that have both frames with ${rendererLabel || 'the default video renderer'}`;

  // Join every cut's clip into one MP4 on the server (ffmpeg), then save it.
  async function downloadAll() {
    const without = allCuts.length - withVideo;
    if (without && !confirm(`${without} cut${without === 1 ? ' has' : 's have'} no video yet. Download the other ${withVideo} joined together?`)) return;
    setActionError(null);
    setDownload('Starting…');
    try {
      let { job } = await apiPostJson('/cuts/videos/download', { beat_id: beatId });
      while (job.status === 'running') {
        if (!mounted.current) return;
        setDownload(job.step || 'Joining…');
        await new Promise((r) => setTimeout(r, 1500));
        ({ job } = await apiGet(`/cuts/videos/download/${job.job_id}`));
      }
      if (job.status !== 'done') throw new Error(job.error || 'Joining the videos failed.');
      if (!mounted.current) return;
      setDownload('Downloading…');
      await apiDownload(`/cuts/videos/download/${job.job_id}/file`, job.filename || 'videos.mp4');
    } catch (e) {
      if (mounted.current) setActionError(readError(e));
    } finally {
      if (mounted.current) setDownload(null);
    }
  }

  async function addScene() {
    setAdding(true);
    setActionError(null);
    try {
      await apiPostJson('/video-scene', { beat_id: beatId });
    } catch (e) {
      setActionError(readError(e));
    } finally {
      setAdding(false);
      onRefresh();
    }
  }

  // "Delete all scenes": every scene of the beat with every cut, frame and clip.
  async function deleteAllScenes() {
    setConfirmDeleteAll(false);
    setDeletingAll(true);
    setActionError(null);
    try {
      await apiDelete(`/video-scenes?beat_id=${encodeURIComponent(beatId)}`);
    } catch (e) {
      setActionError(readError(e));
    } finally {
      if (mounted.current) setDeletingAll(false);
      onRefresh();
    }
  }

  async function moveScene(i, dir) {
    const ids = scenes.map((s) => String(s._id));
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setActionError(null);
    try {
      await apiPostJson('/video-scenes/reorder', { beat_id: beatId, ordered_ids: ids });
    } catch (e) {
      setActionError(readError(e));
    } finally {
      onRefresh();
    }
  }

  return (
    <CutFrameJobsProvider store={frameJobs}>
      <ComfyCutJobsProvider store={comfyJobs}>
       <CutVideoBatchProvider store={videoBatch}>
        <>
          <div className="scenes-toolbar">
            <button
              type="button"
              className="primary"
              disabled={queuing || videoBatch.running || !renderable || !videoDefault}
              onClick={() => setAskRender(true)}
              title={generateTitle}
            >
              {videoBatch.running ? 'Generating all videos…' : queuing ? 'Queuing…' : 'Generate all videos'}
            </button>
            <button
              type="button"
              disabled={Boolean(download) || !withVideo}
              onClick={downloadAll}
              title={withVideo ? `Join the ${withVideo} generated video${withVideo === 1 ? '' : 's'} into one MP4, in page order` : 'No cut has a video yet'}
            >
              {download ? <><span className="spinner cut-batch-spinner" aria-hidden="true" /> {download}</> : 'Download all videos'}
            </button>
            <button
              type="button"
              className="danger"
              disabled={deletingAll || videoBatch.running || scenes.length === 0}
              onClick={() => setConfirmDeleteAll(true)}
              title={videoBatch.running ? 'Stop the video batch first' : scenes.length ? 'Delete every scene of this beat, with every cut, frame and video' : 'This beat has no scenes'}
            >
              {deletingAll ? 'Deleting all scenes…' : 'Delete all scenes'}
            </button>
            {videoDefault !== undefined ? (
              <span className="scenes-toolbar-note">
                {videoDefault
                  ? <>Video renderer: {rendererLabel}{videoDefault.known === false ? ' (no longer in the ComfyUI registry)' : ''} · Admin → Video renderer</>
                  : 'No default video renderer is set — choose one on Admin → Video renderer.'}
              </span>
            ) : null}
          </div>

          <Modal
            open={askRender}
            title="Re-render every cut?"
            onClose={() => setAskRender(false)}
            footer={
              <>
                <button type="button" onClick={() => setAskRender(false)}>Cancel</button>
                <button type="button" disabled={!eligible.length} onClick={() => startBatch(false)}>
                  Re-render every cut ({eligible.length})
                </button>
                <button type="button" className="primary" disabled={!missingVideo} onClick={() => startBatch(true)}>
                  Only missing videos ({missingVideo})
                </button>
              </>
            }
          >
            <p style={{ margin: 0 }}>
              {eligible.length - missingVideo} of the {eligible.length} cut{eligible.length === 1 ? '' : 's'} ready to render already
              {eligible.length - missingVideo === 1 ? ' has' : ' have'} a video. <b>Re-render every cut</b> renders all {eligible.length} with {rendererLabel},
              replacing each video as its new one lands; <b>Only missing videos</b> renders the {missingVideo} without one.
            </p>
            {eligible.length < renderable ? (
              <p style={{ margin: '8px 0 0', color: 'var(--fg-muted)' }}>
                {renderable - eligible.length} cut{renderable - eligible.length === 1 ? ' has' : 's have'} no video prompt and {renderable - eligible.length === 1 ? 'is' : 'are'} skipped.
              </p>
            ) : null}
            {videoDefault?.spends_credits ? (
              <p style={{ margin: '8px 0 0', color: 'var(--fg-muted)' }}>
                Every render is billed ({videoDefault.provider === 'fal' ? 'fal.ai' : 'Comfy credits'}).
              </p>
            ) : null}
          </Modal>

          <ConfirmDialog
            open={confirmDeleteAll}
            title={`Delete all ${scenes.length} scene${scenes.length === 1 ? '' : 's'} of beat #${data.beat.order}?`}
            message={`Every scene is deleted with ${allCuts.length ? `its cuts (${allCuts.length} in all)` : 'its cuts'}, their prompts, generated frames and videos. This cannot be undone.`}
            confirmLabel="Delete all scenes"
            danger
            onConfirm={deleteAllScenes}
            onCancel={() => setConfirmDeleteAll(false)}
          />

          {actionError ? <div className="error-banner">{actionError}</div> : null}
          <CutBatchBanner store={videoBatch} />
          {comfyQueue.running || comfyQueue.queued ? (
            <div className="cut-job-panel is-running">
              ComfyUI: {comfyQueue.running ? `${comfyQueue.running} rendering` : ''}
              {comfyQueue.running && comfyQueue.queued ? ' · ' : ''}
              {comfyQueue.queued ? `${comfyQueue.queued} queued` : ''} in this beat — videos render one at a time.
            </div>
          ) : null}

          <CollabSurface room={`video_prompts:${beatId}`} session={session} active={active} onPing={onRefresh}>
            {scenes.length === 0 ? (
              <p style={{ color: 'var(--fg-muted)' }}>
                No scenes yet. Add a scene, then add cuts to it.
              </p>
            ) : null}
            {scenes.map((s, i) => (
              <SceneCard key={String(s._id)} scene={s} index={i} count={scenes.length} beatId={beatId} onRefresh={onRefresh} onMove={(dir) => moveScene(i, dir)} />
            ))}
            <div className="scene-add">
              <button type="button" className="primary" disabled={adding} onClick={addScene}>+ Add scene</button>
            </div>
          </CollabSurface>
        </>
       </CutVideoBatchProvider>
      </ComfyCutJobsProvider>
    </CutFrameJobsProvider>
  );
}
