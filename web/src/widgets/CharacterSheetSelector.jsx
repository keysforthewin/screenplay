// Per-character dropdown used on the storyboard page to pick which sheet
// to feed the generator as the reference image for that character. The
// "Default" option falls back to the renderer's standard chain
// (character_sheet_image_ids[0] → main → first portrait).
export function CharacterSheetSelector({ character, value, onChange, disabled }) {
  const sheets = character.sheets || [];
  return (
    <select
      value={value || ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      style={{ minWidth: 180 }}
    >
      <option value="">
        Default{sheets[0]?.name ? ` (${sheets[0].name})` : ''}
      </option>
      {sheets.map((s) => (
        <option key={s._id} value={s._id}>
          {s.name || `Sheet ${s._id.slice(-6)}`}
        </option>
      ))}
    </select>
  );
}
