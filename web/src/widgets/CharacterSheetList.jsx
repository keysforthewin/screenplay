import { useEffect, useRef, useState } from 'react';
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
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { apiDelete, apiPatchJson, apiPostJson, imageUrl } from '../api.js';

// Drag-reorderable list of character sheets. The first row is the
// "default" sheet that storyboard generation falls back to when the user
// doesn't pick a per-character override on the storyboard page.
//
// Each row shows: drag handle, thumbnail, name (read-only), Download +
// Delete buttons. Reorder writes to /character/:id/character-sheets/reorder
// optimistically with rollback on failure. Delete drops the GridFS bytes.
export function CharacterSheetList({ characterId, sheets, onRefresh }) {
  const [localOrder, setLocalOrder] = useState(() =>
    (sheets || []).map((s) => s._id),
  );
  const [error, setError] = useState(null);

  useEffect(() => {
    setLocalOrder((sheets || []).map((s) => s._id));
  }, [sheets]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const sheetsById = new Map((sheets || []).map((s) => [s._id, s]));
  const ordered = localOrder.map((id) => sheetsById.get(id)).filter(Boolean);

  async function handleDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = localOrder.indexOf(active.id);
    const newIndex = localOrder.indexOf(over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(localOrder, oldIndex, newIndex);
    const previous = localOrder;
    setLocalOrder(next);
    setError(null);
    try {
      await apiPostJson(`/character/${characterId}/character-sheets/reorder`, {
        ordered_ids: next,
      });
      onRefresh?.();
    } catch (e) {
      setError(`Reorder failed: ${e.message}`);
      setLocalOrder(previous);
    }
  }

  async function deleteSheet(sheetId) {
    if (!confirm('Delete this character sheet? The image will be permanently removed.')) return;
    setError(null);
    try {
      await apiDelete(`/character/${characterId}/character-sheet/${sheetId}`);
      onRefresh?.();
    } catch (e) {
      setError(`Delete failed: ${e.message}`);
    }
  }

  if (!ordered.length) {
    return (
      <div className="character-sheet-empty">
        No character sheets generated yet. Click <strong>Generate character sheet…</strong> to create one.
      </div>
    );
  }

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={localOrder} strategy={verticalListSortingStrategy}>
          <div className="gallery-list">
            {ordered.map((sheet, idx) => (
              <SheetRow
                key={sheet._id}
                sheet={sheet}
                isDefault={idx === 0}
                characterId={characterId}
                onDelete={() => deleteSheet(sheet._id)}
                onRefresh={onRefresh}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function SheetRow({ sheet, isDefault, characterId, onDelete, onRefresh }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sheet._id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className={`gallery-row${isDefault ? ' is-main' : ''}`}>
      <button
        type="button"
        className="storyboard-drag-handle"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        ⋮⋮
      </button>
      <div className="gallery-thumb">
        <a href={imageUrl(sheet._id)} target="_blank" rel="noreferrer">
          <img src={imageUrl(sheet._id)} alt={sheet.name || 'character sheet'} />
        </a>
      </div>
      <div className="gallery-meta">
        <SheetTitleInput
          characterId={characterId}
          sheetId={sheet._id}
          initialName={sheet.name || ''}
          onSaved={onRefresh}
        />
        {isDefault && (
          <div style={{ fontSize: 12, color: 'var(--accent)' }}>★ default for storyboard</div>
        )}
      </div>
      <div className="gallery-actions">
        <a
          href={imageUrl(sheet._id)}
          target="_blank"
          rel="noreferrer"
          download={sheet.name ? `${sheet.name}.png` : 'character-sheet.png'}
        >
          <button type="button">Download</button>
        </a>
        <button type="button" className="danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}

// Inline-editable title for one sheet. The on-blur PATCH writes through the
// gateway (which mirrors into the y-doc when Hocuspocus is running, so other
// connected SPAs see the change live). On Enter the input commits and blurs;
// on Escape the input reverts to the last-saved value and blurs.
function SheetTitleInput({ characterId, sheetId, initialName, onSaved }) {
  const [value, setValue] = useState(initialName);
  const [savedName, setSavedName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  // If the parent refetches and the name on disk has changed (e.g. another
  // user just renamed it), pick up the new value — but don't clobber a
  // half-typed local edit.
  useEffect(() => {
    if (!saving && document.activeElement !== inputRef.current) {
      setValue(initialName);
      setSavedName(initialName);
    }
  }, [initialName, saving]);

  async function commit() {
    const next = value.trim();
    if (next === savedName) return;
    setError(null);
    setSaving(true);
    try {
      await apiPatchJson(`/character/${characterId}/character-sheet/${sheetId}`, { name: next });
      setSavedName(next);
      onSaved?.();
    } catch (e) {
      setError(e.message || 'Rename failed');
      setValue(savedName); // revert on failure
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder="Untitled sheet"
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            inputRef.current?.blur();
          } else if (e.key === 'Escape') {
            setValue(savedName);
            inputRef.current?.blur();
          }
        }}
        style={{ fontWeight: 600, fontSize: 14, padding: '4px 6px' }}
      />
      {error && (
        <span style={{ fontSize: 12, color: 'var(--err, #f88)' }}>{error}</span>
      )}
    </div>
  );
}
