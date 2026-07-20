// web/src/widgets/PlayAllButton.jsx
// "Play all" control for the TOC Beats tab: reads every beat in order via
// startPlayAll. The beat list is snapshotted (and empty bodies dropped) when
// Play is clicked. Unmount (navigating away from the TOC) stops the run.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { apiGet } from '../api.js';
import { getSharedController } from '../tts/controller.js';
import { getSavedVoice } from '../tts/voices.js';
import { markdownToText } from '../tts/markdownToText.js';
import { startPlayAll } from '../tts/playAll.js';
import { VoiceSelect } from './VoiceSelect.jsx';

export function PlayAllButton({ beats, onBeatChange }) {
  const controller = getSharedController();
  const state = useSyncExternalStore(
    (cb) => controller.subscribe(cb),
    () => controller.getState(),
  );
  const runRef = useRef(null);
  const [running, setRunning] = useState(false);
  useEffect(() => () => runRef.current?.stop(), []);

  function onPlayAll() {
    if (running) {
      runRef.current?.stop();
      return;
    }
    const items = [...(beats || [])]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .filter((b) => !b.body_empty)
      .map((b) => ({ order: b.order, name: b.plain_name || b.name || 'Untitled' }));
    if (!items.length) return;
    const run = startPlayAll({
      items,
      fetchBody: async (order) => (await apiGet(`/beat?order=${order}`)).beat?.body || '',
      controller,
      voice: getSavedVoice(),
      toText: markdownToText,
      onBeat: (order) => onBeatChange?.(order),
    });
    runRef.current = run;
    setRunning(true);
    run.promise.finally(() => {
      runRef.current = null;
      setRunning(false);
      onBeatChange?.(null);
    });
  }

  let label = running ? '■ Stop' : '▶ Play all';
  if (running && state.status === 'loading') {
    label = state.progress != null
      ? `Downloading model… ${Math.round(state.progress * 100)}%`
      : 'Downloading model…';
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <VoiceSelect />
      <button type="button" onClick={onPlayAll} title="Read every beat aloud in order (client-side TTS)">
        {label}
      </button>
      {running && (
        <button type="button" onClick={() => runRef.current?.skip()} title="Skip to the next beat">
          ⏭ Skip
        </button>
      )}
      {state.status === 'error' && (
        <span style={{ color: 'var(--danger, #c66)', fontSize: 12 }} title={state.error}>
          TTS unavailable
        </span>
      )}
    </span>
  );
}
