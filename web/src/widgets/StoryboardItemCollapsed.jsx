import { attachmentUrl, thumbUrl } from '../api.js';

export function StoryboardItemCollapsed({
  sb,
  onClick,
  dragAttributes,
  dragListeners,
}) {
  const previewText = (sb.summary || '').trim()
    || stripMd(sb.text_prompt || '').slice(0, 160);

  // Precedence: generated video first (the "final" artifact), then the
  // user's uploaded source video (only material thing on the row), then a
  // strip of frame-pool thumbs. We never show both videos — the generated one
  // always wins when present.
  const frames = Array.isArray(sb?.frames) ? sb.frames : [];
  const generatedVideoId = sb?.video_file_id
    ? (sb.video_file_id.toString?.() || String(sb.video_file_id))
    : null;
  const uploadedVideoId = sb?.video_upload_file_id
    ? (sb.video_upload_file_id.toString?.() || String(sb.video_upload_file_id))
    : null;
  const previewVideoId = generatedVideoId || uploadedVideoId;
  const hasVideo = !!previewVideoId;

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
          className={
            'storyboard-collapsed-video' +
            (generatedVideoId ? ' is-generated' : ' is-uploaded')
          }
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <video
            className="storyboard-collapsed-video-el"
            src={attachmentUrl(previewVideoId)}
            controls
            preload="metadata"
            playsInline
          />
        </div>
      ) : (
        <div className="storyboard-collapsed-frames">
          {frames.length ? (
            frames.map((f, i) => (
              <FramePreview
                key={f._id?.toString?.() || i}
                id={f.image_id}
                label={`Frame ${i + 1}`}
              />
            ))
          ) : (
            <FramePreview id={null} label="No frames" />
          )}
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
