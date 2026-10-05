import { useEffect, useState } from 'react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { apiDelete, apiPostJson } from '../api.js';
import { CollabField } from '../editor/CollabField.jsx';
import { ConfirmDialog } from './Modal.jsx';
import { CutItem } from './CutItem.jsx';

function readError(e) {
  let msg = e?.message || 'Request failed.';
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.error) msg = parsed.error;
  } catch {}
  return msg;
}

// One scene: its number, its name, and its cuts (numbered <scene>.<cut>,
// drag to reorder).
export function SceneCard({ scene, index, count, beatId, disabled, onRefresh, onMove }) {
  const sceneId = String(scene._id);
  const cuts = scene.cuts || [];
  const ids = cuts.map((c) => String(c._id));
  const [local, setLocal] = useState(ids);
  useEffect(() => setLocal(ids), [ids.join(',')]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirmScene, setConfirmScene] = useState(false);
  const [confirmCut, setConfirmCut] = useState(null); // { id, label }
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const byId = new Map(cuts.map((c) => [String(c._id), c]));
  const locked = busy || disabled;

  async function call(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(readError(e));
    } finally {
      setBusy(false);
      onRefresh?.();
    }
  }

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
    } catch (e) {
      setLocal(ids);
      setError(readError(e));
    }
  }

  return (
    <section className="scene-card">
      <div className="scene-card-header">
        <span className="scene-card-index">Scene {scene.order}</span>
        <div className="scene-card-title">
          <CollabField field={`scene:${sceneId}:title`} placeholder="Scene name…" />
        </div>
        <button type="button" disabled={locked || index === 0} title="Move this scene up" onClick={() => onMove(-1)}>▲</button>
        <button type="button" disabled={locked || index === count - 1} title="Move this scene down" onClick={() => onMove(1)}>▼</button>
        <button type="button" className="danger" disabled={locked} onClick={() => setConfirmScene(true)}>Delete scene</button>
      </div>
      {error ? <div className="error-banner small">{error}</div> : null}

      {local.length ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={local} strategy={verticalListSortingStrategy}>
            <div className="dialog-list video-prompt-list">
              {local.map((id, i) => {
                const c = byId.get(id);
                if (!c) return null;
                const label = `${scene.order}.${i + 1}`;
                return <CutItem key={id} cut={c} label={label} beatId={beatId} disabled={locked} onRefresh={onRefresh} onDelete={() => setConfirmCut({ id, label })} />;
              })}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <p className="scene-no-cuts">No cuts in this scene yet.</p>
      )}

      <div className="scene-card-footer">
        <button type="button" disabled={locked} onClick={() => call(() => apiPostJson('/cut', { scene_id: sceneId }))}>+ Add cut</button>
      </div>

      <ConfirmDialog
        open={confirmScene}
        title={`Delete scene ${scene.order}?`}
        message={cuts.length ? `This also deletes its ${cuts.length} cut${cuts.length === 1 ? '' : 's'}, with their generated frames and videos.` : 'This scene has no cuts.'}
        confirmLabel="Delete scene"
        danger
        onConfirm={() => { setConfirmScene(false); call(() => apiDelete(`/video-scene/${sceneId}`)); }}
        onCancel={() => setConfirmScene(false)}
      />
      <ConfirmDialog
        open={Boolean(confirmCut)}
        title={`Delete cut ${confirmCut?.label || ''}?`}
        message="Its prompts, generated frames and video are deleted."
        confirmLabel="Delete cut"
        danger
        onConfirm={() => { const target = confirmCut; setConfirmCut(null); call(() => apiDelete(`/cut/${target.id}`)); }}
        onCancel={() => setConfirmCut(null)}
      />
    </section>
  );
}
