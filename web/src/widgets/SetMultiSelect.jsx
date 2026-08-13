import { thumbUrl } from '../api.js';

// Checkbox multi-select over the project's sets (from GET /toc → sets). The
// checked sets' gallery images join the reference pool when rendering. Purely
// presentational — the owning dialog loads the list and holds the selection.
export function SetMultiSelect({
  sets,
  selectedIds,
  onChange,
  disabled = false,
  label = 'Reference sets',
  currentSetId = null,
}) {
  const list = sets || [];

  function toggle(id) {
    onChange(
      selectedIds.includes(id)
        ? selectedIds.filter((x) => x !== id)
        : [...selectedIds, id],
    );
  }

  if (!list.length) return null;

  return (
    <div className="image-sheet-shotlist">
      <div className="frame-generate-section-header">
        <span className="field-label">
          {label} ({selectedIds.length}/{list.length})
        </span>
        <span style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => onChange(list.map((s) => String(s._id)))} disabled={disabled}>All</button>
          <button type="button" onClick={() => onChange([])} disabled={disabled}>None</button>
        </span>
      </div>
      <div className="image-sheet-shotlist-grid">
        {list.map((s) => {
          const id = String(s._id);
          return (
            <label key={id} className="image-sheet-shot">
              <input
                type="checkbox"
                checked={selectedIds.includes(id)}
                onChange={() => toggle(id)}
                disabled={disabled}
              />
              {s.main_image_id ? (
                <img
                  src={thumbUrl(s.main_image_id)}
                  alt=""
                  loading="lazy"
                  style={{ width: 24, height: 24, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }}
                />
              ) : (
                <span style={{ width: 24, height: 24, borderRadius: 4, background: 'var(--border, #ccc3)', flexShrink: 0 }} />
              )}
              <span>
                {s.plain_name || 'Untitled'}
                {id === String(currentSetId) && <em style={{ opacity: 0.6 }}> (this set)</em>}
              </span>
            </label>
          );
        })}
      </div>
      <span className="frame-generate-help">
        The checked sets' gallery images are used as reference images when rendering.
      </span>
    </div>
  );
}
