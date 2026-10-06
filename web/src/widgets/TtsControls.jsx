// web/src/widgets/TtsControls.jsx
// Pieces shared by the beat Play button and the TOC "Play all" control: the
// model-load label, the Pause/Resume toggle, and the save-as-WAV button.
// (Keeping the downloaded model needs no button: the controller quietly asks
// the browser for persistent storage on every Play — tts/persistStorage.js.)

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
