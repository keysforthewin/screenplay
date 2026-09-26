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
import { VideoPromptItem } from '../widgets/VideoPromptItem.jsx';
import { ConfirmDialog } from '../widgets/Modal.jsx';
import { BeatTabs } from '../widgets/BeatTabs.jsx';
import { BeatPager } from '../widgets/BeatPager.jsx';

// The Prompts tab for one beat: the standalone beat → video prompts → video
// path. "Auto generate" loads the whole beat into one LLM call and writes a
// handful of self-contained multi-shot prompts (≤ 30 s each) with reference
// images; each row then renders on its own through the video model picker.
export function PromptsBeat({ session }) {
  const { order } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [tocBeats, setTocBeats] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState(null);
  const [generationStatus, setGenerationStatus] = useState(null);
  const [direction, setDirection] = useState('');
  const [showDirection, setShowDirection] = useState(false);
  const pollRef = useRef(null);
  const justAddedRef = useRef(false);
  const [confirmGenerate, setConfirmGenerate] = useState(false);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [deleteAllError, setDeleteAllError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [r, toc] = await Promise.all([
          apiGet(`/video-prompts?beat_id=${encodeURIComponent(order)}`),
          apiGet('/toc'),
        ]);
        if (!cancelled) {
          setData(r);
          setTocBeats(toc.beats || []);
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [order, refreshKey]);

  const onRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const [localOrder, setLocalOrder] = useState(null);
  useEffect(() => {
    if (data?.prompts) {
      setLocalOrder(data.prompts.map((p) => p._id?.toString?.() || String(p._id)));
    }
  }, [data]);

  const promptsById = useMemo(() => {
    const map = new Map();
    for (const p of data?.prompts || []) {
      map.set(p._id?.toString?.() || String(p._id), p);
    }
    return map;
  }, [data]);

  const sortedItems = useMemo(() => {
    if (!localOrder) return [];
    return localOrder.map((id) => promptsById.get(id)).filter(Boolean);
  }, [localOrder, promptsById]);

  async function handleDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = localOrder.indexOf(active.id);
    const newIndex = localOrder.indexOf(over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(localOrder, oldIndex, newIndex);
    setLocalOrder(next);
    try {
      await apiPostJson('/video-prompts/reorder', {
        beat_id: data.beat._id,
        ordered_ids: next,
      });
      onRefresh();
    } catch (e) {
      setError(`Reorder failed: ${e.message}`);
      setLocalOrder(localOrder);
    }
  }

  async function addPrompt() {
    try {
      await apiPostJson('/video-prompts', { beat_id: data.beat._id });
      justAddedRef.current = true;
      onRefresh();
    } catch (e) {
      setError(e.message);
    }
  }

  async function deletePrompt(id) {
    if (!confirm('Delete this prompt (and its generated video, if any)?')) return;
    try {
      await apiDelete(`/video-prompt/${id}`);
      onRefresh();
    } catch (e) {
      setError(e.message);
    }
  }

  async function pollJob(jobId) {
    try {
      const r = await apiGet(`/video-prompts/generate/${jobId}`);
      setGenerationStatus(r.job);
      if (r.job?.status === 'done' || r.job?.status === 'error') {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setGenerating(false);
        if (r.job.status === 'error') {
          setGenerationError(r.job.error || 'Generation failed.');
        }
        onRefresh();
      }
    } catch {
      // transient — keep polling
    }
  }

  async function generate() {
    if (!data?.beat) return;
    setGenerating(true);
    setGenerationError(null);
    setGenerationStatus({ status: 'queued', generated: 0, created: 0, warnings: [] });
    try {
      const r = await apiPostJson('/video-prompts/generate', {
        beat_id: data.beat._id,
        direction: direction.trim() || undefined,
      });
      const jobId = r.job_id;
      pollRef.current = setInterval(() => pollJob(jobId), 2000);
      pollJob(jobId);
    } catch (e) {
      setGenerating(false);
      let msg = e.message || 'Generation failed.';
      try {
        const parsed = JSON.parse(msg);
        if (parsed?.error) msg = parsed.error;
      } catch {}
      setGenerationError(msg);
    }
  }

  function onGenerateClick() {
    if (sortedItems.length > 0) setConfirmGenerate(true);
    else generate();
  }

  async function deleteAll() {
    setDeleteAllError(null);
    try {
      await apiPostJson('/video-prompts/clear', { beat_id: data.beat._id });
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

  useEffect(() => {
    if (!justAddedRef.current) return;
    justAddedRef.current = false;
    requestAnimationFrame(() => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    });
  }, [sortedItems.length]);

  const room = data?.beat?._id ? `video_prompts:${data.beat._id}` : null;

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
        <p style={{ color: 'var(--fg-muted)' }}>Loading prompts for beat #{order}…</p>
      </div>
    );
  }

  const beatTitle = (data.beat?.name || '').trim() || 'Untitled';
  const status = generationStatus || {};
  const warnings = Array.isArray(status.warnings) ? status.warnings : [];

  return (
    <main className="app">
      <p>
        <a href="#" onClick={(e) => { e.preventDefault(); navigate('/prompts'); }}>
          ← Back to all prompts
        </a>
      </p>

      <BeatPager beats={tocBeats} currentId={data.beat?._id} basePath="/prompts" />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
        <h1 style={{ marginTop: 0 }}>
          Prompts · Beat #{data.beat.order}: {beatTitle}
        </h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            className="primary"
            onClick={onGenerateClick}
            disabled={generating}
            title={
              sortedItems.length
                ? 'Replace the existing prompts with a freshly generated set'
                : 'Load the whole beat and write video prompts with reference images'
            }
          >
            {generating ? 'Generating…' : '✨ Auto generate'}
          </button>
          <button
            onClick={() => setShowDirection((v) => !v)}
            disabled={generating}
            title="Optional guidance for the generator (tone, what to emphasise, how many prompts)"
          >
            {showDirection ? 'Hide direction' : 'Direction…'}
          </button>
          <button onClick={addPrompt} disabled={generating}>+ Add prompt</button>
          <button
            className="danger"
            onClick={() => setConfirmDeleteAll(true)}
            disabled={generating || sortedItems.length === 0}
            title="Delete every prompt (and generated video) for this beat"
          >
            Delete all
          </button>
        </div>
      </div>

      <BeatTabs order={data.beat.order} active="prompts" />

      {showDirection ? (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
          <span className="field-label">Direction for the generator (optional)</span>
          <textarea
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
            rows={3}
            disabled={generating}
            placeholder="e.g. Keep it to two prompts. Lean on the diner set artwork. Dusk, rain on the windows."
          />
        </label>
      ) : null}

      {generationError && (
        <div className="error-banner">Generation error: {generationError}</div>
      )}
      {deleteAllError && (
        <div className="error-banner">Delete failed: {deleteAllError}</div>
      )}
      {(generating || status.status === 'done') && generationStatus && (
        <div
          style={{
            background: 'var(--accent-bg, rgba(255,255,255,0.04))',
            padding: '8px 12px',
            borderRadius: 4,
            marginBottom: 12,
            fontSize: 13,
          }}
        >
          {(status.status === 'queued' || !status.status) && 'Queued…'}
          {status.status === 'generating' && 'Reading the beat and writing prompts…'}
          {status.status === 'writing' && `Saving prompts… (${status.created || 0} so far)`}
          {status.status === 'done' &&
            (status.created
              ? `Wrote ${status.created} prompt${status.created === 1 ? '' : 's'}.`
              : 'The generator returned no prompts; your existing prompts were kept.')}
          {warnings.length ? (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: '#ffb86b' }}>
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      {room && (
        <CollabSurface room={room} session={session} onPing={onRefresh}>
          {sortedItems.length === 0 ? (
            <p style={{ color: 'var(--fg-muted)' }}>
              No prompts yet. Click <strong>Auto generate</strong> to write multi-shot video
              prompts from the beat, or <strong>+ Add prompt</strong> for a blank one.
            </p>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={localOrder || []} strategy={verticalListSortingStrategy}>
                <div className="dialog-list video-prompt-list">
                  {sortedItems.map((p, i) => {
                    const sid = p._id?.toString?.() || String(p._id);
                    return (
                      <VideoPromptItem
                        key={sid}
                        prompt={p}
                        index={i}
                        beatId={data.beat._id}
                        disabled={generating}
                        onRefresh={onRefresh}
                        onDelete={() => deletePrompt(sid)}
                      />
                    );
                  })}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </CollabSurface>
      )}

      <ConfirmDialog
        open={confirmGenerate}
        title="Replace existing prompts?"
        message={
          `This beat has ${sortedItems.length} prompt${sortedItems.length === 1 ? '' : 's'}. ` +
          `They (and any generated videos) will be deleted and replaced when generation produces new prompts. ` +
          `If the generator returns nothing, your current prompts are kept.`
        }
        confirmLabel="Generate"
        onConfirm={() => { setConfirmGenerate(false); generate(); }}
        onCancel={() => setConfirmGenerate(false)}
      />

      <ConfirmDialog
        open={confirmDeleteAll}
        title="Delete all prompts?"
        message={
          `This deletes all ${sortedItems.length} prompt${sortedItems.length === 1 ? '' : 's'} for this beat, ` +
          `including any generated videos. This cannot be undone.`
        }
        confirmLabel="Delete all"
        danger
        onConfirm={() => { setConfirmDeleteAll(false); deleteAll(); }}
        onCancel={() => setConfirmDeleteAll(false)}
      />

      <BeatPager beats={tocBeats} currentId={data.beat?._id} basePath="/prompts" />
    </main>
  );
}
