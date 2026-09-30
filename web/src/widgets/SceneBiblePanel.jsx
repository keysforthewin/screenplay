import { useState } from 'react';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { CollabField } from '../editor/CollabField.jsx';
import { ConfirmDialog } from './Modal.jsx';
import { apiGet, apiPostJson } from '../api.js';

const BIBLE_FIELDS = [
  ['intention', 'Intention'],
  ['turn', 'The turn'],
  ['location', 'Location'],
  ['time_of_day', 'Time of day'],
  ['lighting_key', 'Lighting key'],
  ['palette', 'Palette'],
  ['mood', 'Mood'],
  ['blocking', 'Blocking'],
  ['continuity_anchors', 'Continuity anchors'],
  ['camera_language', 'Camera language'],
];

// The beat's scene bible (intention, light, palette, blocking…). The cut
// planner on the Prompts tab reads it as part of the whole-beat context.
export function SceneBiblePanel({ beatId, session }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(null);
  const [autofilling, setAutofilling] = useState(false);
  const [autofillConfirmOpen, setAutofillConfirmOpen] = useState(false);

  // Auto-fill every scene bible field from the beat. Confirm first only when
  // the bible already has content, so an empty bible fills with zero friction.
  async function onAutofillClick(e) {
    e.stopPropagation();
    setError(null);
    let hasContent = false;
    try {
      const r = await apiGet(`/beat?id=${encodeURIComponent(beatId)}`);
      const sb = r?.beat?.scene_bible || {};
      hasContent = Object.values(sb).some((v) => typeof v === 'string' && v.trim());
    } catch {
      hasContent = true; // couldn't check — be safe and confirm before overwriting
    }
    if (hasContent) setAutofillConfirmOpen(true);
    else runAutofill();
  }

  async function runAutofill() {
    setAutofilling(true); setError(null); setOpen(true);
    try {
      await apiPostJson(`/beat/${beatId}/scene-bible/autofill`, {});
    } catch (e) {
      setError(e.message);
    } finally {
      setAutofilling(false);
    }
  }

  return (
    <div className="scene-bible">
      <div className="scene-bible-head" onClick={() => setOpen((o) => !o)}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className="title">Scene Bible</span>
        <span className="sub">read by Auto generate</span>
        <span className="spacer" />
        <button disabled={autofilling} onClick={onAutofillClick}>
          {autofilling ? 'Auto-filling…' : 'Auto-fill'}
        </button>
      </div>
      <ConfirmDialog
        open={autofillConfirmOpen}
        title="Auto-fill the Scene Bible?"
        message="Read the current beat and overwrite every Scene Bible field. This replaces any existing values."
        confirmLabel="Auto-fill"
        onConfirm={() => { setAutofillConfirmOpen(false); runAutofill(); }}
        onCancel={() => setAutofillConfirmOpen(false)}
      />
      {error && <div className="critique-error">{error}</div>}
      {open && (
        <CollabSurface room={`beat:${beatId}`} session={session}>
          <div className="scene-bible-grid">
            {BIBLE_FIELDS.map(([key, label]) => (
              <div className="scene-bible-field" key={key}>
                <CollabField label={label} field={`scene_bible.${key}`} multiline />
              </div>
            ))}
          </div>
        </CollabSurface>
      )}
    </div>
  );
}
