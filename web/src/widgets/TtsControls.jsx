// web/src/widgets/TtsControls.jsx
// Pieces shared by the beat Play button and the TOC "Play all" control: the
// model-load label, the Pause/Resume toggle, and the save-as-WAV button.

import { useState } from 'react';
import { pinStorage } from '../tts/persistStorage.js';

// Shown only while the browser refuses persistent storage: without it the
// cached model is evictable and would have to be downloaded again.
export function KeepModelButton({ controller, state }) {
  const [refused, setRefused] = useState(false);
  if (state.persisted !== false) return null;
  async function keep() {
    const ok = await pinStorage();
    controller.setPersisted(ok);
    setRefused(!ok);
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg-muted)' }}>
      <button
        type="button"
        onClick={keep}
        title="Ask the browser to never evict the downloaded voice model (it may ask for notification permission — that is what unlocks persistent storage in Chrome)"
      >
        📌 Keep model
      </button>
      {refused
        ? 'Browser refused — bookmark this site (or allow notifications), then click again.'
        : 'The browser may evict the 326MB model and re-download it.'}
    </span>
  );
}

export function modelLoadLabel(state) {
  if (state.status !== 'loading') return null;
  const verb = state.progressCached ? 'Loading cached model…' : 'Downloading model…';
  return state.progress != null ? `${verb} ${Math.round(state.progress * 100)}%` : verb;
}

export function PauseButton({ controller, state }) {
  const active = state.status !== 'idle' && state.status !== 'error';
  if (!active) return null;
  return (
    <button
      type="button"
      onClick={() => (state.paused ? controller.resume() : controller.pause())}
      title={state.paused ? 'Resume playback' : 'Pause playback (synthesis keeps buffering)'}
    >
      {state.paused ? '▶ Resume' : '⏸ Pause'}
    </button>
  );
}

export function SaveAudioButton({ controller, state, filename = 'read-through.wav' }) {
  if (!state.canSave) return null;
  function save() {
    const blob = controller.getRecordingBlob();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return (
    <button type="button" onClick={save} title="Save the last finished read-through as a WAV file">
      ⬇ Save audio
    </button>
  );
}
