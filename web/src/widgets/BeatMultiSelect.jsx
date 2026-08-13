// Checkbox multi-select over the beats that reference a set (from
// GET /set/:id/beats). Purely presentational — the owning dialog loads the
// list and holds the selection. Beats whose body is empty are flagged so the
// user knows they contribute no text to the LLM context.
export function BeatMultiSelect({ beats, selectedIds, onChange, disabled = false, label = 'Beats to include' }) {
  const list = beats || [];

  function toggle(id) {
    onChange(
      selectedIds.includes(id)
        ? selectedIds.filter((x) => x !== id)
        : [...selectedIds, id],
    );
  }

  if (!list.length) {
    return (
      <div className="image-sheet-shotlist">
        <span className="field-label">{label}</span>
        <span className="frame-generate-help">
          No beats reference this set yet — only the set's name and description
          will be used.
        </span>
      </div>
    );
  }

  return (
    <div className="image-sheet-shotlist">
      <div className="frame-generate-section-header">
        <span className="field-label">
          {label} ({selectedIds.length}/{list.length})
        </span>
        <span style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => onChange(list.map((b) => b._id))} disabled={disabled}>All</button>
          <button type="button" onClick={() => onChange([])} disabled={disabled}>None</button>
        </span>
      </div>
      <div className="image-sheet-shotlist-grid">
        {list.map((b) => (
          <label key={b._id} className="image-sheet-shot" title={b.desc || ''}>
            <input
              type="checkbox"
              checked={selectedIds.includes(b._id)}
              onChange={() => toggle(b._id)}
              disabled={disabled}
            />
            <span>
              #{b.order} {b.plain_name || 'Untitled'}
              {b.body_empty && <em style={{ opacity: 0.6 }}> (no text)</em>}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
