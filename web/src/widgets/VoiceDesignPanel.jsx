import { useState } from 'react';
import { apiPostJson } from '../api.js';

// Voice Design: describe a voice → audition ~3 generated previews (base64
// audio, never persisted) → save the winner into the account + collection.

export function VoiceDesignPanel({ onCreated }) {
  const [description, setDescription] = useState('');
  const [previewText, setPreviewText] = useState('');
  const [previews, setPreviews] = useState(null);
  const [chosenId, setChosenId] = useState(null);
  const [voiceName, setVoiceName] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function generate() {
    if (description.trim().length < 20 || busy) return;
    setError(null);
    setBusy(true);
    setPreviews(null);
    setChosenId(null);
    try {
      const r = await apiPostJson('/eleven/design', {
        voice_description: description.trim(),
        preview_text: previewText.trim() || null,
      });
      setPreviews(r.previews || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!chosenId || !voiceName.trim() || saving) return;
    setError(null);
    setSaving(true);
    try {
      const r = await apiPostJson('/eleven/design/save', {
        voice_name: voiceName.trim(),
        voice_description: description.trim(),
        generated_voice_id: chosenId,
      });
      setPreviews(null);
      setChosenId(null);
      setVoiceName('');
      onCreated(r.voice);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="eleven-design">
      {error && <div className="error-banner">{error}</div>}
      <textarea
        rows={3}
        placeholder="Describe the voice (min 20 chars): 'A gravelly 60-year-old film noir detective with a slight Brooklyn accent, weary but sharp…'"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <input
        type="text"
        placeholder="Optional: exact preview text the samples should speak"
        value={previewText}
        onChange={(e) => setPreviewText(e.target.value)}
      />
      <button
        type="button"
        className="primary"
        disabled={description.trim().length < 20 || busy}
        title={description.trim().length < 20 ? 'Describe the voice in at least 20 characters' : ''}
        onClick={generate}
      >
        {busy ? 'Designing…' : 'Generate previews'}
      </button>

      {previews && previews.length === 0 && (
        <p className="playground-empty">No previews came back — try a richer description.</p>
      )}
      {previews && previews.length > 0 && (
        <div className="eleven-design-previews">
          {previews.map((p, i) => (
            <label
              key={p.generated_voice_id}
              className={`eleven-design-preview${chosenId === p.generated_voice_id ? ' is-selected' : ''}`}
            >
              <input
                type="radio"
                name="eleven-design-choice"
                checked={chosenId === p.generated_voice_id}
                onChange={() => setChosenId(p.generated_voice_id)}
              />
              <span>Preview {i + 1}</span>
              <audio controls src={p.audio_data_url} preload="metadata" />
            </label>
          ))}
          <div className="eleven-design-save">
            <input
              type="text"
              placeholder="Name the voice"
              value={voiceName}
              onChange={(e) => setVoiceName(e.target.value)}
            />
            <button
              type="button"
              className="primary"
              disabled={!chosenId || !voiceName.trim() || saving}
              onClick={save}
            >
              {saving ? 'Saving…' : 'Save voice'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
