import { useState } from 'react';
import { CollabField } from '../editor/CollabField.jsx';
import { apiPostJson, imageUrl } from '../api.js';

const QUALITY_OPTIONS = ['low', 'medium', 'high', 'auto'];

// Generic "Specifics" tab used by both the character editor and the beat
// editor. The caller passes:
//   - `fields`: an array of {name, label, placeholder, multiline}; one
//     CollabField is rendered per entry, bound to the y-doc fragment named
//     `specifics.<name>`.
//   - `imageId`: the current sheet image id on the entity, or null.
//   - `autofillUrl` / `generateUrl`: the two POST endpoints to call.
//   - `entityLabel`: "character" or "scene" (used in the notice text).
//   - `downloadFilename`: filename to use when downloading the sheet image.
//   - `imageAltText`, `emptyText`: textual labels that differ per entity.
//   - `onRefresh`: callback to re-fetch the entity after mutations.
export function SpecificsTab({
  fields,
  imageId,
  autofillUrl,
  generateUrl,
  entityLabel,
  downloadFilename,
  imageAltText,
  emptyText,
  onRefresh,
}) {
  const [quality, setQuality] = useState('auto');
  const [autofilling, setAutofilling] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  async function runAutofill() {
    setError(null);
    setNotice(null);
    setAutofilling(true);
    try {
      const r = await apiPostJson(autofillUrl, {});
      if (r.reason === 'no_images') {
        setNotice(`No images attached — upload some on the Details tab first.`);
      } else if (r.reason === 'no_eligible_images') {
        setNotice(
          'None of the attached images are eligible (must be PNG/JPEG/WEBP under 4 MB).',
        );
      } else if (r.reason === 'no_context') {
        setNotice(
          `Not enough context to autofill — add description text on the Details tab or attach reference images.`,
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

  async function runGenerate() {
    setError(null);
    setNotice(null);
    setGenerating(true);
    try {
      const r = await apiPostJson(generateUrl, { quality });
      setNotice(`${entityLabel === 'scene' ? 'Scene' : 'Character'} sheet generated (${r.model || 'gpt-image-2'}).`);
      onRefresh?.();
      setTimeout(() => {
        document.getElementById('sheet-image')?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
        });
      }, 100);
    } catch (e) {
      setError(e.message || 'Generation failed');
    } finally {
      setGenerating(false);
    }
  }

  function downloadSheet() {
    if (!imageId) return;
    const a = document.createElement('a');
    a.href = imageUrl(imageId);
    a.download = downloadFilename || `${entityLabel}-sheet.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const sheetLabel = entityLabel === 'scene' ? 'Scene reference sheet' : 'Character sheet';
  const generateLabel = entityLabel === 'scene' ? 'Generate scene sheet' : 'Generate character sheet';

  return (
    <div>
      <div className="spec-actions-bar">
        <button
          type="button"
          onClick={runAutofill}
          disabled={autofilling || generating}
        >
          {autofilling ? 'Auto-filling…' : 'Auto-fill from description + images'}
        </button>
        <button
          type="button"
          className="primary"
          onClick={runGenerate}
          disabled={autofilling || generating}
          title="May take 1–2 minutes."
        >
          {generating ? 'Generating…' : generateLabel}
        </button>
        <span className="quality-group">
          Quality:
          {QUALITY_OPTIONS.map((q) => (
            <label key={q}>
              <input
                type="radio"
                name="sheet-quality"
                value={q}
                checked={quality === q}
                disabled={generating}
                onChange={() => setQuality(q)}
              />
              {q}
            </label>
          ))}
        </span>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice-banner">{notice}</div>}

      {fields.map((f) => (
        <CollabField
          key={f.name}
          label={f.label}
          field={`specifics.${f.name}`}
          multiline={f.multiline}
          placeholder={f.placeholder}
        />
      ))}

      <div className="character-sheet-block">
        <span className="field-label">{sheetLabel}</span>
        {imageId ? (
          <>
            <div className="actions">
              <button type="button" onClick={downloadSheet}>
                Download
              </button>
              <a href={imageUrl(imageId)} target="_blank" rel="noreferrer">
                View full size →
              </a>
            </div>
            <img
              id="sheet-image"
              className="character-sheet-image"
              src={imageUrl(imageId)}
              alt={imageAltText || sheetLabel}
            />
          </>
        ) : (
          <div className="character-sheet-empty">
            {emptyText || `No ${sheetLabel.toLowerCase()} generated yet. Fill in the fields above and click "${generateLabel}".`}
          </div>
        )}
      </div>
    </div>
  );
}
