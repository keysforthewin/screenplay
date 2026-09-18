// web/src/widgets/PlayBeatButton.jsx
// Play/Stop toggle reading one beat's body aloud via the shared TTS
// controller. Unmount (navigation, beat switch via key={beat._id}) stops
// playback.
import { useEffect, useSyncExternalStore } from 'react';
import { getSharedController } from '../tts/controller.js';
import { getSavedVoice } from '../tts/voices.js';
import { modelLoadLabel, KeepModelButton, PauseButton, SaveAudioButton } from './TtsControls.jsx';

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
    label = modelLoadLabel(state);
  } else if (state.status === 'generating') {
    label = '■ Generating…';
  } else if (state.status === 'buffering') {
    label = '■ Buffering…';
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
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled && !busy}
        title="Read the beat body aloud (client-side TTS)"
      >
        {label}
      </button>
      <PauseButton controller={controller} state={state} />
      <KeepModelButton controller={controller} state={state} />
      {!busy && <SaveAudioButton controller={controller} state={state} filename="beat.wav" />}
      {busy && state.detail && (
        <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>{state.detail}</span>
      )}
      {state.status === 'error' && (
        <span style={{ color: 'var(--danger, #c66)', fontSize: 12 }}>
          TTS failed: {state.error}
        </span>
      )}
    </span>
  );
}
