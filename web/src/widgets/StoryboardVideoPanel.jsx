import { attachmentUrl } from '../api.js';
import { formatUsd } from '../videoCost.js';

// Inline video player for a storyboard scene. Renders below the Audio
// section when sb.video_file_id is set. Falls back to nothing when there's
// no video — the entry-point button lives in AudioSlot's extraActions. The
// Discard video control lives in the storyboard item footer (alongside the
// item's Delete button) so the two destructive actions stay co-located.
export function StoryboardVideoPanel({ sb }) {
  if (!sb?.video_file_id) return null;

  const id = sb.video_file_id?.toString?.() || String(sb.video_file_id);
  const src = attachmentUrl(id);

  const modelLabel = sb.video_model_label || sb.video_model_id || null;
  const labLine = buildLabLine({
    label: modelLabel,
    lab: sb.video_model_lab,
    addedAt: sb.video_model_added_at,
  });
  const falEndpoint = sb.video_fal_model || null;
  const paramLine = buildParamLine(sb);

  return (
    <div className="storyboard-video" style={{ marginBottom: 12 }}>
      <div className="storyboard-frame-label">Generated video</div>
      <video
        controls
        src={src}
        preload="metadata"
        style={{
          width: '100%',
          maxHeight: 360,
          background: '#000',
          borderRadius: 4,
          marginTop: 4,
        }}
      />
      <div
        style={{
          marginTop: 4,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          fontSize: 12,
          color: 'var(--fg-muted)',
        }}
      >
        {labLine ? (
          <div title={sb.video_model_id || undefined}>{labLine}</div>
        ) : null}
        {falEndpoint ? (
          <div style={{ fontFamily: 'monospace', fontSize: 11 }}>{falEndpoint}</div>
        ) : null}
        {paramLine ? <div>{paramLine}</div> : null}
      </div>
    </div>
  );
}

function buildLabLine({ label, lab, addedAt }) {
  const parts = [];
  if (label) parts.push(label);
  if (lab) parts.push(lab);
  const dateLabel = formatAddedAt(addedAt);
  if (dateLabel) parts.push(`added ${dateLabel}`);
  return parts.length ? parts.join(' · ') : null;
}

function buildParamLine(sb) {
  const parts = [];
  const params = (sb && typeof sb.video_parameters === 'object') ? sb.video_parameters : null;
  const dur =
    (params && Number.isFinite(Number(params.duration_seconds))
      ? Number(params.duration_seconds)
      : null) ?? sb?.video_duration_seconds ?? null;
  if (dur) parts.push(`${dur}s`);
  const res = params?.resolution || params?.video_size;
  if (res && res !== 'auto') parts.push(String(res));
  const ar = params?.aspect_ratio;
  if (ar && ar !== 'auto') parts.push(String(ar));
  if (typeof params?.generate_audio === 'boolean') {
    parts.push(params.generate_audio ? 'audio on' : 'audio off');
  }
  const cost = typeof sb?.video_cost_usd === 'number' ? sb.video_cost_usd : null;
  if (cost != null) {
    const lbl = formatUsd(cost);
    if (lbl) parts.push(lbl);
  }
  return parts.length ? parts.join(' · ') : null;
}

function formatAddedAt(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
