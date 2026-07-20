// Drag-and-drop reorderable beat list for the Table of Contents. Reordering
// posts the full new id sequence to /beats/reorder, which renumbers beats
// 1..N server-side. Mirrors the dnd-kit wiring in DialogBeat.jsx. `items` are
// pre-sorted rows; `content` is the caller's per-tab label so the Beats /
// Dialog / Storyboard tabs keep their distinct row text.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
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
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { apiPostJson } from '../api.js';

function SortableRow({ id, to, content, title, className }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`toc-sortable-row${className ? ` ${className}` : ''}`}
    >
      <button
        type="button"
        className="toc-drag-handle"
        aria-label="Drag to reorder beat"
        {...attributes}
        {...listeners}
      >
        ⋮⋮
      </button>
      <Link to={to} title={title}>{content}</Link>
    </li>
  );
}

export function SortableBeatList({ items, onReordered, onError, disabled }) {
  const [order, setOrder] = useState(() => items.map((i) => i.id));
  // Keep local order in sync when the parent refetches (ids/length change).
  useEffect(() => { setOrder(items.map((i) => i.id)); }, [items]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const rows = useMemo(() => order.map((id) => byId.get(id)).filter(Boolean), [order, byId]);

  if (disabled) {
    return (
      <ul>
        {items.map((i) => (
          <li key={i.id} className={i.className}><Link to={i.to} title={i.title}>{i.content}</Link></li>
        ))}
      </ul>
    );
  }

  async function handleDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = order.indexOf(active.id);
    const newIndex = order.indexOf(over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const prev = order;
    const next = arrayMove(order, oldIndex, newIndex);
    setOrder(next);
    try {
      await apiPostJson('/beats/reorder', { ordered_ids: next });
      onReordered?.();
    } catch (e) {
      setOrder(prev); // revert optimistic move
      onError?.(`Reorder failed: ${e.message}`);
    }
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={order} strategy={verticalListSortingStrategy}>
        <ul className="toc-sortable-list">
          {rows.map((i) => (
            <SortableRow key={i.id} id={i.id} to={i.to} content={i.content} title={i.title} className={i.className} />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}
