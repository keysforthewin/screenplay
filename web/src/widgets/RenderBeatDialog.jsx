// "Render beat" — the review gate before spending on video. Picks the three
// models the renderer may use (lip-sync, direct reference-to-video, start-
// frame), shows the server's per-shot plan (mode, model, auto-still, length,
// cost, warnings) plus the dialogue-coverage audit, and submits.
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPostJson } from '../api.js';
import { Modal } from './Modal.jsx';
import { formatUsd } from '../videoCost.js';

const SLOTS = [
  {
    key: 'lipsync',
    label: 'Lip-sync model',
    help: 'Shots whose covered lines are all recorded. The recordings are joined and drive the mouth.',
    accepts: (caps) => caps?.lip_sync === true,
  },
  {
    key: 'video_direct',
    label: 'Direct model (prompt + references)',
    help: 'Everything else, straight from the shot prompt and its matched reference images. Leave unset to render a still first.',
    accepts: (caps) => caps?.reference_images === true,
    allowNone: true,
  },
  {
    key: 'video_start_only',
    label: 'Start-frame model',
    help: 'Used when no direct model is set: the shot still (rendered automatically if missing) is animated.',
    accepts: (caps) => caps?.start_frame === true,
  },
];

const MODE_LABEL = { lipsync: 'lip-sync', direct: 'direct', start_only: 'from still' };

export function RenderBeatDialog({ open, onClose, beatId, onSubmit }) {
  const [models, setModels] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [skipRendered, setSkipRendered] = useState(true);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setPreview(null);
    setPreviewError(null);
    setOverrides({});
    (async () => {
      try {
        const [v, d] = await Promise.all([apiGet('/video-models'), apiGet('/model-defaults')]);
        if (cancelled) return;
        setModels(Array.isArray(v?.models) ? v.models : []);
        setDefaults(d?.model_defaults || {});
      } catch (e) {
        if (!cancelled) setPreviewError(e.message || 'Failed to load models.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Server-side plan whenever the inputs change.
  useEffect(() => {
    if (!open || !beatId || defaults === null) return undefined;
    const id = ++reqRef.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await apiPostJson(`/beat/${beatId}/render/preview`, { overrides, skip_rendered: skipRendered });
        if (reqRef.current !== id) return;
        setPreview(r);
        setPreviewError(null);
      } catch (e) {
        if (reqRef.current !== id) return;
        setPreviewError(e.message || 'Preview failed.');
      } finally {
        if (reqRef.current === id) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [open, beatId, defaults, overrides, skipRendered]);

  const shots = preview?.shots || [];
  const toRender = preview?.counts?.to_render || 0;
  const canRender = Boolean(preview) && !loading && preview.fal_configured !== false && (toRender > 0 || preview.will_assemble);
  const total = formatUsd(preview?.total_estimated_cost_usd);
  const coverageWarnings = (preview?.coverage?.checks || []).filter((c) => c.severity === 'warn');

  return (
    <Modal
      open={open}
      title="Render beat"
      onClose={onClose}
      dismissible
      size="xl"
      footer={
        <>
          <button type="button" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="primary"
            disabled={!canRender}
            onClick={() => onSubmit?.({ overrides, skipRendered })}
            title={!preview ? 'Waiting for the plan…' : toRender === 0 && !preview.will_assemble ? 'Nothing to render' : ''}
          >
            {toRender > 0
              ? `Render ${toRender} shot${toRender === 1 ? '' : 's'}${total ? ` · ~${total}` : ''}`
              : preview?.will_assemble
                ? 'Assemble beat video'
                : 'Render'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p className="modal-help" style={{ margin: 0 }}>
          Each shot becomes a clip from its prompt. Shots whose dialogue lines are all recorded are
          lip-synced to those recordings; the rest go straight to the direct model, or through an
          auto-rendered still when a start frame is needed. When every shot has a clip they are joined
          into one beat video.
        </p>
        {preview && preview.fal_configured === false && (
          <div className="error-banner">fal.ai is not configured on the server (FAL_KEY).</div>
        )}
        {previewError && <div className="error-banner">{previewError}</div>}

        <div className="render-beat-models">
          {SLOTS.map((slot) => (
            <ModelSlotSelect
              key={slot.key}
              slot={slot}
              models={models}
              defaultId={defaults?.[slot.key] || null}
              value={overrides[slot.key] ?? null}
              onChange={(v) =>
                setOverrides((prev) => {
                  const next = { ...prev };
                  if (v == null) delete next[slot.key];
                  else next[slot.key] = v;
                  return next;
                })
              }
            />
          ))}
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={skipRendered} onChange={(e) => setSkipRendered(e.target.checked)} />
          <span className="modal-help" style={{ margin: 0 }}>Skip shots that already have a clip</span>
        </label>

        {coverageWarnings.length > 0 && (
          <div className="render-beat-coverage">
            <strong>Dialogue coverage:</strong>{' '}
            {coverageWarnings.map((c) => c.message).join(' · ')}
          </div>
        )}

        <div className="render-beat-table-wrap">
          {loading && !preview ? (
            <p className="modal-help" style={{ margin: 0 }}>Planning…</p>
          ) : shots.length === 0 ? (
            <p className="modal-help" style={{ margin: 0 }}>No shots — plan the beat first.</p>
          ) : (
            <table className="render-beat-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Mode</th>
                  <th>Model</th>
                  <th>Lines</th>
                  <th>Length</th>
                  <th>Cost</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {shots.map((s) => (
                  <tr key={s.storyboard_id} className={s.skipped ? 'is-skipped' : s.status === 'blocked' ? 'is-blocked' : ''}>
                    <td>{s.order + 1}</td>
                    <td>
                      {s.skipped ? `skipped (${s.skip_reason})` : MODE_LABEL[s.mode] || s.mode}
                      {s.auto_keyframe && <span className="render-beat-badge" title="A still is rendered first because this model needs a start frame">+ still</span>}
                    </td>
                    <td title={s.fal_model || ''}>{s.skipped ? '' : s.model_label || s.model_id || '—'}</td>
                    <td>
                      {s.covered_lines
                        ? `${s.recorded_lines}/${s.covered_lines} rec.`
                        : '—'}
                    </td>
                    <td>{s.skipped ? '' : s.duration_seconds ? `${s.duration_seconds}s` : '—'}</td>
                    <td>{s.skipped ? '' : formatUsd(s.estimated_cost_usd) || '—'}</td>
                    <td className="render-beat-notes">
                      {(s.warnings || []).map((w, i) => <div key={i}>{w}</div>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {preview && (
          <div className="render-beat-summary">
            <span>{toRender} to render</span>
            {preview.counts.skipped > 0 && <span>{preview.counts.skipped} skipped</span>}
            {preview.counts.blocked > 0 && <span className="is-blocked">{preview.counts.blocked} blocked</span>}
            {preview.counts.auto_keyframes > 0 && <span>{preview.counts.auto_keyframes} still{preview.counts.auto_keyframes === 1 ? '' : 's'} to render first</span>}
            <span>{preview.will_assemble ? 'beat video will be assembled' : 'beat video will NOT be assembled (some shots have no clip)'}</span>
            {total && <span>total ≈ {total}</span>}
          </div>
        )}
      </div>
    </Modal>
  );
}

function ModelSlotSelect({ slot, models, defaultId, value, onChange }) {
  const options = useMemo(
    () => (models || [])
      .filter((m) => m.is_registered && slot.accepts(m.capabilities))
      .sort((a, b) => String(a.display_name || a.endpoint_id).localeCompare(String(b.display_name || b.endpoint_id))),
    [models, slot],
  );
  const defaultLabel = defaultId
    ? (options.find((m) => m.endpoint_id === defaultId)?.display_name || defaultId)
    : slot.allowNone ? 'none (render a still first)' : 'server default';
  // '' = use the project default; '__none__' = force none (direct slot only).
  const selectValue = value === null ? '' : value;
  return (
    <div className="field-block">
      <label className="field-label">{slot.label}</label>
      <select
        value={selectValue}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        style={{ width: '100%' }}
      >
        <option value="">Project default — {defaultLabel}</option>
        {options.map((m) => (
          <option key={m.endpoint_id} value={m.endpoint_id}>{m.display_name || m.endpoint_id}</option>
        ))}
      </select>
      <p style={{ color: 'var(--fg-muted)', fontSize: 12, margin: '4px 0 0' }}>{slot.help}</p>
    </div>
  );
}
