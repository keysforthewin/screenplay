// web/src/widgets/TtsMiniPlayer.jsx
// The read-aloud player that follows you around the site. Mounted once at the
// app root (outside every route), it shows while the shared TTS controller is
// reading something (tts/nowPlaying.js) and is where playback is paused,
// skipped or stopped from any page.
import { useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { getSharedController } from '../tts/controller.js';
import { getNowPlaying, skipBeat, stopPlayback, subscribeNowPlaying } from '../tts/nowPlaying.js';
import { modelLoadLabel, PauseButton } from './TtsControls.jsx';

export function useNowPlaying() {
  return useSyncExternalStore(subscribeNowPlaying, getNowPlaying);
}

function statusLabel(state) {
  if (state.paused) return 'Paused';
  if (state.status === 'loading') return modelLoadLabel(state);
  if (state.status === 'generating') return 'Generating…';
  if (state.status === 'buffering') return 'Buffering…';
  if (state.status === 'playing') return 'Playing';
  return 'Starting…';
}

export function TtsMiniPlayer() {
  const controller = getSharedController();
  const state = useSyncExternalStore(
    (cb) => controller.subscribe(cb),
    () => controller.getState(),
  );
  const now = useNowPlaying();
  if (!now) return null;

  const title = now.order == null
    ? 'Read-through'
    : `Beat ${now.order}${now.name ? ` · ${now.name}` : ''}`;

  return (
    <div className="tts-mini-player" role="region" aria-label="Read-aloud player">
      <span aria-hidden="true">🔊</span>
      <span className="tts-mini-text">
        {now.order == null
          ? <strong>{title}</strong>
          : <Link to={`/beat/${now.order}`} title="Open this beat"><strong>{title}</strong></Link>}
        <span className="tts-mini-status" title={state.detail || undefined}>{statusLabel(state)}</span>
      </span>
      <PauseButton controller={controller} state={state} />
      {now.kind === 'all' && (
        <button type="button" onClick={skipBeat} title="Skip to the next beat">⏭ Skip</button>
      )}
      <button type="button" onClick={stopPlayback} title="Stop reading">■ Stop</button>
    </div>
  );
}
