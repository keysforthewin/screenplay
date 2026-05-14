import { useRef, useState } from 'react';
import { attachmentUrl } from '../api.js';

export function DialogItemCollapsed({
  dialog,
  onClick,
  dragAttributes,
  dragListeners,
}) {
  const speaker = stripMd(dialog.character || '') || '(no speaker)';
  const body = stripMd(dialog.body || '');
  const audioUrl = attachmentUrl(dialog.audio_file_id);

  return (
    <div
      className="dialog-item-collapsed"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.();
        }
      }}
    >
      <button
        type="button"
        className="dialog-drag-handle"
        aria-label="Drag to reorder"
        onClick={(e) => e.stopPropagation()}
        {...dragAttributes}
        {...dragListeners}
      >
        ⋮⋮
      </button>
      {audioUrl && <PlayButton url={audioUrl} />}
      <div className="dialog-item-collapsed-line">
        <span className="dialog-item-collapsed-speaker">{speaker}:</span>{' '}
        {body
          ? <span className="dialog-item-collapsed-body">{body}</span>
          : <span className="dialog-item-collapsed-empty">(empty)</span>}
      </div>
    </div>
  );
}

function PlayButton({ url }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  function toggle(e) {
    e.stopPropagation();
    const el = audioRef.current;
    if (!el) return;
    if (playing) el.pause();
    else el.play();
  }
  return (
    <>
      <button
        type="button"
        className="dialog-item-play"
        onClick={toggle}
        aria-label={playing ? 'Pause audio' : 'Play audio'}
        title={playing ? 'Pause' : 'Play'}
      >
        {playing ? '⏸' : '▶'}
      </button>
      <audio
        ref={audioRef}
        src={url}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    </>
  );
}

function stripMd(s) {
  return String(s)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
