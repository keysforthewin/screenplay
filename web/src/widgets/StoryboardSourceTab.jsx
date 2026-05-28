import { useEffect, useMemo, useState } from 'react';
import { apiGet, attachmentUrl, thumbUrl } from '../api.js';

// "Storyboard" tab body for the Add Video dialog. Lists every reusable source
// video in the project — generated clips on any shot (sb.video_file_id,
// including this shot's own, for video-to-video iteration) AND video
// references uploaded to any beat or character. Each row carries a
// `video_file_id` (attachments-bucket GridFS id) used both to render a real
// <video> thumbnail and to pick it: `onPick(video_file_id)` feeds the existing
// /video-upload/from-attachment endpoint, which copies the bytes.
export function StoryboardSourceTab({ storyboardId, busy, onPick }) {
  const [sources, setSources] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (!storyboardId) return undefined;
    let cancelled = false;
    setSources(null);
    setLoadError(null);
    (async () => {
      try {
        const r = await apiGet(
          `/storyboard/${storyboardId}/video-source-storyboards`,
        );
        if (!cancelled) setSources(r?.sources || []);
      } catch (e) {
        if (!cancelled) setLoadError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storyboardId]);

  const filtered = useMemo(() => {
    if (!sources) return null;
    const needle = q.trim().toLowerCase();
    if (!needle) return sources;
    return sources.filter((s) => {
      return (
        (s.beat_name || '').toLowerCase().includes(needle) ||
        (s.summary || '').toLowerCase().includes(needle) ||
        (s.video_model_label || '').toLowerCase().includes(needle) ||
        (s.filename || '').toLowerCase().includes(needle) ||
        (s.owner_name || '').toLowerCase().includes(needle)
      );
    });
  }, [sources, q]);

  if (loadError) {
    return <div className="error-banner small">{loadError}</div>;
  }
  if (sources === null) {
    return <p className="ref-picker-empty">Loading…</p>;
  }
  if (sources.length === 0) {
    return (
      <p className="ref-picker-empty">
        No reusable videos yet. Generate a video on a shot, or upload one to a
        beat or character, to see it here.
      </p>
    );
  }

  return (
    <div>
      <input
        type="search"
        className="ref-picker-search"
        placeholder="Filter by beat, summary, model, filename…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {filtered.length === 0 ? (
        <p className="ref-picker-empty">No matches.</p>
      ) : (
        <div className="ref-picker-attachment-list">
          {filtered.map((s) => {
            const videoId =
              s.video_file_id?.toString?.() || String(s.video_file_id);
            const posterId =
              s.kind === 'generated'
                ? s.start_frame_id || s.end_frame_id
                : null;
            const { title, subtitle, extra } = describeSource(s);
            return (
              <button
                key={`${s.kind}:${videoId}`}
                type="button"
                className="ref-picker-attachment-item"
                disabled={busy}
                onClick={() => onPick(videoId)}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 80,
                    height: 45,
                    flexShrink: 0,
                    background: '#000',
                    borderRadius: 2,
                    overflow: 'hidden',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <video
                    src={`${attachmentUrl(videoId)}#t=0.1`}
                    poster={posterId ? thumbUrl(posterId) : undefined}
                    muted
                    playsInline
                    preload="metadata"
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                    }}
                  />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {title}
                  </div>
                  <div
                    style={{
                      color: 'var(--fg-muted)',
                      fontSize: '0.85em',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {subtitle}
                  </div>
                  {extra && (
                    <div
                      style={{
                        color: 'var(--fg-muted)',
                        fontSize: '0.85em',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {extra}
                    </div>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Map a merged source row to its display strings, branching on kind.
function describeSource(s) {
  if (s.kind === 'reference') {
    const ownerLabel =
      s.owner_type === 'beat'
        ? s.owner_order != null
          ? `Beat ${s.owner_order} · ${s.owner_name}`
          : s.owner_name
        : `Character · ${s.owner_name}`;
    const size = formatSize(s.size);
    return {
      title: s.filename || '(unnamed)',
      subtitle: [ownerLabel, size].filter(Boolean).join(' · '),
      extra: null,
    };
  }
  // generated
  const beatLabel =
    s.beat_order != null ? `Beat ${s.beat_order} · ${s.beat_name}` : s.beat_name;
  const shotLabel =
    s.storyboard_order != null ? `Shot #${s.storyboard_order}` : 'Shot';
  const title = s.is_current_shot
    ? `${beatLabel} · ${shotLabel} · This shot`
    : `${beatLabel} · ${shotLabel}`;
  const dur =
    s.video_duration_seconds != null
      ? `${Number(s.video_duration_seconds).toFixed(1)}s`
      : null;
  const model = s.video_model_label || null;
  return {
    title,
    subtitle:
      [dur, model].filter(Boolean).join(' · ') || 'generated video',
    extra: s.summary || null,
  };
}

function formatSize(bytes) {
  if (!bytes || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
