import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { apiDelete, apiGet, apiPostJson } from '../api.js';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { StoryboardItem } from '../widgets/StoryboardItem.jsx';
import { ConfirmDialog } from '../widgets/Modal.jsx';
import { StoryboardEditDialog } from '../widgets/StoryboardEditDialog.jsx';
import { StoryboardGenerateDialog } from '../widgets/StoryboardGenerateDialog.jsx';
import { formatRuntime } from '../shotTypes.js';

export function StoryboardBeat({ session }) {
  const { order } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState(null);
  const [generationStatus, setGenerationStatus] = useState(null);
  const pollRef = useRef(null);
  const [genDialogOpen, setGenDialogOpen] = useState(false);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteAllError, setDeleteAllError] = useState(null);

  // beatCharacters is fetched once per beat and passed to the generation
  // dialog so the user can pick which sheet to use for each character. The
  // override mapping itself lives inside the dialog now.
  const [beatCharacters, setBeatCharacters] = useState([]);
  const [showProgressLog, setShowProgressLog] = useState(true);
  const progressLogRef = useRef(null);
  // 1s tick while a generation is running so "Xs ago" labels update smoothly
  // between the slower 2s polls.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (!generating) return undefined;
    const t = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [generating]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Resolve the beat first, then list its storyboards. The /storyboards
        // endpoint accepts beat order or hex.
        const r = await apiGet(`/storyboards?beat_id=${encodeURIComponent(order)}`);
        if (!cancelled) setData(r);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [order, refreshKey]);

  // Load characters resolved for this beat, plus their sheet lists, so the
  // sheet picker rendered above the Generate button reflects the same
  // resolution path the renderer will take.
  useEffect(() => {
    if (!data?.beat?._id) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const r = await apiGet(`/beat/${data.beat._id}/characters`);
        if (!cancelled) setBeatCharacters(r.characters || []);
      } catch {
        if (!cancelled) setBeatCharacters([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data?.beat?._id, refreshKey]);

  const onRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Local copy of the order so DnD updates feel instant; the server confirms
  // order on the next refresh.
  const [localOrder, setLocalOrder] = useState(null);
  useEffect(() => {
    if (data?.storyboards) {
      setLocalOrder(data.storyboards.map((s) => s._id?.toString?.() || String(s._id)));
    }
  }, [data]);

  const sbsById = useMemo(() => {
    const map = new Map();
    for (const s of data?.storyboards || []) {
      map.set(s._id?.toString?.() || String(s._id), s);
    }
    return map;
  }, [data]);

  const sortedItems = useMemo(() => {
    if (!localOrder) return [];
    return localOrder.map((id) => sbsById.get(id)).filter(Boolean);
  }, [localOrder, sbsById]);

  const totalRuntime = useMemo(
    () => sortedItems.reduce((sum, s) => sum + (s.duration_seconds || 0), 0),
    [sortedItems],
  );

  async function handleDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = localOrder.indexOf(active.id);
    const newIndex = localOrder.indexOf(over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(localOrder, oldIndex, newIndex);
    setLocalOrder(next);
    try {
      await apiPostJson('/storyboards/reorder', {
        beat_id: data.beat._id,
        ordered_ids: next,
      });
      onRefresh();
    } catch (e) {
      setError(`Reorder failed: ${e.message}`);
      // Roll back on error.
      setLocalOrder(localOrder);
    }
  }

  async function addStoryboard() {
    try {
      await apiPostJson('/storyboards', { beat_id: data.beat._id });
      onRefresh();
    } catch (e) {
      setError(e.message);
    }
  }

  async function deleteStoryboard(id) {
    if (!confirm('Delete this storyboard?')) return;
    try {
      await apiDelete(`/storyboard/${id}`);
      onRefresh();
    } catch (e) {
      setError(e.message);
    }
  }

  async function pollJob(jobId) {
    try {
      const r = await apiGet(`/storyboards/generate/${jobId}`);
      setGenerationStatus(r.job);
      if (r.job?.status === 'done' || r.job?.status === 'partial' || r.job?.status === 'error') {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setGenerating(false);
        if (r.job.status === 'error') {
          setGenerationError(r.job.error || 'Generation failed.');
        }
        onRefresh();
      } else {
        // Still running — refresh the list so partial completions show up.
        onRefresh();
      }
    } catch (e) {
      // Ignore transient errors; polling keeps trying.
    }
  }

  async function generate({ sheetOverrides, imageModel, count, direction }) {
    if (!data?.beat) return;
    setGenerating(true);
    setGenerationError(null);
    setGenerationStatus({ status: 'queued', completed: 0, planned: 0, failed: 0 });
    try {
      const body = { beat_id: data.beat._id, image_model: imageModel };
      if (sheetOverrides && Object.keys(sheetOverrides).length) {
        body.character_sheet_overrides = sheetOverrides;
      }
      if (Number(count) > 0) body.count = Number(count);
      if (typeof direction === 'string' && direction.trim()) {
        body.direction = direction.trim();
      }
      const r = await apiPostJson('/storyboards/generate', body);
      const jobId = r.job_id;
      pollRef.current = setInterval(() => pollJob(jobId), 2000);
      // Trigger one immediate poll so status updates fast.
      pollJob(jobId);
    } catch (e) {
      setGenerating(false);
      setGenerationError(e.message);
    }
  }

  function onGenerateClick() {
    setGenDialogOpen(true);
  }

  function onGenDialogSubmit(settings) {
    setGenDialogOpen(false);
    generate(settings);
  }

  async function deleteAll() {
    setDeleteAllError(null);
    try {
      await apiPostJson('/storyboards/clear', { beat_id: data.beat._id });
      onRefresh();
    } catch (e) {
      setDeleteAllError(e.message);
    }
  }

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const room = data?.beat?._id ? `storyboards:${data.beat._id}` : null;

  if (error) {
    return (
      <div className="app">
        <div className="error-banner">{error}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="app">
        <p style={{ color: 'var(--fg-muted)' }}>Loading storyboard for beat #{order}…</p>
      </div>
    );
  }

  const beatTitle = (data.beat?.name || '').trim() || 'Untitled';

  return (
    <main className="app">
      <p>
        <a href="#" onClick={(e) => { e.preventDefault(); navigate('/storyboard'); }}>
          ← Back to all storyboards
        </a>
        {' · '}
        <a href="#" onClick={(e) => { e.preventDefault(); navigate(`/beat/${data.beat.order}`); }}>
          Open beat #{data.beat.order}
        </a>
      </p>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
        <h1 style={{ marginTop: 0 }}>
          Storyboard · Beat #{data.beat.order}: {beatTitle}
        </h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            className="primary"
            onClick={onGenerateClick}
            disabled={generating}
            title={
              (sortedItems.length
                ? 'Replace existing storyboards with a freshly generated set'
                : 'Auto-generate storyboards from the beat body and characters') +
              ' · Generation may take a couple of minutes — each frame produces 2 images.'
            }
          >
            {generating ? 'Generating…' : 'Generate'}
          </button>
          <button
            onClick={() => setEditOpen(true)}
            disabled={generating || sortedItems.length === 0}
            title="Open the LLM-driven edit dialog to add/move/delete/update items in batch"
          >
            Edit…
          </button>
          <button onClick={addStoryboard} disabled={generating}>+ Add storyboard</button>
          <button
            className="danger"
            onClick={() => setConfirmDeleteAll(true)}
            disabled={generating || sortedItems.length === 0}
            title="Delete every storyboard for this beat"
          >
            Delete all
          </button>
        </div>
      </div>

      {generationError && (
        <div className="error-banner">Generation error: {generationError}</div>
      )}
      {deleteAllError && (
        <div className="error-banner">Delete failed: {deleteAllError}</div>
      )}
      {generating && generationStatus && (
        <StoryboardGenerationProgress
          job={generationStatus}
          showLog={showProgressLog}
          onToggleLog={() => setShowProgressLog((s) => !s)}
          logRef={progressLogRef}
        />
      )}

      {sortedItems.length > 0 && (
        <div className="storyboard-runtime-tally">
          Total runtime: <strong>{formatRuntime(totalRuntime)}</strong>{' '}
          ({sortedItems.length} {sortedItems.length === 1 ? 'shot' : 'shots'})
        </div>
      )}

      {room && (
        <CollabSurface room={room} session={session} onPing={onRefresh}>
          {sortedItems.length === 0 ? (
            <p style={{ color: 'var(--fg-muted)' }}>
              No storyboards yet. Click <strong>Generate</strong> to auto-create
              from the beat body, or <strong>+ Add storyboard</strong> for a
              blank frame.
            </p>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={localOrder || []}
                strategy={verticalListSortingStrategy}
              >
                <div className="storyboard-list">
                  {sortedItems.map((sb, index) => (
                    <StoryboardItem
                      key={sb._id?.toString?.() || String(sb._id)}
                      sb={sb}
                      index={index}
                      prevSb={sortedItems[index - 1] ?? null}
                      onRefresh={onRefresh}
                      onDelete={() => deleteStoryboard(sb._id)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </CollabSurface>
      )}

      <StoryboardGenerateDialog
        open={genDialogOpen}
        onClose={() => setGenDialogOpen(false)}
        onSubmit={onGenDialogSubmit}
        beat={data?.beat || null}
        beatCharacters={beatCharacters}
        existingCount={sortedItems.length}
      />

      <ConfirmDialog
        open={confirmDeleteAll}
        title="Delete all storyboards?"
        message={
          `This deletes all ${sortedItems.length} storyboard ${sortedItems.length === 1 ? 'item' : 'items'} for this beat. ` +
          `This cannot be undone.`
        }
        confirmLabel="Delete all"
        danger
        onConfirm={() => { setConfirmDeleteAll(false); deleteAll(); }}
        onCancel={() => setConfirmDeleteAll(false)}
      />

      <StoryboardEditDialog
        open={editOpen}
        items={sortedItems}
        beatId={data?.beat?._id}
        onClose={() => setEditOpen(false)}
        onApplied={() => { setEditOpen(false); onRefresh(); }}
      />
    </main>
  );
}

function StoryboardGenerationProgress({ job, showLog, onToggleLog, logRef }) {
  const events = Array.isArray(job?.events) ? job.events : [];
  const progress = job?.progress || null;
  const phase = progress?.phase || job?.status || 'queued';
  const message =
    progress?.message ||
    (phase === 'planning'
      ? 'Planning frames…'
      : phase === 'rendering'
        ? `Rendering ${job?.completed || 0}/${job?.planned || 0} frames…`
        : phase === 'queued'
          ? 'Queued…'
          : 'Working…');
  const startedAt = progress?.started_at ? new Date(progress.started_at) : null;
  const jobStartedAt = job?.started_at ? new Date(job.started_at) : null;
  const stepElapsed = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000)) : null;
  const totalElapsed = jobStartedAt ? Math.max(0, Math.floor((Date.now() - jobStartedAt.getTime()) / 1000)) : null;

  // Auto-scroll the log to the bottom as new events stream in so the most
  // recent step stays visible without the user having to scroll manually.
  useEffect(() => {
    if (showLog && logRef?.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [events.length, showLog, logRef]);

  return (
    <div className="storyboard-progress">
      <div className="storyboard-progress-head">
        <span className={`storyboard-progress-phase phase-${phase}`}>{phase.toUpperCase()}</span>
        <span className="storyboard-progress-message">{message}</span>
      </div>
      <div className="storyboard-progress-meta">
        {typeof job?.planned === 'number' && job.planned > 0 && (
          <span>
            {job.completed || 0}/{job.planned} rendered
            {job.failed > 0 && (
              <span style={{ color: 'var(--err, #f88)' }}> · {job.failed} failed</span>
            )}
          </span>
        )}
        {stepElapsed != null && <span>step: {formatElapsed(stepElapsed)}</span>}
        {totalElapsed != null && <span>total: {formatElapsed(totalElapsed)}</span>}
        <button
          type="button"
          className="storyboard-progress-toggle"
          onClick={onToggleLog}
        >
          {showLog ? 'Hide activity log' : `Show activity log (${events.length})`}
        </button>
      </div>
      {showLog && events.length > 0 && (
        <div className="storyboard-progress-log" ref={logRef}>
          {events.map((ev, i) => {
            const ts = ev.ts ? new Date(ev.ts) : null;
            const offset = ts && jobStartedAt
              ? Math.max(0, Math.floor((ts.getTime() - jobStartedAt.getTime()) / 1000))
              : null;
            const failed = /failed|crashed/.test(ev.step || '');
            const done = /done|complete/.test(ev.step || '');
            return (
              <div
                key={i}
                className={`storyboard-progress-event ${failed ? 'is-failed' : done ? 'is-done' : ''}`}
              >
                <span className="storyboard-progress-event-time">
                  {offset != null ? `+${formatElapsed(offset)}` : ''}
                </span>
                <span className="storyboard-progress-event-msg">{ev.message}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatElapsed(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0s';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${s.toString().padStart(2, '0')}s`;
}
