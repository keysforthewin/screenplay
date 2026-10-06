// web/src/widgets/PlayAllButton.jsx
// "Play all" control for the TOC Beats tab: reads every beat in order via
// startPlayAll. The beat list is snapshotted (and empty bodies dropped) when
// Play is clicked. The run belongs to the tab (tts/nowPlaying.js): navigating
// away from the TOC leaves it reading, with the site-wide mini player
// (TtsMiniPlayer.jsx) keeping the controls.
import { useSyncExternalStore } from 'react';
import { apiGet } from '../api.js';
import { getSharedController } from '../tts/controller.js';
import { markdownToText } from '../tts/markdownToText.js';
import { playAllBeats, skipBeat, stopPlayback } from '../tts/nowPlaying.js';
import { useNowPlaying } from './TtsMiniPlayer.jsx';
import { modelLoadLabel, PauseButton } from './TtsControls.jsx';

export function PlayAllButton({ beats }) {
  const controller = getSharedController();
  const state = useSyncExternalStore(
    (cb) => controller.subscribe(cb),
    () => controller.getState(),
  );
  const running = useNowPlaying()?.kind === 'all';

  function onPlayAll() {
    if (running) {
      stopPlayback();
      return;
    }
    const items = [...(beats || [])]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .filter((b) => !b.body_empty)
      .map((b) => ({ order: b.order, name: b.plain_name || b.name || 'Untitled' }));
    if (!items.length) return;
    playAllBeats({
      items,
      fetchBody: async (order) => (await apiGet(`/beat?order=${order}`)).beat?.body || '',
      toText: markdownToText,
    });
  }

  let label = running ? '■ Stop' : '▶ Play all';
  if (running && state.status === 'loading') label = modelLoadLabel(state);

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button type="button" onClick={onPlayAll} title="Read every beat aloud in order (client-side TTS) — keeps playing while you move around the site">
        {label}
      </button>
      {running && <PauseButton controller={controller} state={state} />}
      {running && (
        <button type="button" onClick={skipBeat} title="Skip to the next beat">
          ⏭ Skip
        </button>
      )}
      {running && state.status !== 'error' && state.detail && (
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
