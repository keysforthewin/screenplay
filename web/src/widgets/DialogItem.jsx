import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
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
  isExpanded,
  onExpandToggle,
}) {
  const id = dialog._id?.toString?.() || String(dialog._id);
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
        />
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
          <div className="field-label">Body</div>
          <CollabField
            field={`item:${id}:body`}
            multiline
            placeholder="What the character says…"
          />
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
