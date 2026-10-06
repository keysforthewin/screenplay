import { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPostJson, apiPutJson } from '../api.js';
import { VoiceLibraryBrowser } from './VoiceLibraryBrowser.jsx';

const CATEGORY_LABELS = {
  cloned: 'Cloned',
  generated: 'Designed',
  professional: 'Professional',
  premade: 'Premade',
};
const CATEGORY_ORDER = ['cloned', 'generated', 'professional', 'premade'];

function voiceLabel(v) {
  const l = v.labels || {};
  const bits = [l.gender, l.age && String(l.age).replace(/_/g, ' '), l.accent].filter(Boolean);
  return bits.length ? `${v.name} — ${bits.join(', ')}` : v.name;
}

// The character's ElevenLabs voice: a dropdown of every voice in the
// ElevenLabs account, with a preview button. The pick is stored on the
// character (`eleven_voice`); the dialogue page writes audio tags for, and
// generates audio with, whoever has one. "Find new voices" opens a keyword +
// facet search over ElevenLabs' shared library; a voice found there is saved
// to the account (`POST /eleven/library/add`) and can then be picked.
//
// Props: characterId, value (character.eleven_voice | null), onChange.
//
// The dialogue page reuses it for one line's own voice (`dialogId` instead of
// `characterId`, value = dialog.eleven_voice): `inherited` is then the voice
// of the line's character ({ voice_id, voice_name, preview_url } | null) — the
// field shows it as the default until another voice is picked, which
// overrides it for that line only.
export function ElevenVoiceField({ characterId, dialogId, value, inherited = null, onChange }) {
  const forLine = Boolean(dialogId);
  const endpoint = forLine ? `/dialog/${dialogId}/eleven-voice` : `/character/${characterId}/eleven-voice`;
  const inheritedId = inherited?.voice_id || '';
  const [voices, setVoices] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef(null);
  const [finding, setFinding] = useState(false);
  // Library voice id → its id in the account, for voices added from the search.
  const [addedIds, setAddedIds] = useState(() => new Map());
  const selectedId = value?.voice_id || '';

  async function load(refresh = false) {
    setLoadError(null);
    try {
      const r = await apiGet(`/eleven/voices${refresh ? '?refresh=1' : ''}`);
      setVoices(r.voices || []);
    } catch (e) {
      setVoices([]);
      setLoadError(e.message);
    }
  }
  useEffect(() => { load(); }, []);

  function stopPreview() {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(false);
  }
  useEffect(() => stopPreview, []);

  // The voice in effect: the stored pick, else the inherited default.
  const selected = useMemo(() => {
    const id = selectedId || inheritedId;
    if (!id) return null;
    return (
      (voices || []).find((v) => v.voice_id === id) ||
      (selectedId ? value : { name: inherited.voice_name, preview_url: inherited.preview_url })
    );
  }, [voices, selectedId, inheritedId, value, inherited]);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const shown = (voices || []).filter((v) => {
      if (v.voice_id === selectedId) return true;
      if (!q) return true;
      const hay = [v.name, v.description, ...Object.values(v.labels || {})].join(' ').toLowerCase();
      return hay.includes(q);
    });
    const byCat = new Map();
    for (const v of shown) {
      const cat = v.category || 'other';
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(v);
    }
    const cats = [...byCat.keys()].sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a);
      const ib = CATEGORY_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return cats.map((cat) => ({ cat, label: CATEGORY_LABELS[cat] || cat, voices: byCat.get(cat) }));
  }, [voices, filter, selectedId]);

  const accountIds = useMemo(
    () => new Set([...(voices || []).map((v) => v.voice_id), ...addedIds.keys()]),
    [voices, addedIds],
  );

  async function addToAccount(v) {
    const r = await apiPostJson('/eleven/library/add', {
      voice_id: v.voice_id,
      public_owner_id: v.public_owner_id,
      name: v.name,
    });
    setVoices(r.voices || []);
    setAddedIds((prev) => new Map(prev).set(v.voice_id, r.voice_id || v.voice_id));
  }

  async function pick(voiceId) {
    stopPreview();
    setSaving(true);
    setError(null);
    try {
      // Picking the character's own voice on a line is "no override".
      const id = voiceId && voiceId !== inheritedId ? voiceId : null;
      await apiPutJson(endpoint, { voice_id: id });
      await onChange?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  function togglePreview() {
    if (playing) {
      stopPreview();
      return;
    }
    if (!selected?.preview_url) return;
    const a = new Audio(selected.preview_url);
    a.onended = () => setPlaying(false);
    a.onerror = () => {
      setPlaying(false);
      setError('Could not play the preview.');
    };
    audioRef.current = a;
    setPlaying(true);
    a.play().catch(() => setPlaying(false));
  }

  // The stored voice is offered even when the list failed to load or the
  // voice has since left the account.
  const selectedMissing = selectedId && voices && !voices.some((v) => v.voice_id === selectedId);

  return (
    <div className="eleven-voice-field">
      <span className="field-label">ElevenLabs Voice</span>
      <div className="eleven-voice-row">
        {(voices?.length || 0) > 12 && (
          <input
            type="search"
            className="eleven-voice-filter"
            placeholder={`Filter ${voices.length} voices…`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        )}
        <select
          value={selectedId}
          disabled={saving || voices === null}
          onChange={(e) => pick(e.target.value)}
        >
          <option value="">
            {voices === null
              ? 'Loading voices…'
              : inheritedId
                ? `Character’s voice — ${inherited.voice_name || inheritedId}`
                : '— No voice —'}
          </option>
          {selectedMissing && (
            <option value={selectedId}>{value?.name || selectedId} (not in the account)</option>
          )}
          {groups.map((g) => (
            <optgroup key={g.cat} label={`${g.label} (${g.voices.length})`}>
              {g.voices.map((v) => (
                <option key={v.voice_id} value={v.voice_id}>{voiceLabel(v)}</option>
              ))}
            </optgroup>
          ))}
        </select>
        <button
          type="button"
          onClick={togglePreview}
          disabled={!selected?.preview_url}
          title={selected?.preview_url ? 'Play this voice’s sample' : 'Pick a voice with a sample to preview it'}
        >
          {playing ? '■ Stop' : '▶ Preview'}
        </button>
        <button type="button" onClick={() => load(true)} title="Reload the voice list from ElevenLabs">
          ↻
        </button>
        <button type="button" onClick={() => setFinding((f) => !f)} aria-expanded={finding}>
          {finding ? 'Close voice search' : 'Find new voices…'}
        </button>
      </div>
      {selected?.description && <div className="muted eleven-voice-hint">{selected.description}</div>}
      <div className="muted eleven-voice-hint">
        {forLine
          ? selectedId
            ? `This line has its own voice${inheritedId ? ', overriding its character’s' : ''}. It is written with audio tags and voiced by “Generate all voices”.`
            : inheritedId
              ? 'Voiced by its character’s voice. Pick another to override it for this line only.'
              : 'No voice: this line is written without audio tags and is skipped by “Generate all voices”. Pick one to voice this line.'
          : selectedId
            ? 'This character’s dialogue is written with ElevenLabs v4 audio tags and voiced by “Generate all voices” on the dialogue page.'
            : 'No voice: this character’s dialogue is written without audio tags and is skipped by “Generate all voices”.'}
      </div>
      {loadError && <div className="error-banner small">Could not load ElevenLabs voices: {loadError}</div>}
      {error && <div className="error-banner small">{error}</div>}
      {finding && (
        <div className="eleven-voice-finder">
          <div className="muted eleven-voice-hint">
            Search ElevenLabs’ voice library. Adding a voice saves it to the ElevenLabs account (it takes one of the account’s voice slots).
          </div>
          <VoiceLibraryBrowser
            collectionIds={accountIds}
            addVoice={addToAccount}
            addLabel="+ Add to account"
            addedLabel="✓ In account"
            useLabel={forLine ? 'Use for this line' : 'Use for this character'}
            onUse={(v) => pick(addedIds.get(v.voice_id) || v.voice_id)}
          />
        </div>
      )}
    </div>
  );
}
