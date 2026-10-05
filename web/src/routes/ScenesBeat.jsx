import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiDownload, apiGet, apiPostJson } from '../api.js';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { SceneCard } from '../widgets/SceneCard.jsx';
import { BeatTabs } from '../widgets/BeatTabs.jsx';
import { BeatPager } from '../widgets/BeatPager.jsx';
import { ComfyCutJobsProvider, comfyQueueSummary, useComfyCutJobStore } from '../widgets/comfyCutJobs.jsx';
import { CutFrameJobsProvider, useCutFrameJobStore } from '../widgets/cutFrameJobs.jsx';
import { CutBatchBanner, CutVideoBatchProvider, useCutVideoBatchStore } from '../widgets/cutVideoBatch.jsx';
import { GenerateAllVideosDialog } from '../widgets/GenerateAllVideosDialog.jsx';

function readError(e) {
  let msg = e?.message || 'Request failed.';
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.error) msg = parsed.error;
  } catch {}
  return msg;
}

// The Scenes tab for one beat: the beat's scenes, each
// with its cuts (name, duration, video prompt, start and end frames, clip).
export function ScenesBeat({ session }) {
  const { order } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [tocBeats, setTocBeats] = useState([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [download, setDownload] = useState(null); // the step shown while ffmpeg joins the clips
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
        const [r, toc] = await Promise.all([
          apiGet(`/video-scenes?beat_id=${encodeURIComponent(order)}`),
          apiGet('/toc'),
        ]);
        if (!cancelled) {
          setData(r);
          setTocBeats(toc.beats || []);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(readError(e));
      }
    })();
    return () => { cancelled = true; };
  }, [order, refreshKey]);

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

  if (error) return <div className="app"><div className="error-banner">{error}</div></div>;
  if (!data) return <div className="app"><p style={{ color: 'var(--fg-muted)' }}>Loading scenes for beat #{order}…</p></div>;

  const beatTitle = (data.beat?.name || '').trim() || 'Untitled';
  const scenes = data.scenes || [];
  const comfyQueue = comfyQueueSummary(comfyJobs.jobs);
  const allCuts = scenes.flatMap((s) => s.cuts || []);
  const withVideo = allCuts.filter((c) => c.video_file_id).length;
  const renderable = allCuts.filter((c) => c.start_frame?.image_id && c.end_frame?.image_id).length;

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
        <main className="app">
          <p><a href="#" onClick={(e) => { e.preventDefault(); navigate('/scenes'); }}>← Back to all scenes</a></p>
          <BeatPager beats={tocBeats} currentId={data.beat?._id} basePath="/scenes" />
          <h1>Scenes · Beat #{data.beat.order} — {beatTitle}</h1>
          <BeatTabs order={data.beat.order} active="scenes" />

          <div className="scenes-toolbar">
            <button
              type="button"
              className="primary"
              disabled={videoBatch.running || !renderable}
              onClick={() => setBatchOpen(true)}
              title={videoBatch.running ? 'A batch is already running for this beat' : renderable ? 'Queue a video for every cut that has both frames' : 'No cut has both a start frame and an end frame yet'}
            >
              {videoBatch.running ? 'Generating all videos…' : 'Generate all videos…'}
            </button>
            <button
              type="button"
              disabled={Boolean(download) || !withVideo}
              onClick={downloadAll}
              title={withVideo ? `Join the ${withVideo} generated video${withVideo === 1 ? '' : 's'} into one MP4, in page order` : 'No cut has a video yet'}
            >
              {download ? <><span className="spinner cut-batch-spinner" aria-hidden="true" /> {download}</> : 'Download all videos'}
            </button>
          </div>

          {actionError ? <div className="error-banner">{actionError}</div> : null}
          <CutBatchBanner store={videoBatch} />
          {comfyQueue.running || comfyQueue.queued ? (
            <div className="cut-job-panel is-running">
              ComfyUI: {comfyQueue.running ? `${comfyQueue.running} rendering` : ''}
              {comfyQueue.running && comfyQueue.queued ? ' · ' : ''}
              {comfyQueue.queued ? `${comfyQueue.queued} queued` : ''} in this beat — videos render one at a time.
            </div>
          ) : null}

          <CollabSurface room={`video_prompts:${beatId}`} session={session} onPing={onRefresh}>
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
          <GenerateAllVideosDialog open={batchOpen} onClose={() => setBatchOpen(false)} beatId={beatId} scenes={scenes} onQueued={videoBatch.started} />
        </main>
       </CutVideoBatchProvider>
      </ComfyCutJobsProvider>
    </CutFrameJobsProvider>
  );
}
