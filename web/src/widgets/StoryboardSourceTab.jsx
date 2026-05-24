import { useEffect, useMemo, useState } from 'react';
import { apiGet, thumbUrl } from '../api.js';

// "Storyboard" tab body for the Add Video dialog. Lists every other
// storyboard in the project that has a generated video (sb.video_file_id),
// so the user can reuse one of those clips as the source video for
// video-to-video on this shot. Picking an item invokes
// `onPick(video_file_id)` — the parent feeds that to the existing
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
        (s.video_model_label || '').toLowerCase().includes(needle)
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
        No other storyboards have generated video yet. Generate a video on
        another shot first to reuse it here.
      </p>
    );
  }

  return (
    <div>
      <input
        type="search"
        className="ref-picker-search"
        placeholder="Filter by beat, summary, or model…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {filtered.length === 0 ? (
        <p className="ref-picker-empty">No matches.</p>
      ) : (
        <div className="ref-picker-attachment-list">
          {filtered.map((s) => {
            const id =
              s.storyboard_id?.toString?.() || String(s.storyboard_id);
            const videoId =
              s.video_file_id?.toString?.() || String(s.video_file_id);
            const thumbId = s.start_frame_id || s.end_frame_id;
            const thumb = thumbId ? thumbUrl(thumbId) : null;
            const beatLabel =
              s.beat_order != null
                ? `Beat ${s.beat_order} · ${s.beat_name}`
                : s.beat_name;
            const shotLabel =
              s.storyboard_order != null ? `Shot #${s.storyboard_order}` : 'Shot';
            const dur =
              s.video_duration_seconds != null
                ? `${Number(s.video_duration_seconds).toFixed(1)}s`
                : null;
            const model = s.video_model_label || null;
            const summary = s.summary || '';
            return (
              <button
                key={id}
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
                  {thumb ? (
                    <img
                      src={thumb}
                      alt=""
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                      }}
                    />
                  ) : (
                    <span style={{ fontSize: 22 }}>🎬</span>
                  )}
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
                    {beatLabel} · {shotLabel}
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
                    {[dur, model].filter(Boolean).join(' · ') ||
                      'generated video'}
                  </div>
                  {summary && (
                    <div
                      style={{
                        color: 'var(--fg-muted)',
                        fontSize: '0.85em',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {summary}
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
