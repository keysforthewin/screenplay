import { useState } from 'react';
import { apiPostJson } from '../api.js';
import { ElevenAudioInput } from './ElevenAudioInput.jsx';

// Instant Voice Cloning: stack one or more samples (uploads or in-browser
// recordings), name it, create. The new voice lands in the ElevenLabs
// account AND this project's collection (added_to_account is true from
// birth, so no lazy-add on first use).

export function VoiceClonePanel({ onCreated }) {
  const [samples, setSamples] = useState([]); // playground upload refs
  const [pending, setPending] = useState(null); // the in-progress ElevenAudioInput ref
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [removeNoise, setRemoveNoise] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  function acceptPending(ref) {
    if (ref) setSamples((prev) => [...prev, ref]);
    setPending(null);
  }

  async function create() {
    if (!name.trim() || samples.length === 0 || busy) return;
    setError(null);
    setBusy(true);
    try {
      const r = await apiPostJson('/eleven/clone', {
        name: name.trim(),
        description: description.trim() || null,
        remove_noise: removeNoise,
        refs: samples.map((s) => ({ file_id: s.file_id })),
      });
      setSamples([]);
      setName('');
      setDescription('');
      onCreated(r.voice);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="eleven-clone">
      {error && <div className="error-banner">{error}</div>}
      <p className="eleven-hint">
        Clone a voice from clean speech samples — a minute or two of one speaker,
        no music or crosstalk. Record several takes if you like; they all feed the clone.
      </p>
      {samples.length > 0 && (
        <div className="playground-chips">
          {samples.map((s) => (
            <span key={s.file_id} className="playground-chip">
              <span className="playground-chip-glyph">🔊</span>
              <span className="playground-chip-name">{s.filename}</span>
              <button
                type="button"
                title="Remove sample"
                onClick={() => setSamples((prev) => prev.filter((x) => x.file_id !== s.file_id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <ElevenAudioInput value={pending} onChange={acceptPending} />
      <div className="eleven-clone-fields">
        <input
          type="text"
          placeholder="Voice name (required)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          type="text"
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <label className="playground-filter-check">
          <input
            type="checkbox"
            checked={removeNoise}
            onChange={(e) => setRemoveNoise(e.target.checked)}
          />
          remove background noise
        </label>
        <button
          type="button"
          className="primary"
          disabled={!name.trim() || samples.length === 0 || busy}
          title={samples.length === 0 ? 'Add at least one audio sample' : ''}
          onClick={create}
        >
          {busy ? 'Cloning…' : 'Create voice clone'}
        </button>
      </div>
    </div>
  );
}
