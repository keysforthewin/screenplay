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
import { BulkGenerateImagesDialog } from '../widgets/BulkGenerateImagesDialog.jsx';
import { BeatTabs } from '../widgets/BeatTabs.jsx';
import { formatRuntime } from '../shotTypes.js';
import { BeatPager } from '../widgets/BeatPager.jsx';
import { SceneBiblePanel } from '../widgets/SceneBiblePanel.jsx';
import { GenerationProgress } from '../widgets/GenerationProgress.jsx';

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
  // Bulk start-frame image generation ("Generate all images") — separate job +
  // poll from the plan-generation flow above. Both are mutually exclusive via
  // the per-beat lock; the UI also disables one while the other runs.
  const [imageGenDialogOpen, setImageGenDialogOpen] = useState(false);
  const [imageGenerating, setImageGenerating] = useState(false);
  const [imageJobStatus, setImageJobStatus] = useState(null);
  const [imageGenError, setImageGenError] = useState(null);
  const imagePollRef = useRef(null);
  const [confirmDeleteImages, setConfirmDeleteImages] = useState(false);
  const [deleteImagesError, setDeleteImagesError] = useState(null);
  // "Assign reference images": bulk reassign of every frame's references.
  const [reassigning, setReassigning] = useState(false);
  const [reassignJobStatus, setReassignJobStatus] = useState(null);
  const [reassignError, setReassignError] = useState(null);
  const [confirmReassign, setConfirmReassign] = useState(false);
  const reassignPollRef = useRef(null);
  // Only one storyboard item can be expanded at a time. Collapsed by default
  // so the heavy media (videos, frames, audio, prompt CollabField) doesn't
  // mount until the user opens that item.
  const [expandedId, setExpandedId] = useState(null);

  // beatCharacters is fetched once per beat and passed to the generation
  // dialog so the user can pick which sheet to use for each character. The
  // override mapping itself lives inside the dialog now.
  const [beatCharacters, setBeatCharacters] = useState([]);
  // tocCharacters is the full project roster, used by the per-item character
  // tag input. /api/toc returns plain_name for case-insensitive matching.
  const [tocCharacters, setTocCharacters] = useState([]);
  const [tocBeats, setTocBeats] = useState([]);
  const [showProgressLog, setShowProgressLog] = useState(true);
  const progressLogRef = useRef(null);
  // 1s tick while a generation is running so "Xs ago" labels update smoothly
  // between the slower 2s polls.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (!generating && !imageGenerating) return undefined;
    const t = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [generating, imageGenerating]);

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiGet(`/toc`);
        if (!cancelled) {
          setTocCharacters(r.characters || []);
          setTocBeats(r.beats || []);
        }
      } catch {
        if (!cancelled) {
          setTocCharacters([]);
          setTocBeats([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

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

  // Each shot's start frame is frames[0]. "Missing" = it exists but has no image.
  const startFrameStats = useMemo(() => {
    let missing = 0;
    let withImage = 0;
    for (const sb of sortedItems) {
      const f0 = sb.frames?.[0];
      if (!f0) continue;
      if (f0.image_id) withImage += 1;
      else missing += 1;
    }
    return { missing, withImage };
  }, [sortedItems]);

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
    if (!confirm('Delete this storyboard element?')) return;
    try {
      await apiDelete(`/storyboard/${id}`);
      const idStr = id?.toString?.() || String(id);
      setExpandedId((cur) => (cur === idStr ? null : cur));
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

  async function generate({ count, direction }) {
    if (!data?.beat) return;
    setGenerating(true);
    setGenerationError(null);
    setGenerationStatus({ status: 'queued', completed: 0, planned: 0, failed: 0 });
    try {
      const body = { beat_id: data.beat._id };
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

  async function pollImageJob(jobId) {
    try {
      const r = await apiGet(`/storyboards/generate-images/${jobId}`);
      setImageJobStatus(r.job);
      if (['done', 'partial', 'error'].includes(r.job?.status)) {
        clearInterval(imagePollRef.current);
        imagePollRef.current = null;
        setImageGenerating(false);
        if (r.job.status === 'error') {
          setImageGenError(r.job.error || 'Image generation failed.');
        }
        onRefresh();
      } else {
        onRefresh();
      }
    } catch (e) {
      // Ignore transient errors; polling keeps trying.
    }
  }

  async function generateAllImages({ imageModel, autoReferences = true }) {
    if (!data?.beat) return;
    setImageGenError(null);
    setImageGenerating(true);
    setShowProgressLog(true);
    setImageJobStatus({ status: 'queued', completed: 0, planned: 0, failed: 0 });
    try {
      const r = await apiPostJson('/storyboards/generate-images', {
        beat_id: data.beat._id,
        image_model: imageModel,
        auto_references: autoReferences,
      });
      const jobId = r.job_id;
      imagePollRef.current = setInterval(() => pollImageJob(jobId), 2000);
      pollImageJob(jobId);
    } catch (e) {
      setImageGenerating(false);
      setImageGenError(e.message);
    }
  }

  function onGenDialogImagesSubmit(settings) {
    setImageGenDialogOpen(false);
    generateAllImages(settings);
  }

  async function deleteAllImages() {
    setDeleteImagesError(null);
    try {
      await apiPostJson('/storyboards/clear-images', { beat_id: data.beat._id });
      onRefresh();
    } catch (e) {
      setDeleteImagesError(e.message);
    }
  }

  async function pollReassignJob(jobId) {
    try {
      const r = await apiGet(`/storyboards/reassign-references/${jobId}`);
      setReassignJobStatus(r.job);
      if (['done', 'partial', 'error'].includes(r.job?.status)) {
        clearInterval(reassignPollRef.current);
        reassignPollRef.current = null;
        setReassigning(false);
        if (r.job.status === 'error') {
          setReassignError(r.job.error || 'Reference reassignment failed.');
        }
        onRefresh();
      } else {
        onRefresh();
      }
    } catch (e) {
      // transient poll error — keep polling (the job runs server-side).
    }
  }

  async function reassignReferences() {
    if (!data?.beat) return;
    setReassignError(null);
    setReassigning(true);
    setShowProgressLog(true);
    setReassignJobStatus({ status: 'queued', completed: 0, planned: 0, failed: 0 });
    try {
      const r = await apiPostJson('/storyboards/reassign-references', { beat_id: data.beat._id });
      const jobId = r.job_id;
      reassignPollRef.current = setInterval(() => pollReassignJob(jobId), 2000);
      pollReassignJob(jobId);
    } catch (e) {
      setReassigning(false);
      setReassignError(e.message);
    }
  }

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (imagePollRef.current) clearInterval(imagePollRef.current);
      if (reassignPollRef.current) clearInterval(reassignPollRef.current);
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
      </p>

      <BeatPager beats={tocBeats} currentId={data?.beat?._id} basePath="/storyboard" />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
        <h1 style={{ marginTop: 0 }}>
          Storyboard · Beat #{data.beat.order}: {beatTitle}
        </h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            className="primary"
            onClick={onGenerateClick}
            disabled={generating || imageGenerating}
            title={
              sortedItems.length
                ? 'Replace existing storyboards with a freshly generated set'
                : 'Auto-generate storyboards from the beat body and characters'
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
            disabled={generating || imageGenerating || sortedItems.length === 0}
            title="Delete every storyboard for this beat"
          >
            Delete all
          </button>
          <button
            onClick={() => setImageGenDialogOpen(true)}
            disabled={generating || imageGenerating || sortedItems.length === 0}
            title="Render the start-frame image for every shot that's missing one"
          >
            {imageGenerating ? 'Generating images…' : 'Generate all images'}
          </button>
          <button
            className="danger"
            onClick={() => setConfirmDeleteImages(true)}
            disabled={generating || imageGenerating || sortedItems.length === 0}
            title="Remove every generated frame image in this beat (keeps prompts & references)"
          >
            Delete all images
          </button>
          <button
            onClick={() => setConfirmReassign(true)}
            disabled={generating || imageGenerating || reassigning || sortedItems.length === 0}
            title="Remove all reference images on every frame and reassign from the current artwork set"
          >
            {reassigning ? 'Assigning references…' : 'Assign reference images'}
          </button>
        </div>
      </div>

      <BeatTabs order={data.beat.order} active="storyboard" />

      {generationError && (
        <div className="error-banner">Generation error: {generationError}</div>
      )}
      {deleteAllError && (
        <div className="error-banner">Delete failed: {deleteAllError}</div>
      )}
      {generating && generationStatus && (
        <GenerationProgress
          job={generationStatus}
          showLog={showProgressLog}
          onToggleLog={() => setShowProgressLog((s) => !s)}
          logRef={progressLogRef}
        />
      )}
      {imageGenError && (
        <div className="error-banner">Image generation error: {imageGenError}</div>
      )}
      {deleteImagesError && (
        <div className="error-banner">Delete images failed: {deleteImagesError}</div>
      )}
      {reassignError && (
        <div className="error-banner">Reassign failed: {reassignError}</div>
      )}
      {reassigning && reassignJobStatus && (
        <GenerationProgress
          job={reassignJobStatus}
          noun="frame"
          showLog={showProgressLog}
          onToggleLog={() => setShowProgressLog((s) => !s)}
          logRef={progressLogRef}
        />
      )}
      {imageGenerating && imageJobStatus && (
        <GenerationProgress
          job={imageJobStatus}
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

      {data?.beat?._id && (
        <SceneBiblePanel
          beatId={String(data.beat._id)}
          session={session}
          shotCount={sortedItems.length}
          onRefresh={onRefresh}
        />
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
                  {sortedItems.map((sb, index) => {
                    const sbId = sb._id?.toString?.() || String(sb._id);
                    return (
                      <StoryboardItem
                        key={sbId}
                        sb={sb}
                        index={index}
                        prevSb={sortedItems[index - 1] ?? null}
                        tocCharacters={tocCharacters}
                        onRefresh={onRefresh}
                        onDelete={() => deleteStoryboard(sb._id)}
                        isExpanded={expandedId === sbId}
                        onExpandToggle={(toggledId) =>
                          setExpandedId((cur) => (cur === toggledId ? null : toggledId))
                        }
                      />
                    );
                  })}
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

      <BulkGenerateImagesDialog
        open={imageGenDialogOpen}
        onClose={() => setImageGenDialogOpen(false)}
        onSubmit={onGenDialogImagesSubmit}
        missingCount={startFrameStats.missing}
        skipCount={startFrameStats.withImage}
      />

      <ConfirmDialog
        open={confirmDeleteImages}
        title="Delete all images?"
        message={
          'This removes every generated frame image in this beat. ' +
          'Prompts and reference images are kept. This cannot be undone.'
        }
        confirmLabel="Delete all images"
        danger
        onConfirm={() => { setConfirmDeleteImages(false); deleteAllImages(); }}
        onCancel={() => setConfirmDeleteImages(false)}
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

      <ConfirmDialog
        open={confirmReassign}
        title="Assign reference images?"
        message={
          'This removes all reference images on every frame in this beat — including frames that already have a generated image — and reassigns them from the current artwork set. Generated images are kept. This cannot be undone.'
        }
        confirmLabel="Assign reference images"
        danger
        onConfirm={() => { setConfirmReassign(false); reassignReferences(); }}
        onCancel={() => setConfirmReassign(false)}
      />

      <StoryboardEditDialog
        open={editOpen}
        items={sortedItems}
        beatId={data?.beat?._id}
        onClose={() => setEditOpen(false)}
        onApplied={() => { setEditOpen(false); onRefresh(); }}
      />

      <BeatPager beats={tocBeats} currentId={data?.beat?._id} basePath="/storyboard" />
    </main>
  );
}

// StoryboardGenerationProgress + formatElapsed now live in
// ../widgets/GenerationProgress.jsx (shared with the image-sheet progress panel).
