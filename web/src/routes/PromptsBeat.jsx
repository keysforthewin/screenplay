import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { apiDelete, apiGet, apiPostJson, apiSseUrl } from '../api.js';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { CutItem } from '../widgets/CutItem.jsx';
import { SceneCard } from '../widgets/SceneCard.jsx';
import { ConfirmDialog, Modal } from '../widgets/Modal.jsx';
import { BeatTabs } from '../widgets/BeatTabs.jsx';
import { BeatPager } from '../widgets/BeatPager.jsx';
import { BeatVideoPanel } from '../widgets/BeatVideoPanel.jsx';
import { RenderCutsDialog } from '../widgets/RenderCutsDialog.jsx';
import { RenderStartFramesDialog } from '../widgets/RenderStartFramesDialog.jsx';
import { CutRenderProgress, cutRenderPhaseText } from '../widgets/CutRenderProgress.jsx';
import { CutPlanProgress } from '../widgets/CutPlanProgress.jsx';
import { SceneBiblePanel } from '../widgets/SceneBiblePanel.jsx';
import { ComfyCutJobsProvider, comfyQueueSummary, useComfyCutJobStore } from '../widgets/comfyCutJobs.jsx';

const TERMINAL = new Set(['done', 'partial', 'error']);
const RENDER_TERMINAL = new Set(['done', 'partial', 'error']);

function readError(e) {
  let msg = e?.message || 'Request failed.';
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.error) msg = parsed.error;
  } catch {}
  return msg;
}

// A per-cut DnD list inside one scene.
function SceneCuts({ scene, beatId, dialogs, disabled, onRefresh, onDeleteCut, onRegenerateCut }) {
  const sceneId = scene._id?.toString?.() || String(scene._id);
  const ids = (scene.cuts || []).map((c) => c._id?.toString?.() || String(c._id));
  const [local, setLocal] = useState(ids);
  useEffect(() => setLocal(ids), [ids.join(',')]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const byId = new Map((scene.cuts || []).map((c) => [c._id?.toString?.() || String(c._id), c]));
  async function onDragEnd(ev) {
    const { active, over } = ev;
    if (!over || active.id === over.id) return;
    const from = local.indexOf(active.id);
    const to = local.indexOf(over.id);
    if (from < 0 || to < 0) return;
    const next = arrayMove(local, from, to);
    setLocal(next);
    try {
      await apiPostJson('/cuts/reorder', { scene_id: sceneId, ordered_ids: next });
      onRefresh?.();
    } catch {
      setLocal(ids);
    }
  }
  if (!local.length) return <p className="scene-no-cuts">No cuts in this scene yet.</p>;
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={local} strategy={verticalListSortingStrategy}>
        <div className="dialog-list video-prompt-list">
          {local.map((id, i) => {
            const c = byId.get(id);
            if (!c) return null;
            return <CutItem key={id} cut={c} index={i} previousCut={i > 0 ? byId.get(local[i - 1]) || null : null} sceneIndex={scene.order} beatId={beatId} dialogs={dialogs} disabled={disabled} onRefresh={onRefresh} onDelete={() => onDeleteCut(id)} onRegenerate={() => onRegenerateCut?.(c, `${scene.order}.${i + 1}`)} />;
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}

// The Prompts tab for one beat: scenes → cuts → start/end frames → video.
export function PromptsBeat({ session }) {
  const { order } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [tocBeats, setTocBeats] = useState([]);
  const [job, setJob] = useState(null);
  const [sfJob, setSfJob] = useState(null);
  const [asmJob, setAsmJob] = useState(null);
  const [renderJob, setRenderJob] = useState(null);
  const [renderOpen, setRenderOpen] = useState(false);
  const [framesOpen, setFramesOpen] = useState(false);
  const renderEsRef = useRef(null);
  const [actionError, setActionError] = useState(null);
  const [direction, setDirection] = useState('');
  const [renderFrames, setRenderFrames] = useState(true);
  const [genOpen, setGenOpen] = useState(false);
  const [replanTarget, setReplanTarget] = useState(null);
  const [recutTarget, setRecutTarget] = useState(null);
  const [recutNote, setRecutNote] = useState('');
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [confirmDeleteFrames, setConfirmDeleteFrames] = useState(false);
  const pollRef = useRef(null);
  const planEsRef = useRef(null);
  const sfPollRef = useRef(null);
  const asmPollRef = useRef(null);

  const busy =
    Boolean(job && !TERMINAL.has(job.status)) ||
    Boolean(sfJob && !TERMINAL.has(sfJob.status)) ||
    Boolean(asmJob && !TERMINAL.has(asmJob.status)) ||
    Boolean(renderJob && !RENDER_TERMINAL.has(renderJob.status));

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
        }
      } catch (e) {
        if (!cancelled) setError(readError(e));
      }
    })();
    return () => { cancelled = true; };
  }, [order, refreshKey]);

  const onRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  // Per-cut ComfyUI renders (queued / rendering / just finished), shared by
  // every cut's button and dialog; reattached from /cuts/jobs below.
  const comfyJobs = useComfyCutJobStore(data?.beat?._id ? String(data.beat._id) : null, onRefresh);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (planEsRef.current) planEsRef.current.close();
    if (sfPollRef.current) clearInterval(sfPollRef.current);
    if (asmPollRef.current) clearInterval(asmPollRef.current);
    if (renderEsRef.current) renderEsRef.current.close();
  }, []);

  function watchRender(jobId) {
    if (renderEsRef.current) renderEsRef.current.close();
    const es = new EventSource(apiSseUrl(`/cuts/render/job/${jobId}/events`));
    renderEsRef.current = es;
    const parse = (ev) => { try { return JSON.parse(ev.data); } catch { return null; } };
    const apply = (snap) => { if (snap) setRenderJob(snap); };
    es.addEventListener('snapshot', (ev) => apply(parse(ev)));
    es.addEventListener('update', (ev) => apply(parse(ev)));
    const finish = (ev) => {
      const snap = parse(ev);
      apply(snap);
      es.close();
      renderEsRef.current = null;
      if (snap?.status === 'error') setActionError(snap.error || 'Render failed.');
      onRefresh();
    };
    es.addEventListener('done', finish);
    es.addEventListener('partial', finish);
    es.addEventListener('error', (ev) => {
      const snap = ev?.data ? parse(ev) : null;
      if (snap) finish(ev);
      else if (es.readyState === EventSource.CLOSED) {
        renderEsRef.current = null;
        setRenderJob((j) => (j ? { ...j, status: 'error', error: 'Connection lost — the render continues on the server; reload to see its result.' } : j));
      }
    });
  }

  // Render every cut (lip-sync where the covered lines are recorded), then
  // the beat MP4. Progress streams over SSE; per-cut jobs keep their own.
  async function startRender({ provider, models, skipRendered, confirmSpend }) {
    setRenderOpen(false);
    setActionError(null);
    setRenderJob({ status: 'queued', phase: 'queued', planned: 0, completed: 0, failed: 0, cuts: [] });
    try {
      const r = await apiPostJson('/cuts/render', {
        beat_id: data.beat._id,
        provider,
        models,
        skip_rendered: skipRendered,
        confirm_spend: Boolean(confirmSpend),
      });
      if (!r?.job_id) throw new Error('Server did not return a job id.');
      watchRender(r.job_id);
    } catch (e) {
      setRenderJob(null);
      setActionError(readError(e));
    }
  }

  // Planner progress streams over SSE (steps, live model output, activity
  // log); the 1.5s poll is the fallback when the stream can't be opened.
  function pollPlan(jobId) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const r = await apiGet(`/video-scenes/generate/${jobId}`);
        setJob(r.job);
        if (TERMINAL.has(r.job?.status)) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          onRefresh();
        }
      } catch (e) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setActionError(readError(e));
      }
    }, 1500);
  }

  function watchPlan(jobId) {
    if (planEsRef.current) planEsRef.current.close();
    if (typeof EventSource === 'undefined') return pollPlan(jobId);
    const es = new EventSource(apiSseUrl(`/video-scenes/generate/${jobId}/events`));
    planEsRef.current = es;
    const onSnap = (ev) => {
      try {
        const snap = JSON.parse(ev.data);
        setJob(snap);
        if (TERMINAL.has(snap.status)) {
          es.close();
          planEsRef.current = null;
          onRefresh();
        }
      } catch {}
    };
    es.addEventListener('snapshot', onSnap);
    es.addEventListener('update', onSnap);
    es.addEventListener('done', onSnap);
    es.addEventListener('partial', onSnap);
    es.addEventListener('error', onSnap);
    es.onerror = () => {
      // Stream failed (proxy, auth, network): fall back to polling so the
      // panel still finishes; a stream that already delivered the terminal
      // snapshot closes itself above.
      if (planEsRef.current !== es) return;
      es.close();
      planEsRef.current = null;
      pollPlan(jobId);
    };
  }

  async function generate() {
    setGenOpen(false);
    setActionError(null);
    setJob({ status: 'queued', phase: 'queued' });
    try {
      const r = await apiPostJson('/video-scenes/generate', {
        beat_id: data.beat._id,
        direction,
        render_start_frames: renderFrames,
      });
      watchPlan(r.job_id);
    } catch (e) {
      setJob(null);
      setActionError(readError(e));
    }
  }

  async function replan(scene) {
    setReplanTarget(null);
    setActionError(null);
    setJob({ status: 'queued', phase: 'queued' });
    try {
      const r = await apiPostJson(`/video-scene/${scene._id}/replan`, { direction, render_start_frames: renderFrames });
      watchPlan(r.job_id);
    } catch (e) {
      setJob(null);
      setActionError(readError(e));
    }
  }

  async function regenerateCut() {
    const target = recutTarget;
    setRecutTarget(null);
    if (!target) return;
    setActionError(null);
    setJob({ status: 'queued', phase: 'queued' });
    try {
      const r = await apiPostJson(`/cut/${target.id}/replan`, { note: recutNote, render_start_frames: renderFrames });
      watchPlan(r.job_id);
    } catch (e) {
      setJob(null);
      setActionError(readError(e));
    }
  }

  function watchStartFrames(jobId) {
    if (sfPollRef.current) clearInterval(sfPollRef.current);
    sfPollRef.current = setInterval(async () => {
      try {
        const s = await apiGet(`/cuts/start-frames/job/${jobId}`);
        setSfJob(s.job);
        if (TERMINAL.has(s.job?.status)) {
          clearInterval(sfPollRef.current);
          sfPollRef.current = null;
        }
        onRefresh();
      } catch (e) {
        clearInterval(sfPollRef.current);
        sfPollRef.current = null;
        setActionError(readError(e));
      }
    }, 2000);
  }

  // Called by RenderStartFramesDialog once the user has picked a model and
  // pressed Render — the toolbar button itself only opens that dialog.
  async function renderAllFrames(options) {
    setActionError(null);
    setFramesOpen(false);
    setSfJob({ status: 'queued' });
    try {
      const r = await apiPostJson('/cuts/start-frames/generate', { beat_id: data.beat._id, ...options });
      watchStartFrames(r.job_id);
    } catch (e) {
      setSfJob(null);
      setActionError(readError(e));
    }
  }

  async function cancelFrames() {
    if (!sfJob?.job_id) return;
    try {
      const r = await apiPostJson(`/cuts/start-frames/job/${sfJob.job_id}/cancel`, {});
      setSfJob(r.job);
    } catch (e) {
      setActionError(readError(e));
    }
  }

  function watchAssemble(jobId) {
    if (asmPollRef.current) clearInterval(asmPollRef.current);
    asmPollRef.current = setInterval(async () => {
      try {
        const s = await apiGet(`/cuts/assemble/job/${jobId}`);
        setAsmJob(s.job);
        if (TERMINAL.has(s.job?.status)) {
          clearInterval(asmPollRef.current);
          asmPollRef.current = null;
          onRefresh();
        }
      } catch (e) {
        clearInterval(asmPollRef.current);
        asmPollRef.current = null;
        setAsmJob(null);
        setActionError(readError(e));
      }
    }, 2000);
  }

  // Join every cut clip of the beat into the Prompts-tab beat MP4.
  async function assembleBeat() {
    setActionError(null);
    setAsmJob({ status: 'queued' });
    try {
      const r = await apiPostJson('/video-scenes/assemble', { beat_id: data.beat._id });
      watchAssemble(r.job_id);
    } catch (e) {
      setAsmJob(null);
      setActionError(readError(e));
    }
  }

  // Jobs are background work on the server: leaving the page never stops
  // them. On (re)opening a beat, ask what is running — or just finished — and
  // reattach: the snapshot carries everything logged so far, and the live
  // watchers take it from there. Switching beats drops the old watchers first.
  const beatIdStr = data?.beat?._id ? String(data.beat._id) : null;
  useEffect(() => {
    if (!beatIdStr) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const r = await apiGet(`/cuts/jobs?beat_id=${encodeURIComponent(beatIdStr)}`);
        if (cancelled) return;
        if (r.plan) {
          setJob((cur) => cur || r.plan);
          if (!TERMINAL.has(r.plan.status) && !planEsRef.current && !pollRef.current) watchPlan(r.plan.job_id);
        }
        if (r.start_frames) {
          setSfJob((cur) => cur || r.start_frames);
          if (!TERMINAL.has(r.start_frames.status) && !sfPollRef.current) watchStartFrames(r.start_frames.job_id);
        }
        if (r.assemble) {
          setAsmJob((cur) => cur || r.assemble);
          if (!TERMINAL.has(r.assemble.status) && !asmPollRef.current) watchAssemble(r.assemble.job_id);
        }
        comfyJobs.hydrate(r.comfy_videos);
        if (r.render) {
          setRenderJob((cur) => cur || r.render);
          if (!RENDER_TERMINAL.has(r.render.status) && !renderEsRef.current) watchRender(r.render.job_id);
        }
      } catch {
        // Reattach is best-effort; the page works without it.
      }
    })();
    return () => {
      cancelled = true;
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      if (planEsRef.current) { planEsRef.current.close(); planEsRef.current = null; }
      if (sfPollRef.current) { clearInterval(sfPollRef.current); sfPollRef.current = null; }
      if (asmPollRef.current) { clearInterval(asmPollRef.current); asmPollRef.current = null; }
      if (renderEsRef.current) { renderEsRef.current.close(); renderEsRef.current = null; }
      setJob(null);
      setSfJob(null);
      setAsmJob(null);
      setRenderJob(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beatIdStr]);

  async function deleteCut(id) {
    if (!confirm('Delete this cut (and its start/end frames and video)?')) return;
    try {
      await apiDelete(`/cut/${id}`);
      onRefresh();
    } catch (e) {
      setActionError(readError(e));
    }
  }

  async function moveScene(index, dir) {
    const ids = data.scenes.map((s) => s._id?.toString?.() || String(s._id));
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    const next = arrayMove(ids, index, j);
    try {
      await apiPostJson('/video-scenes/reorder', { beat_id: data.beat._id, ordered_ids: next });
      onRefresh();
    } catch (e) {
      setActionError(readError(e));
    }
  }

  async function deleteFrames() {
    setConfirmDeleteFrames(false);
    try {
      await apiDelete(`/cuts/start-frames?beat_id=${encodeURIComponent(String(data.beat._id))}`);
      onRefresh();
    } catch (e) {
      setActionError(readError(e));
    }
  }

  async function deleteAll() {
    setConfirmDeleteAll(false);
    try {
      await apiPostJson('/video-scenes/clear', { beat_id: data.beat._id });
      onRefresh();
    } catch (e) {
      setActionError(readError(e));
    }
  }

  const room = data?.beat?._id ? `video_prompts:${data.beat._id}` : null;

  if (error) return <div className="app"><div className="error-banner">{error}</div></div>;
  if (!data) return <div className="app"><p style={{ color: 'var(--fg-muted)' }}>Loading scenes for beat #{order}…</p></div>;

  const beatTitle = (data.beat?.name || '').trim() || 'Untitled';
  const scenes = data.scenes || [];
  const unsorted = data.unsorted || [];
  const cutCount = scenes.reduce((n, s) => n + (s.cuts || []).length, 0) + unsorted.length;
  const allCuts = [...scenes.flatMap((s) => s.cuts || []), ...unsorted];
  const missingFrames = allCuts.filter((c) => !c.start_frame?.image_id).length
    + allCuts.filter((c) => !c.end_frame?.image_id).length;
  const framesDone = allCuts.filter((c) => c.start_frame?.image_id).length;
  const anyFrames = allCuts.some((c) => c.start_frame?.image_id || c.end_frame?.image_id);
  const renderedFrames = allCuts.length * 2 - missingFrames;
  const missingClips = allCuts.filter((c) => !c.video_file_id).length;
  const clipsDone = allCuts.length - missingClips;
  const hasContent = scenes.length > 0 || cutCount > 0;
  const comfyQueue = comfyQueueSummary(comfyJobs.jobs);
  return (
    <ComfyCutJobsProvider store={comfyJobs}>
    <main className="app">
      <p><a href="#" onClick={(e) => { e.preventDefault(); navigate('/prompts'); }}>← Back to all prompts</a></p>
      <BeatPager beats={tocBeats} currentId={data.beat?._id} basePath="/prompts" />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <h1 style={{ marginTop: 0 }}>Prompts · Beat #{data.beat.order}: {beatTitle}</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="primary" disabled={busy} onClick={() => setGenOpen(true)} title="Read the whole beat, break it into scenes, plan the cuts, compile the blocks, derive the still prompts">
            {busy && job ? 'Working…' : '✨ Auto generate'}
          </button>
          {/* The toolbar grows with the beat: each step appears once the one
              before it has produced something. Cuts are never added by hand. */}
          {cutCount > 0 ? (
            <button disabled={busy} onClick={() => setFramesOpen(true)} title="Choose a model, then render the cuts' start and end frames">
              🖼 Render frames…{missingFrames ? ` (${missingFrames})` : ''}
            </button>
          ) : null}
          {framesDone > 0 ? (
            <button className="primary" disabled={busy} onClick={() => setRenderOpen(true)}
              title="Render every cut to video (lip-synced where its dialogue is recorded), then join them into the beat MP4">
              🎬 Render beat…
            </button>
          ) : null}
          {clipsDone > 0 ? (
            <button disabled={busy || missingClips > 0} onClick={assembleBeat}
              title={missingClips ? `${missingClips} cut(s) have no video yet` : 'Join every cut clip into one beat MP4'}>
              🎞 Assemble beat
            </button>
          ) : null}
          {anyFrames ? (
            <button className="danger" disabled={busy} onClick={() => setConfirmDeleteFrames(true)} title="Delete every rendered start and end frame in this beat; the still prompts, references, cuts and videos stay">Delete frames</button>
          ) : null}
          {hasContent ? (
            <button className="danger" disabled={busy} onClick={() => setConfirmDeleteAll(true)} title="Delete every scene and cut (and their frames and videos) for this beat">Delete all</button>
          ) : null}
        </div>
      </div>

      <BeatTabs order={data.beat.order} active="prompts" />

      {actionError ? <div className="error-banner">{actionError}</div> : null}
      {comfyQueue.running || comfyQueue.queued ? (
        <div className="cut-job-panel is-running">
          ComfyUI: {comfyQueue.running ? `${comfyQueue.running} rendering` : ''}
          {comfyQueue.running && comfyQueue.queued ? ' · ' : ''}
          {comfyQueue.queued ? `${comfyQueue.queued} queued` : ''} in this beat — renders run one at a time; open a cut's ComfyUI button to see its progress.
        </div>
      ) : null}
      {job ? <CutPlanProgress job={job} /> : null}
      {sfJob ? (
        <div className={`cut-job-panel is-${sfJob.status}`}>
          {sfJob.kind === 'check' || sfJob.kind === 'repair'
            ? (TERMINAL.has(sfJob.status) ? 'Frame check finished.' : sfJob.kind === 'repair' ? 'Checking and repairing frames…' : 'Checking frames…')
            : TERMINAL.has(sfJob.status)
              ? `Frames: ${sfJob.rendered} rendered, ${sfJob.skipped} skipped, ${sfJob.failed} failed.`
              : `Rendering frames… ${sfJob.rendered ?? 0}/${sfJob.planned ?? '?'}`}
          {sfJob.checks && sfJob.checks.passed + sfJob.checks.failed + sfJob.checks.unchecked > 0
            ? ` Start ↔ end pairs: ${sfJob.checks.passed} match${sfJob.checks.repaired ? ` (${sfJob.checks.repaired} repaired)` : ''}${sfJob.checks.failed ? `, ${sfJob.checks.failed} still differ` : ''}${sfJob.checks.unchecked ? `, ${sfJob.checks.unchecked} not checked` : ''}.`
            : ''}
          {sfJob.checks?.blocked ? <strong className="is-blocking"> {sfJob.checks.blocked} blocked — the clip would visibly break.</strong> : null}
          {!TERMINAL.has(sfJob.status) && sfJob.job_id ? (
            <button type="button" style={{ marginLeft: 10, fontSize: 12, padding: '2px 8px' }} disabled={sfJob.cancel_requested} onClick={cancelFrames}
              title="Stops before the next cut; frames already rendering finish and are kept">
              {sfJob.cancel_requested ? 'Cancelling…' : 'Cancel'}
            </button>
          ) : null}
          {Array.isArray(sfJob.warnings) && sfJob.warnings.length ? (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{sfJob.warnings.map((w, i) => <li key={i} className={String(w).startsWith('BLOCKING') ? 'is-blocking' : ''}>{w}</li>)}</ul>
          ) : null}
        </div>
      ) : null}

      {asmJob ? (
        <div className={`cut-job-panel is-${asmJob.status}`}>
          {asmJob.status === 'done'
            ? 'Beat video assembled.'
            : asmJob.status === 'error'
              ? `Assembly failed: ${asmJob.error || 'unknown error'}`
              : `Assembling the beat video… ${asmJob.phase && asmJob.phase !== 'queued' && asmJob.phase !== 'assembling' ? asmJob.phase : ''}`}
        </div>
      ) : null}
      {renderJob ? (
        <div className={`cut-job-panel is-${renderJob.status}`}>
          <div>{cutRenderPhaseText(renderJob)}</div>
          {renderJob.progress?.message && !RENDER_TERMINAL.has(renderJob.status) ? (
            <div style={{ color: 'var(--fg-muted)', fontSize: 12, marginTop: 4 }}>{renderJob.progress.message}</div>
          ) : null}
          <CutRenderProgress job={renderJob} />
          {RENDER_TERMINAL.has(renderJob.status) ? (
            <div style={{ marginTop: 6 }}><button type="button" onClick={() => setRenderJob(null)}>Dismiss</button></div>
          ) : null}
        </div>
      ) : null}
      <BeatVideoPanel entity={data.beat} prefix="prompts_video" title="Beat video" clipNoun="cut" deletePath={`/video-scenes/video?beat_id=${data.beat._id}`} onRefresh={onRefresh} />

      {data.beat?._id ? <SceneBiblePanel beatId={String(data.beat._id)} session={session} /> : null}

      {room ? (
        <CollabSurface room={room} session={session} onPing={onRefresh}>
          {scenes.length === 0 && unsorted.length === 0 ? (
            <p style={{ color: 'var(--fg-muted)' }}>
              No scenes yet. Click <strong>Auto generate</strong>: the planner reads the whole beat, breaks it into scenes with a director's read and floor plan, builds each scene's shot table, compiles one block per cut with a lock line, and derives still prompts for every cut's start frame and end frame.
            </p>
          ) : null}
          {scenes.map((s, i) => (
            <SceneCard key={String(s._id)} scene={s} index={i} count={scenes.length} beatId={data.beat._id} disabled={busy} onRefresh={onRefresh}
              onReplan={(scene) => setReplanTarget(scene)} onMove={(dir) => moveScene(i, dir)}>
              <SceneCuts scene={s} beatId={data.beat._id} dialogs={data.dialogs || []} disabled={busy} onRefresh={onRefresh} onDeleteCut={deleteCut} onRegenerateCut={(c, label) => { setRecutNote(''); setRecutTarget({ id: String(c._id), title: c.title, label }); }} />
            </SceneCard>
          ))}
          {unsorted.length ? (
            <section className="scene-card scene-card-unsorted">
              <div className="scene-card-header"><span className="scene-card-index">Unsorted</span><span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>rows written before scenes existed, or added without a scene</span></div>
              <div className="dialog-list video-prompt-list">
                {unsorted.map((c, i) => (
                  <CutItem key={String(c._id)} cut={c} index={i} beatId={data.beat._id} dialogs={data.dialogs || []} disabled={busy} onRefresh={onRefresh} onDelete={() => deleteCut(String(c._id))} />
                ))}
              </div>
            </section>
          ) : null}
        </CollabSurface>
      ) : null}

      <Modal open={genOpen} title={cutCount ? 'Replace scenes and cuts?' : 'Auto generate'} onClose={() => setGenOpen(false)}>
        {cutCount ? (
          <p>This beat has {scenes.length} scene{scenes.length === 1 ? '' : 's'} and {cutCount} cut{cutCount === 1 ? '' : 's'}. They (and their start/end frames and videos) are deleted and replaced once the planner finishes. If it returns nothing, everything is kept.</p>
        ) : (
          <p>The planner reads the whole beat and its director's notes, breaks it into scenes, builds each shot table, compiles the blocks and derives the still prompts.</p>
        )}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
          <span className="field-label">Direction (optional)</span>
          <textarea rows={3} value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="e.g. Keep it to two scenes. Lean on the diner set artwork. Dusk, rain on the windows." />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <input type="checkbox" checked={renderFrames} onChange={(e) => setRenderFrames(e.target.checked)} />
          Also render every cut's start and end frames (uses the project's image model default)
        </label>
        <div className="video-prompt-actions" style={{ marginTop: 14 }}>
          <button className="primary" onClick={generate}>Generate</button>
          <button onClick={() => setGenOpen(false)}>Cancel</button>
        </div>
      </Modal>

      <ConfirmDialog open={Boolean(replanTarget)} title={`Replan scene ${replanTarget ? (data.scenes.findIndex((s) => s._id === replanTarget._id) + 1) : ''}?`}
        message={`The cuts of "${replanTarget?.title || ''}" (with their start/end frames and videos) are replaced by a fresh shot table, blocks and still prompts. Other scenes are kept.${renderFrames ? ' Start and end frames are rendered afterwards.' : ''}`}
        confirmLabel="Replan" onConfirm={() => replan(replanTarget)} onCancel={() => setReplanTarget(null)} />

      <Modal open={Boolean(recutTarget)} title={`Regenerate cut ${recutTarget?.label || ''}?`} onClose={() => setRecutTarget(null)}>
        <p>"{recutTarget?.title || ''}" is planned again from scratch: its shot table row, video prompt, start and end still prompts. Its frames and video are deleted. The rest of the scene is kept, and the cut keeps its place and its dialogue lines.</p>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
          <span className="field-label">What is wrong with it (optional, but it helps)</span>
          <textarea rows={4} value={recutNote} onChange={(e) => setRecutNote(e.target.value)} placeholder="e.g. They should be hurrying TOWARD the theater doors, seen from behind, the kid a step ahead. Never his face from the front." />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <input type="checkbox" checked={renderFrames} onChange={(e) => setRenderFrames(e.target.checked)} />
          Also render its start and end frames (uses the project's image model default)
        </label>
        <div className="video-prompt-actions" style={{ marginTop: 14 }}>
          <button className="primary" onClick={regenerateCut}>Regenerate</button>
          <button onClick={() => setRecutTarget(null)}>Cancel</button>
        </div>
      </Modal>

      <RenderStartFramesDialog
        open={framesOpen}
        onClose={() => setFramesOpen(false)}
        onStart={renderAllFrames}
        cuts={[
          ...scenes.flatMap((sc, si) => (sc.cuts || []).map((c, ci) => ({ _id: String(c._id), label: `${si + 1}.${ci + 1}`, title: c.title, start_frame: c.start_frame, end_frame: c.end_frame }))),
          ...unsorted.map((c, i) => ({ _id: String(c._id), label: `#${i + 1}`, title: c.title, start_frame: c.start_frame, end_frame: c.end_frame })),
        ]}
      />

      <RenderCutsDialog open={renderOpen} onClose={() => setRenderOpen(false)} beatId={data.beat?._id ? String(data.beat._id) : null} onSubmit={startRender} />

      <ConfirmDialog open={confirmDeleteFrames} title="Delete frames?" message={`This deletes ${renderedFrames} rendered start/end frame image(s) in this beat, including their undo copies. Still prompts, references, cuts and videos are kept. This cannot be undone.`}
        confirmLabel="Delete frames" danger onConfirm={deleteFrames} onCancel={() => setConfirmDeleteFrames(false)} />

      <ConfirmDialog open={confirmDeleteAll} title="Delete all scenes and cuts?" message={`This deletes ${scenes.length} scene(s) and ${cutCount} cut(s) for this beat, including start/end frames and generated videos. This cannot be undone.`}
        confirmLabel="Delete all" danger onConfirm={deleteAll} onCancel={() => setConfirmDeleteAll(false)} />

      <BeatPager beats={tocBeats} currentId={data.beat?._id} basePath="/prompts" />
    </main>
    </ComfyCutJobsProvider>
  );
}
