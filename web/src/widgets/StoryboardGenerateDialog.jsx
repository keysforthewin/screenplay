import { useEffect, useState } from 'react';
import { Modal } from './Modal.jsx';
import { CharacterSheetSelector } from './CharacterSheetSelector.jsx';

const MODEL_STORAGE_KEY = 'screenplay.storyboard.model';
const VALID_MODELS = new Set(['gemini', 'openai']);
const MODEL_LABEL = {
  gemini: 'Nano Banana (Gemini)',
  openai: 'OpenAI (gpt-image-2)',
};

function readStoredModel() {
  try {
    const v = localStorage.getItem(MODEL_STORAGE_KEY);
    return VALID_MODELS.has(v) ? v : 'gemini';
  } catch {
    return 'gemini';
  }
}

// Pre-generation modal for the page-level "Generate" button. Collects:
//   - per-character sheet override (replaces the inline picker that used
//     to live above the storyboard list)
//   - image model choice (Gemini Nano Banana vs OpenAI gpt-image-2)
//
// When existing storyboards will be replaced, shows a warning banner inline
// (folding in what the old "Replace existing storyboards?" ConfirmDialog used
// to do).
export function StoryboardGenerateDialog({
  open,
  onClose,
  onSubmit,
  beatCharacters = [],
  existingCount = 0,
}) {
  const [imageModel, setImageModel] = useState(readStoredModel);
  const [sheetOverrides, setSheetOverrides] = useState({});

  // Reset overrides each time the dialog opens so a stale prior selection
  // doesn't leak between sessions on the same page.
  useEffect(() => {
    if (open) setSheetOverrides({});
  }, [open]);

  useEffect(() => {
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, imageModel);
    } catch {}
  }, [imageModel]);

  function submit() {
    const cleaned = {};
    for (const [cid, sid] of Object.entries(sheetOverrides)) {
      if (sid) cleaned[cid] = sid;
    }
    onSubmit({ sheetOverrides: cleaned, imageModel });
  }

  return (
    <Modal
      open={open}
      title="Generate storyboard"
      onClose={onClose}
      dismissible
      footer={
        <>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" onClick={submit}>
            Generate
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {existingCount > 0 && (
          <div
            style={{
              background: 'var(--accent-bg, rgba(255,255,255,0.04))',
              border: '1px solid var(--err, #f88)',
              padding: '8px 12px',
              borderRadius: 4,
              fontSize: 13,
            }}
          >
            This will delete and replace the existing{' '}
            {existingCount} storyboard {existingCount === 1 ? 'item' : 'items'}.
            If planning fails, your current items are preserved.
          </div>
        )}

        {beatCharacters.length > 0 && (
          <div>
            <span className="field-label">Character sheets</span>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                marginTop: 6,
              }}
            >
              {beatCharacters.map((c) => (
                <label
                  key={c._id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 13,
                  }}
                >
                  <span style={{ minWidth: 100 }}>{c.name}:</span>
                  <CharacterSheetSelector
                    character={c}
                    value={sheetOverrides[c._id] || ''}
                    onChange={(sheetId) =>
                      setSheetOverrides((prev) => ({ ...prev, [c._id]: sheetId }))
                    }
                  />
                </label>
              ))}
            </div>
          </div>
        )}

        <div>
          <span className="field-label">Image model</span>
          <div
            style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}
          >
            {['gemini', 'openai'].map((m) => (
              <label
                key={m}
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}
              >
                <input
                  type="radio"
                  name="storyboard-image-model"
                  value={m}
                  checked={imageModel === m}
                  onChange={() => setImageModel(m)}
                />
                {MODEL_LABEL[m]}
              </label>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
