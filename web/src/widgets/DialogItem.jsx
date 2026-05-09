import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CollabField } from '../editor/CollabField.jsx';
import { CharacterSelect } from './CharacterSelect.jsx';

export function DialogItem({ dialog, index, characters, onDelete, onCharacterChange }) {
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
        <span className="dialog-item-order">#{index + 1}</span>
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
      </div>
    </div>
  );
}
