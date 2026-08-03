import { useRef, useState } from 'react';
import { apiDelete } from '../api.js';
import { VoiceLibraryBrowser } from './VoiceLibraryBrowser.jsx';

// The voice half of the ElevenLabs panel: pick from the project's saved
// collection, or expand into Browse library / Clone / Design to grow it.

const SUB_TABS = [
  ['collection', 'Collection'],
  ['browse', 'Browse library'],
  ['clone', 'Clone'],
  ['design', 'Design'],
];

const SOURCE_GLYPHS = { library: '📚', clone: '🧬', design: '🎨' };

export function ElevenVoiceSection({ voices, activeVoiceId, onSelect, onRefresh }) {
  const [subTab, setSubTab] = useState('collection');
  const playerRef = useRef(null);

  function preview(url) {
    if (!url) return;
    if (!playerRef.current) playerRef.current = new Audio();
    const p = playerRef.current;
    if (p.src === url && !p.paused) p.pause();
    else {
      p.src = url;
      p.play().catch(() => {});
    }
  }

  async function remove(voiceId) {
    try {
      await apiDelete(`/eleven/collection/${encodeURIComponent(voiceId)}`);
      if (activeVoiceId === voiceId) onSelect(null);
      onRefresh();
    } catch {
      // A 404 just means it's already gone; refresh either way.
      onRefresh();
    }
  }

  const collectionIds = new Set(voices.map((v) => v.voice_id));

  return (
    <div className="eleven-voice-section">
      <div className="eleven-voice-subtabs">
        {SUB_TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`eleven-subtab${subTab === id ? ' is-active' : ''}`}
            onClick={() => setSubTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {subTab === 'collection' && (
        <div className="eleven-collection">
          {voices.length === 0 && (
            <p className="playground-empty">
              No voices yet — browse the library, clone, or design one.
            </p>
          )}
          {voices.map((v) => (
            <label
              key={v.voice_id}
              className={`eleven-collection-voice${v.voice_id === activeVoiceId ? ' is-selected' : ''}`}
              title={v.description || undefined}
            >
              <input
                type="radio"
                name="eleven-active-voice"
                checked={v.voice_id === activeVoiceId}
                onChange={() => onSelect(v.voice_id)}
              />
              <button
                type="button"
                className="eleven-preview-btn"
                title="Preview"
                disabled={!v.preview_url}
                onClick={(e) => { e.preventDefault(); preview(v.preview_url); }}
              >
                ▶
              </button>
              <span className="eleven-voice-name">
                {SOURCE_GLYPHS[v.source] || ''} {v.name}
              </span>
              <span className="eleven-voice-labels">
                {Object.values(v.labels || {}).filter(Boolean).slice(0, 4).map((l) => (
                  <span key={l} className="eleven-voice-label">{l}</span>
                ))}
              </span>
              <button
                type="button"
                title="Remove from this project's collection (stays in your ElevenLabs account)"
                onClick={(e) => { e.preventDefault(); remove(v.voice_id); }}
              >
                ×
              </button>
            </label>
          ))}
        </div>
      )}

      {subTab === 'browse' && (
        <VoiceLibraryBrowser collectionIds={collectionIds} onAdded={onRefresh} />
      )}

      {subTab === 'clone' && (
        <p className="playground-empty">{/* TASK-7: <VoiceClonePanel> replaces this */}Voice cloning coming soon.</p>
      )}
      {subTab === 'design' && (
        <p className="playground-empty">{/* TASK-7: <VoiceDesignPanel> replaces this */}Voice design coming soon.</p>
      )}
    </div>
  );
}
