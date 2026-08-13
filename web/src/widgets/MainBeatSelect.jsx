// Single-select over the beats that reference a set (from GET /set/:id/beats):
// the ONE beat plates are planned for. Choosing "none" falls back to the
// legacy behavior (plan from all selected beats at once). Purely
// presentational — the owning dialog loads the list and holds the value.
export function MainBeatSelect({ beats, value, onChange, disabled = false }) {
  const list = beats || [];
  if (!list.length) return null;
  return (
    <div className="image-sheet-shotlist">
      <span className="field-label">
        Main beat — images are planned for what this beat stages in this set
      </span>
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">— none (plan from all selected beats) —</option>
        {list.map((b) => (
          <option key={b._id} value={b._id}>
            #{b.order} {b.plain_name || 'Untitled'}{b.body_empty ? ' (no text)' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}
