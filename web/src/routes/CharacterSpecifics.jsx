import { useEffect, useState } from 'react';
import { CollabField } from '../editor/CollabField.jsx';
import { apiGet, apiPostJson } from '../api.js';
import { SPECIFICS_FIELDS } from '../specifics.js';
import { CharacterSheetList } from '../widgets/CharacterSheetList.jsx';
import { GenerateSheetDialog } from '../widgets/GenerateSheetDialog.jsx';

// Character "Specifics" tab. Renders the specifics CollabFields plus the
// multi-sheet management UI: a generate button that opens the prompt-edit
// dialog, and a drag-reorderable list of every sheet the character has.
export function CharacterSpecifics({ character, onRefresh }) {
  const cid = character._id;
  const sheetIds = character.character_sheet_image_ids || (character.character_sheet_image_id
    ? [character.character_sheet_image_id]
    : []);
  const [autofilling, setAutofilling] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [genOpen, setGenOpen] = useState(false);
  const [sheets, setSheets] = useState([]);

  // Fetch each sheet's name from GridFS metadata so the list shows
  // human-readable labels. Refetched whenever the id list changes.
  useEffect(() => {
    let cancelled = false;
    if (!sheetIds.length) {
      setSheets([]);
      return undefined;
    }
    (async () => {
      try {
        const r = await apiGet(`/character/${cid}/character-sheets`);
        if (!cancelled) setSheets(r.sheets || []);
      } catch {
        if (!cancelled) {
          setSheets(sheetIds.map((id) => ({ _id: id?.toString?.() || String(id), name: '' })));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, sheetIds.join(',')]);

  async function runAutofill() {
    setError(null);
    setNotice(null);
    setAutofilling(true);
    try {
      const r = await apiPostJson(`/character/${cid}/specifics/autofill`, {});
      if (r.reason === 'no_images') {
        setNotice('No images attached — upload some on the Details tab first.');
      } else if (r.reason === 'no_eligible_images') {
        setNotice('None of the attached images are eligible (must be PNG/JPEG/WEBP under 4 MB).');
      } else if (r.reason === 'no_context') {
        setNotice(
          'Not enough context to autofill — add description text on the Details tab or attach reference images.',
        );
      } else if (r.reason === 'no_tool_call') {
        setNotice(
          'The model did not return any fields. Try again or fill in a few fields manually first.',
        );
      } else if (!r.filled || r.filled.length === 0) {
        setNotice('Autofill ran but no empty fields were filled (all already had values).');
      } else {
        setNotice(`Filled ${r.filled.length} field(s): ${r.filled.join(', ')}.`);
        onRefresh?.();
      }
    } catch (e) {
      setError(e.message || 'Autofill failed');
    } finally {
      setAutofilling(false);
    }
  }

  return (
    <div>
      <div className="spec-actions-bar">
        <button type="button" onClick={runAutofill} disabled={autofilling}>
          {autofilling ? 'Auto-filling…' : 'Auto-fill from description + images'}
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => setGenOpen(true)}
          title="Open the dialog to edit the prompt and pick reference images before generating."
        >
          Generate character sheet…
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice-banner">{notice}</div>}

      {SPECIFICS_FIELDS.map((f) => (
        <CollabField
          key={f.name}
          label={f.label}
          field={`specifics.${f.name}`}
          multiline={f.multiline}
          placeholder={f.placeholder}
        />
      ))}

      <div className="character-sheet-block">
        <span className="field-label">
          Character sheets {sheets.length > 0 ? `(${sheets.length})` : ''}
        </span>
        <CharacterSheetList characterId={cid} sheets={sheets} onRefresh={onRefresh} />
      </div>

      <GenerateSheetDialog
        open={genOpen}
        onClose={() => setGenOpen(false)}
        character={character}
        onGenerated={(r) => {
          setNotice(`Sheet "${r.sheet_name}" generated via ${r.model}.`);
          onRefresh?.();
        }}
      />
    </div>
  );
}
