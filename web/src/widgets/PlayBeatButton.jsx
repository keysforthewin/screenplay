// web/src/widgets/PlayBeatButton.jsx
// Play/Stop toggle reading one beat's body aloud via the shared TTS
// controller. Playback belongs to the tab (tts/nowPlaying.js): leaving the
// page does not stop it — the site-wide mini player (TtsMiniPlayer.jsx) keeps
// the controls. This button shows Stop only while THIS beat is the one
// playing; pressing Play while something else reads replaces it.
import { useSyncExternalStore } from 'react';
import { getSharedController } from '../tts/controller.js';
import { playBeat, stopPlayback } from '../tts/nowPlaying.js';
import { useNowPlaying } from './TtsMiniPlayer.jsx';
import { modelLoadLabel, SaveAudioButton } from './TtsControls.jsx';

export function PlayBeatButton({ order, name, getText, disabled }) {
  const controller = getSharedController();
  const state = useSyncExternalStore(
    (cb) => controller.subscribe(cb),
    () => controller.getState(),
  );
  const now = useNowPlaying();
  const mine = now?.kind === 'beat' && now.order === order;
  const busy = mine && state.status !== 'idle' && state.status !== 'error';

  let label = '▶ Play';
  if (busy) {
    if (state.status === 'loading') label = modelLoadLabel(state);
    else if (state.status === 'generating') label = '■ Generating…';
    else if (state.status === 'buffering') label = '■ Buffering…';
    else label = '■ Stop';
  }

  function onClick() {
    if (busy) {
      stopPlayback();
      return;
    }
    playBeat({ order, name, text: getText() });
  }

  // One compact, never-wrapping group: Pause and the progress detail live in
  // the mini player while this beat reads.
  return (
    <span className="play-beat">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled && !busy}
        title="Read the beat body aloud (client-side TTS) — keeps playing while you move around the site"
      >
        {label}
      </button>
      {!now && <SaveAudioButton controller={controller} state={state} filename="beat.wav" />}
      {!now && state.status === 'error' && (
        <span style={{ color: 'var(--danger, #c66)', fontSize: 12 }} title={state.error || undefined}>
          TTS failed
        </span>
      )}
    </span>
  );
}
