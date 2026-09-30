// "Render beat" on the Prompts tab — the review gate before spending GPU
// time or credits. Picks the provider (ComfyUI or fal.ai) and the two models
// the renderer may use (clip, lip-sync), shows the server's per-cut plan
// (mode, model, auto start frame, length, cost, warnings) and submits. No
// per-model parameter editing here: ComfyUI params come from what the
// per-cut dialog last saved for each model.
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPostJson } from '../api.js';
import { Modal } from './Modal.jsx';
import { formatUsd } from '../videoCost.js';
import { ComfyModelSelect, COMFY_DISABLED_MESSAGE } from './comfyControls.jsx';

const MODE_LABEL = { lipsync: 'lip-sync', clip: 'clip' };

function parseError(e) {
  let msg = e?.message || 'Request failed.';
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.error) msg = parsed.error;
  } catch {}
  return msg;
}

export function RenderCutsDialog({ open, onClose, beatId, onSubmit }) {
  const [comfy, setComfy] = useState(null); // GET /comfy/models
  const [falModels, setFalModels] = useState(null);
  const [falDefaults, setFalDefaults] = useState(null);
  const [provider, setProvider] = useState(null);
  const [models, setModels] = useState({});
  const [skipRendered, setSkipRendered] = useState(true);
  const [consent, setConsent] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setPreview(null);
    setPreviewError(null);
    setModels({});
    setConsent(false);
    (async () => {
      try {
        const [c, v, d] = await Promise.all([
          apiGet('/comfy/models').catch(() => ({ configured: false, models: [] })),
          apiGet('/video-models').catch(() => ({ models: [] })),
          apiGet('/model-defaults').catch(() => ({ model_defaults: {} })),
        ]);
        if (cancelled) return;
        setComfy(c);
        setFalModels(Array.isArray(v?.models) ? v.models : []);
        setFalDefaults(d?.model_defaults || {});
        setProvider(c?.configured ? 'comfy' : 'fal');
      } catch (e) {
        if (!cancelled) setPreviewError(parseError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reset the model picks when the provider flips — ids are not shared.
  useEffect(() => {
    setModels({});
    setConsent(false);
  }, [provider]);

  useEffect(() => {
    if (!open || !beatId || !provider) return undefined;
    const id = ++reqRef.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await apiPostJson('/cuts/render/preview', { beat_id: beatId, provider, models, skip_rendered: skipRendered });
        if (reqRef.current !== id) return;
        setPreview(r);
        setPreviewError(null);
      } catch (e) {
        if (reqRef.current !== id) return;
        setPreviewError(parseError(e));
      } finally {
        if (reqRef.current === id) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [open, beatId, provider, models, skipRendered]);

  const cuts = preview?.cuts || [];
  const toRender = preview?.counts?.to_render || 0;
  const comfyConfigured = Boolean(comfy?.configured);
  const providerReady = provider === 'comfy' ? comfyConfigured : preview?.fal_configured !== false;
  const needsConsent = provider === 'comfy' && Boolean(preview?.spends_credits);
  const canRender = Boolean(preview) && !loading && providerReady && (toRender > 0 || preview.will_assemble) && (!needsConsent || consent);
  const total = formatUsd(preview?.total_estimated_cost_usd);

  const falOptions = useMemo(() => (falModels || []).filter((m) => m.is_registered), [falModels]);
  const falLipsync = falOptions.filter((m) => m.capabilities?.lip_sync === true);
  const falClip = falOptions.filter((m) => m.capabilities?.start_frame === true);

  return (
    <Modal
      open={open}
      title="Render beat (Prompts tab)"
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
            onClick={() => onSubmit?.({ provider, models, skipRendered, confirmSpend: consent })}
            title={!preview ? 'Waiting for the plan…' : toRender === 0 && !preview.will_assemble ? 'Nothing to render' : needsConsent && !consent ? 'Confirm the credit spend first' : ''}
          >
            {toRender > 0
              ? `Render ${toRender} cut${toRender === 1 ? '' : 's'}${total ? ` · ~${total}` : ''}`
              : preview?.will_assemble
                ? 'Assemble beat video'
                : 'Render'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p className="modal-help" style={{ margin: 0 }}>
          Each cut becomes a clip from its block and start frame (rendered first when missing). Cuts whose
          dialogue lines are all recorded are lip-synced to those recordings. When every cut has a clip
          they are joined into the beat video.
        </p>
        {previewError && <div className="error-banner">{previewError}</div>}

        <div className="field-block">
          <label className="field-label">Provider</label>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: comfyConfigured ? 1 : 0.6 }} title={comfyConfigured ? '' : COMFY_DISABLED_MESSAGE}>
              <input type="radio" name="cut-render-provider" value="comfy" disabled={!comfyConfigured} checked={provider === 'comfy'} onChange={() => setProvider('comfy')} />
              ComfyUI{comfyConfigured ? '' : ' — disabled on this server'}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="radio" name="cut-render-provider" value="fal" checked={provider === 'fal'} onChange={() => setProvider('fal')} />
              fal.ai
            </label>
          </div>
        </div>

        {provider === 'comfy' ? (
          <div className="render-beat-models">
            <div className="field-block">
              <label className="field-label">Clip model</label>
              <ComfyModelSelect
                models={comfy?.models}
                value={models.clip ?? null}
                onChange={(v) => setModels((p) => ({ ...p, clip: v || undefined }))}
                filter={(m) => m.inputs?.audio !== 'required'}
                placeholder={`Project default — ${preview?.models?.clip?.label || comfy?.defaults?.model_id || 'LTX-2.5'}`}
              />
              <p style={{ color: 'var(--fg-muted)', fontSize: 12, margin: '4px 0 0' }}>Cuts without fully recorded dialogue: start frame + block → clip. Params are the ones last saved for the model in the per-cut dialog.</p>
            </div>
            <div className="field-block">
              <label className="field-label">Lip-sync model</label>
              <ComfyModelSelect
                models={comfy?.models}
                value={models.lipsync ?? null}
                onChange={(v) => setModels((p) => ({ ...p, lipsync: v || undefined }))}
                filter={(m) => m.inputs?.audio === 'required'}
                placeholder={`Default — ${preview?.models?.lipsync?.label || 'LTX-2.3 lip-sync'}`}
              />
              <p style={{ color: 'var(--fg-muted)', fontSize: 12, margin: '4px 0 0' }}>Cuts whose covered lines are all recorded: the recordings are joined and drive the mouth.</p>
            </div>
          </div>
        ) : (
          <div className="render-beat-models">
            <FalSlot
              label="Clip model (start frame → video)"
              help="Cuts without fully recorded dialogue. The start frame is rendered first when missing."
              options={falClip}
              defaultId={falDefaults?.video_start_only || null}
              value={models.clip ?? null}
              onChange={(v) => setModels((p) => ({ ...p, clip: v || undefined }))}
            />
            <FalSlot
              label="Lip-sync model"
              help="Cuts whose covered lines are all recorded."
              options={falLipsync}
              defaultId={falDefaults?.lipsync || null}
              value={models.lipsync ?? null}
              onChange={(v) => setModels((p) => ({ ...p, lipsync: v || undefined }))}
            />
            {preview && preview.fal_configured === false && (
              <div className="error-banner">fal.ai is not configured on the server (FAL_KEY).</div>
            )}
          </div>
        )}

        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={skipRendered} onChange={(e) => setSkipRendered(e.target.checked)} />
          <span className="modal-help" style={{ margin: 0 }}>Skip cuts that already have a clip</span>
        </label>

        <div className="render-beat-table-wrap">
          {loading && !preview ? (
            <p className="modal-help" style={{ margin: 0 }}>Planning…</p>
          ) : cuts.length === 0 ? (
            <p className="modal-help" style={{ margin: 0 }}>No cuts — plan the beat first.</p>
          ) : (
            <table className="render-beat-table">
              <thead>
                <tr>
                  <th>Cut</th>
                  <th>Mode</th>
                  <th>Model</th>
                  <th>Lines</th>
                  <th>Length</th>
                  {provider === 'fal' ? <th>Cost</th> : null}
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {cuts.map((c) => (
                  <tr key={c.cut_id} className={c.skipped ? 'is-skipped' : c.status === 'blocked' ? 'is-blocked' : ''}>
                    <td>{c.label}{c.title ? <span style={{ color: 'var(--fg-muted)' }}> · {c.title}</span> : null}</td>
                    <td>
                      {c.skipped ? `skipped (${c.skip_reason})` : MODE_LABEL[c.mode] || c.mode}
                      {c.auto_start_frame && <span className="render-beat-badge" title="The start frame is rendered first because this cut has none yet">+ start frame</span>}
                      {c.auto_end_frame && <span className="render-beat-badge" title="This model lands on an end frame; it is rendered first because this cut has none yet">+ end frame</span>}
                      {c.spends_credits && <span className="render-beat-badge" title="This ComfyUI model spends Comfy credits">credits</span>}
                    </td>
                    <td>{c.skipped ? '' : c.model_label || c.model_id || '—'}</td>
                    <td>{c.covered_lines ? `${c.recorded_lines}/${c.covered_lines} rec.` : '—'}</td>
                    <td>{c.skipped ? '' : c.duration_seconds ? `${c.duration_seconds}s` : '—'}</td>
                    {provider === 'fal' ? <td>{c.skipped ? '' : formatUsd(c.estimated_cost_usd) || '—'}</td> : null}
                    <td className="render-beat-notes">
                      {(c.warnings || []).map((w, i) => <div key={i}>{w}</div>)}
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
            {preview.counts.auto_start_frames > 0 && <span>{preview.counts.auto_start_frames} start frame{preview.counts.auto_start_frames === 1 ? '' : 's'} to render first</span>}
            {preview.counts.auto_end_frames > 0 && <span>{preview.counts.auto_end_frames} end frame{preview.counts.auto_end_frames === 1 ? '' : 's'} to render first</span>}
            {preview.counts.lipsync > 0 && <span>{preview.counts.lipsync} lip-sync</span>}
            <span>{preview.will_assemble ? 'beat video will be assembled' : 'beat video will NOT be assembled (some cuts have no clip)'}</span>
            {total && <span>total ≈ {total}</span>}
          </div>
        )}

        {needsConsent && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>At least one cut uses an API model that spends Comfy credits — I confirm the spend.</span>
          </label>
        )}
      </div>
    </Modal>
  );
}

function FalSlot({ label, help, options, defaultId, value, onChange }) {
  const sorted = [...options].sort((a, b) => String(a.display_name || a.endpoint_id).localeCompare(String(b.display_name || b.endpoint_id)));
  const defaultLabel = defaultId ? (sorted.find((m) => m.endpoint_id === defaultId)?.display_name || defaultId) : 'server default';
  return (
    <div className="field-block">
      <label className="field-label">{label}</label>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} style={{ width: '100%' }}>
        <option value="">Project default — {defaultLabel}</option>
        {sorted.map((m) => (
          <option key={m.endpoint_id} value={m.endpoint_id}>{m.display_name || m.endpoint_id}</option>
        ))}
      </select>
      <p style={{ color: 'var(--fg-muted)', fontSize: 12, margin: '4px 0 0' }}>{help}</p>
    </div>
  );
}
