// Clickable Eleven v3 audio-tag chips, grouped (Emotions / Delivery /
// Reactions). Tag names arrive bracket-free from /api/eleven/info; clicking
// a chip hands the bracketed form to the parent, which inserts it at the
// textarea cursor.

export function AudioTagPalette({ tags, onInsert }) {
  if (!tags) return null;
  return (
    <div className="eleven-tag-palette">
      {Object.entries(tags).map(([group, names]) => (
        <div key={group} className="eleven-tag-group">
          <span className="eleven-tag-group-name">{group}</span>
          <span className="eleven-tag-chips">
            {names.map((name) => (
              <button
                key={name}
                type="button"
                className="eleven-tag-chip"
                title={`Insert [${name}] at the cursor`}
                onClick={() => onInsert(`[${name}]`)}
              >
                [{name}]
              </button>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}
