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
import { apiDelete, apiGet, apiPatchJson, apiPostJson } from '../api.js';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { DialogItem } from '../widgets/DialogItem.jsx';
import { ConfirmDialog } from '../widgets/Modal.jsx';
import { DialogEditDialog } from '../widgets/DialogEditDialog.jsx';

export function DialogBeat({ session }) {
  const { order } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState(null);
  const [generationStatus, setGenerationStatus] = useState(null);
  const pollRef = useRef(null);
  const justAddedRef = useRef(false);
  const [confirmGenerate, setConfirmGenerate] = useState(false);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteAllError, setDeleteAllError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const [characters, setCharacters] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [r, toc] = await Promise.all([
          apiGet(`/dialogs?beat_id=${encodeURIComponent(order)}`),
          apiGet('/toc'),
        ]);
        if (!cancelled) {
          setData(r);
          setCharacters(toc.characters || []);
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
    if (data?.dialogs) {
      setLocalOrder(data.dialogs.map((d) => d._id?.toString?.() || String(d._id)));
    }
  }, [data]);

  const dialogsById = useMemo(() => {
    const map = new Map();
    for (const d of data?.dialogs || []) {
      map.set(d._id?.toString?.() || String(d._id), d);
    }
    return map;
  }, [data]);

  const sortedItems = useMemo(() => {
    if (!localOrder) return [];
    return localOrder.map((id) => dialogsById.get(id)).filter(Boolean);
  }, [localOrder, dialogsById]);

  async function handleDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = localOrder.indexOf(active.id);
    const newIndex = localOrder.indexOf(over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(localOrder, oldIndex, newIndex);
    setLocalOrder(next);
    try {
      await apiPostJson('/dialogs/reorder', {
        beat_id: data.beat._id,
        ordered_ids: next,
      });
      onRefresh();
    } catch (e) {
      setError(`Reorder failed: ${e.message}`);
      setLocalOrder(localOrder);
    }
  }

  async function addDialog() {
    try {
      const r = await apiPostJson('/dialogs', { beat_id: data.beat._id });
      const newId = r?.dialog?._id
        ? (r.dialog._id.toString?.() || String(r.dialog._id))
        : null;
      if (newId) setExpandedId(newId);
      justAddedRef.current = true;
      onRefresh();
    } catch (e) {
      setError(e.message);
    }
  }

  async function deleteDialog(id) {
    if (!confirm('Delete this dialog item?')) return;
    try {
      await apiDelete(`/dialog/${id}`);
      const sid = id?.toString?.() || String(id);
      setExpandedId((cur) => (cur === sid ? null : cur));
      onRefresh();
    } catch (e) {
      setError(e.message);
    }
  }

  // Persist a character pick from the autocomplete. Errors propagate so
  // <CharacterSelect> can surface "no such character" inline; on success the
  // gateway's broadcast triggers an automatic refetch via onPing.
  async function setDialogCharacter(id, characterName) {
    await apiPatchJson(`/dialog/${id}`, { character: characterName });
  }

  async function pollJob(jobId) {
    try {
      const r = await apiGet(`/dialogs/generate/${jobId}`);
      setGenerationStatus(r.job);
      if (r.job?.status === 'done' || r.job?.status === 'error') {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setGenerating(false);
        if (r.job.status === 'error') {
          setGenerationError(r.job.error || 'Generation failed.');
        }
        onRefresh();
      } else {
        onRefresh();
      }
    } catch (e) {
      // Ignore transient errors; polling keeps trying.
    }
  }

  async function generate() {
    if (!data?.beat) return;
    setGenerating(true);
    setGenerationError(null);
    setGenerationStatus({ status: 'queued', extracted: 0, created: 0 });
    try {
      const r = await apiPostJson('/dialogs/generate', {
        beat_id: data.beat._id,
      });
      const jobId = r.job_id;
      pollRef.current = setInterval(() => pollJob(jobId), 2000);
      pollJob(jobId);
    } catch (e) {
      setGenerating(false);
      setGenerationError(e.message);
    }
  }

  function onGenerateClick() {
    if (sortedItems.length > 0) {
      setConfirmGenerate(true);
    } else {
      generate();
    }
  }

  async function deleteAll() {
    setDeleteAllError(null);
    try {
      await apiPostJson('/dialogs/clear', { beat_id: data.beat._id });
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
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: 'smooth',
      });
    });
  }, [sortedItems.length]);

  const room = data?.beat?._id ? `dialogs:${data.beat._id}` : null;

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
        <p style={{ color: 'var(--fg-muted)' }}>Loading dialog for beat #{order}…</p>
      </div>
    );
  }

  const beatTitle = (data.beat?.name || '').trim() || 'Untitled';

  return (
    <main className="app">
      <p>
        <a href="#" onClick={(e) => { e.preventDefault(); navigate('/dialog'); }}>
          ← Back to all dialog
        </a>
        {' · '}
        <a href="#" onClick={(e) => { e.preventDefault(); navigate(`/beat/${data.beat.order}`); }}>
          Open beat #{data.beat.order}
        </a>
      </p>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
        <h1 style={{ marginTop: 0 }}>
          Dialog · Beat #{data.beat.order}: {beatTitle}
        </h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            className="primary"
            onClick={onGenerateClick}
            disabled={generating}
            title={
              sortedItems.length
                ? 'Replace existing dialog with a freshly extracted set'
                : "Auto-extract every spoken line from the beat body"
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
          <button onClick={addDialog} disabled={generating}>+ Add dialog</button>
          <button
            className="danger"
            onClick={() => setConfirmDeleteAll(true)}
            disabled={generating || sortedItems.length === 0}
            title="Delete every dialog item for this beat"
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
        <div
          style={{
            background: 'var(--accent-bg, rgba(255,255,255,0.04))',
            padding: '8px 12px',
            borderRadius: 4,
            marginBottom: 12,
          }}
        >
          {generationStatus.status === 'extracting' && 'Extracting dialog…'}
          {(generationStatus.status === 'queued' || !generationStatus.status) &&
            'Queued…'}
          {generationStatus.status === 'done' &&
            `Created ${generationStatus.created || 0} dialog ${(generationStatus.created || 0) === 1 ? 'line' : 'lines'}.`}
        </div>
      )}

      {room && (
        <CollabSurface room={room} session={session} onPing={onRefresh}>
          {sortedItems.length === 0 ? (
            <p style={{ color: 'var(--fg-muted)' }}>
              No dialog yet. Click <strong>Generate</strong> to auto-extract
              spoken lines from the beat body, or <strong>+ Add dialog</strong>{' '}
              for a blank entry.
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
                <div className="dialog-list">
                  {sortedItems.map((d) => {
                    const sid = d._id?.toString?.() || String(d._id);
                    return (
                      <DialogItem
                        key={sid}
                        dialog={d}
                        characters={characters}
                        onDelete={() => deleteDialog(d._id)}
                        onCharacterChange={setDialogCharacter}
                        onAudioChange={onRefresh}
                        isExpanded={expandedId === sid}
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

      <ConfirmDialog
        open={confirmGenerate}
        title="Replace existing dialog?"
        message={
          `This beat has ${sortedItems.length} dialog ${sortedItems.length === 1 ? 'item' : 'items'}. ` +
          `They will be deleted and replaced when generation produces new lines. ` +
          `If extraction returns no lines, your current items are preserved.`
        }
        confirmLabel="Generate"
        onConfirm={() => { setConfirmGenerate(false); generate(); }}
        onCancel={() => setConfirmGenerate(false)}
      />

      <ConfirmDialog
        open={confirmDeleteAll}
        title="Delete all dialog?"
        message={
          `This deletes all ${sortedItems.length} dialog ${sortedItems.length === 1 ? 'item' : 'items'} for this beat. ` +
          `This cannot be undone.`
        }
        confirmLabel="Delete all"
        danger
        onConfirm={() => { setConfirmDeleteAll(false); deleteAll(); }}
        onCancel={() => setConfirmDeleteAll(false)}
      />

      <DialogEditDialog
        open={editOpen}
        items={sortedItems}
        beatId={data?.beat?._id}
        onClose={() => setEditOpen(false)}
        onApplied={() => { setEditOpen(false); onRefresh(); }}
      />
    </main>
  );
}
