import { attachmentUrl, thumbUrl } from '../api.js';

export function StoryboardItemCollapsed({
  sb,
  onClick,
  dragAttributes,
  dragListeners,
}) {
  const previewText = (sb.summary || '').trim()
    || stripMd(sb.text_prompt || '').slice(0, 160);

  const videoId = sb?.video_file_id
    ? (sb.video_file_id.toString?.() || String(sb.video_file_id))
    : null;
  const hasVideo = !!videoId;

  return (
    <div
      className={`storyboard-item-collapsed ${hasVideo ? 'has-video' : 'no-video'}`}
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
        className="storyboard-drag-handle"
        aria-label="Drag to reorder"
        onClick={(e) => e.stopPropagation()}
        {...dragAttributes}
        {...dragListeners}
      >
        ⋮⋮
      </button>

      {hasVideo ? (
        <div
          className="storyboard-collapsed-video"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <video
            className="storyboard-collapsed-video-el"
            src={attachmentUrl(videoId)}
            controls
            preload="metadata"
            playsInline
          />
        </div>
      ) : (
        <div className="storyboard-collapsed-frames">
          <FramePreview id={sb.start_frame_id} label="Start frame" />
          <span className="storyboard-collapsed-frames-arrow" aria-hidden="true">→</span>
          <FramePreview id={sb.end_frame_id} label="End frame" />
        </div>
      )}

      <div className="storyboard-item-collapsed-summary">
        {previewText
          ? previewText
          : <span className="storyboard-item-collapsed-empty">No prompt yet.</span>}
      </div>
    </div>
  );
}

function FramePreview({ id, label }) {
  if (!id) {
    return (
      <div className="storyboard-collapsed-frame storyboard-collapsed-frame-empty">
        <span>{label}</span>
      </div>
    );
  }
  const sid = id.toString?.() || String(id);
  return (
    <div className="storyboard-collapsed-frame">
      <img
        src={thumbUrl(sid)}
        alt={label}
        loading="lazy"
        className="storyboard-collapsed-frame-img"
      />
    </div>
  );
}

function stripMd(s) {
  return String(s)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
