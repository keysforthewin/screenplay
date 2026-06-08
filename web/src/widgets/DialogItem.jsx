import { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { apiPatchJson, apiPostJson } from '../api.js';
import { CollabField } from '../editor/CollabField.jsx';
import { CharacterSelect } from './CharacterSelect.jsx';
import { AudioSlot } from './AudioSlot.jsx';
import { DialogItemCollapsed } from './DialogItemCollapsed.jsx';

export function DialogItem({
  dialog,
  characters,
  onDelete,
  onCharacterChange,
  onAudioChange,
  onApplied,
  critique,
  isExpanded,
  onExpandToggle,
}) {
  const id = dialog._id?.toString?.() || String(dialog._id);
  const [alternatives, setAlternatives] = useState(null);
  const [loadingAlts, setLoadingAlts] = useState(false);
  const [altError, setAltError] = useState(null);

  async function requestAlternatives() {
    setLoadingAlts(true);
    setAltError(null);
    try {
      const r = await apiPostJson(`/dialog/${id}/alternatives`, {});
      setAlternatives(r.alternatives || []);
    } catch (e) {
      setAltError(e.message);
    } finally {
      setLoadingAlts(false);
    }
  }

  async function applyAlternative(text) {
    try {
      await apiPatchJson(`/dialog/${id}`, { body: text });
      setAlternatives(null);
      onApplied?.();
    } catch (e) {
      setAltError(e.message);
    }
  }
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  // Shared controls — rendered in both the collapsed row and the expanded
  // header so the critique score and regenerate action are always visible.
  const critiqueBadge = critique ? (
    <span
      className={`dialog-critique-badge dialog-critique-${critique.score <= 2 ? 'weak' : critique.score >= 4 ? 'strong' : 'mid'}`}
      title={critique.issue || 'Critic score'}
    >
      {critique.score}/5{critique.issue ? ` · ${critique.issue}` : ''}
    </span>
  ) : null;

  const regenButton = (
    <button
      type="button"
      className="dialog-regen-btn"
      onClick={(e) => {
        e.stopPropagation();
        requestAlternatives();
      }}
      disabled={loadingAlts}
      title="Regenerate this line — keeps the speaker and surrounding lines fixed"
    >
      {loadingAlts ? 'Regenerating…' : '↻ Regenerate'}
    </button>
  );

  const altPicker = (
    <>
      {altError && <div className="error-banner">{altError}</div>}
      {alternatives && (
        <div className="dialog-alternatives" onClick={(e) => e.stopPropagation()}>
          {alternatives.length === 0 ? (
            <p style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
              No alternatives came back. Try again.
            </p>
          ) : (
            alternatives.map((alt, i) => (
              <button
                key={i}
                type="button"
                className="dialog-alternative-option"
                onClick={() => applyAlternative(alt)}
                title="Use this line"
              >
                {alt}
              </button>
            ))
          )}
          <button
            type="button"
            className="dialog-alternative-dismiss"
            onClick={() => setAlternatives(null)}
          >
            Cancel
          </button>
        </div>
      )}
    </>
  );

  if (!isExpanded) {
    return (
      <div
        ref={setNodeRef}
        style={style}
        className="dialog-item dialog-item-collapsed-wrap"
      >
        <DialogItemCollapsed
          dialog={dialog}
          onClick={() => onExpandToggle?.(id)}
          dragAttributes={attributes}
          dragListeners={listeners}
          critiqueBadge={critiqueBadge}
          regenButton={regenButton}
        />
        {altPicker}
      </div>
    );
  }

  return (
    <div ref={setNodeRef} style={style} className="dialog-item">
      <div className="dialog-item-header">
        <button
          type="button"
          className="dialog-drag-handle"
          aria-label="Drag to reorder"
          {...attributes}
          {...listeners}
        >
          ⋮⋮
        </button>
        <button
          type="button"
          className="dialog-item-collapse"
          onClick={() => onExpandToggle?.(id)}
          title="Collapse this item"
        >
          Collapse
        </button>
        <button
          type="button"
          className="dialog-item-delete"
          onClick={onDelete}
        >
          Delete
        </button>
        {critiqueBadge && (
          <span style={{ marginLeft: 'auto' }}>{critiqueBadge}</span>
        )}
      </div>

      <div className="dialog-item-fields">
        <div className="dialog-item-character">
          <div className="field-label">Character</div>
          <CharacterSelect
            value={dialog.character || ''}
            characters={characters}
            onChange={(plainName) => onCharacterChange(id, plainName)}
          />
        </div>
        <div className="dialog-item-body">
          <div
            className="field-label"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <span>Body</span>
            {regenButton}
          </div>
          <CollabField
            field={`item:${id}:body`}
            multiline
            placeholder="What the character says…"
          />
          {altPicker}
        </div>
        <AudioSlot
          audioId={dialog.audio_file_id}
          uploadEndpoint={`/dialog/${id}/audio`}
          deleteEndpoint={`/dialog/${id}/audio`}
          recordingPrefix={`dialog-${id}`}
          onRefresh={onAudioChange}
        />
      </div>
    </div>
  );
}
