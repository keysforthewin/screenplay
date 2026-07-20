// web/src/widgets/PlayBeatButton.jsx
// Play/Stop toggle reading one beat's body aloud via the shared TTS
// controller. Unmount (navigation, beat switch via key={beat._id}) stops
// playback.
import { useEffect, useSyncExternalStore } from 'react';
import { getSharedController } from '../tts/controller.js';
import { getSavedVoice } from '../tts/voices.js';

export function PlayBeatButton({ getText, disabled }) {
  const controller = getSharedController();
  const state = useSyncExternalStore(
    (cb) => controller.subscribe(cb),
    () => controller.getState(),
  );
  useEffect(() => () => controller.stop(), [controller]);

  const busy = state.status !== 'idle' && state.status !== 'error';

  let label = '▶ Play';
  if (state.status === 'loading') {
    label = state.progress != null
      ? `Downloading model… ${Math.round(state.progress * 100)}%`
      : 'Downloading model…';
  } else if (state.status === 'generating') {
    label = '■ Generating…';
  } else if (state.status === 'playing') {
    label = '■ Stop';
  }

  function onClick() {
    if (busy) {
      controller.stop();
      return;
    }
    controller.play(getText(), getSavedVoice());
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled && !busy}
        title="Read the beat body aloud (client-side TTS)"
      >
        {label}
      </button>
      {state.status === 'error' && (
        <span style={{ color: 'var(--danger, #c66)', fontSize: 12 }} title={state.error}>
          TTS unavailable
        </span>
      )}
    </span>
  );
}
