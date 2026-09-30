import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPostJson } from '../api.js';
import { Badge } from './comfyControls.jsx';

// Local ComfyUI image models that take reference images — the ComfyUI side of
// the start-frame dialog's model picker. The list is what the server's last
// gallery scan found runnable on this ComfyUI (GET /comfy/image-models); the
// first open of a never-scanned server starts a scan, and "Rescan" reruns it
// after installing a model. Templates that would work but whose model files
// are missing are listed underneath, so it is clear what a download buys.
//
// Props: value / onChange(id) — the selected `comfy:<id>`; params /
// onParamsChange — that model's render parameters (width, height, steps…);
// referenceCount — how many references the cut carries (for the "uses N of
// M" note); onAvailability({configured, reason, count}) — for the parent's tab.
export function ComfyImageModelPicker({ value, onChange, params, onParamsChange, referenceCount = 0, mode = 'generate', disabled = false, onAvailability }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [showUnavailable, setShowUnavailable] = useState(false);
  const pollRef = useRef(null);

  function stopPoll() {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }

  async function load() {
    try {
      const d = await apiGet('/comfy/image-models');
      setData(d);
      onAvailability?.({ configured: !!d.configured, reason: d.reason || null, count: (d.models || []).length });
      stopPoll();
      if (d.scan?.running) pollRef.current = setTimeout(load, 2000);
      else if (d.scan?.error) setError(`Scan failed: ${d.scan.error}`);
    } catch (e) {
      setError(e.message || 'Could not load the ComfyUI models.');
      setData({ configured: false, models: [], unavailable: [] });
    }
  }

  useEffect(() => {
    load();
    return stopPoll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function rescan() {
    setError(null);
    try {
      await apiPostJson('/comfy/image-models/scan', {});
      load();
    } catch (e) {
      setError(e.message || 'Scan failed.');
    }
  }

  const models = (data?.models || []).filter((m) => m.installed !== false);
  const selected = models.find((m) => m.id === value) || null;

  // A remembered model can vanish (uninstalled, rescanned away): fall back to
  // the first runnable one rather than submitting an id the server rejects.
  useEffect(() => {
    if (!models.length || selected) return;
    onChange?.(models[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (data === null) return <p className="comfy-image-note">Loading ComfyUI models…</p>;
  if (!data.configured) {
    return <p className="comfy-image-note">{data.reason || 'ComfyUI rendering is disabled on this server.'}</p>;
  }

  const scanning = !!data.scan?.running;
  const unavailable = data.unavailable || [];
  return (
    <div className="comfy-image-picker">
      {error ? <div className="error-banner small">{error}</div> : null}
      {scanning && !models.length ? (
        <p className="comfy-image-note">Looking through the ComfyUI template gallery for image models that take reference images… {data.scan.progress || ''}</p>
      ) : null}
      {!scanning && !models.length ? (
        <p className="comfy-image-note">
          No installed ComfyUI image model takes reference images yet. Install one of the models below in ComfyUI, then rescan.
        </p>
      ) : null}

      <div className="comfy-image-list">
        {models.map((m) => {
          const used = Math.min(referenceCount, m.max_reference_images);
          return (
            <label key={m.id} className={`comfy-image-row${value === m.id ? ' is-selected' : ''}`}>
              <input type="radio" checked={value === m.id} disabled={disabled} onChange={() => onChange?.(m.id)} />
              <span className="comfy-image-row-main">
                <span className="comfy-image-row-title">
                  {m.label}
                  <Badge ok>Free · local GPU</Badge>
                  {!m.verified ? <Badge>Untested</Badge> : null}
                </span>
                <span className="comfy-image-row-meta">
                  <span>up to {m.max_reference_images} reference{m.max_reference_images === 1 ? '' : 's'}</span>
                  {referenceCount > m.max_reference_images ? <span className="is-warn">uses {used} of this cut's {referenceCount}</span> : null}
                  {m.size_follows_reference ? <span className="is-warn">frame size follows the first reference</span> : <span>16:9 canvas</span>}
                  <span className="comfy-image-template">{m.template}</span>
                </span>
                {value === m.id && m.description ? <span className="comfy-image-row-desc">{m.description}</span> : null}
              </span>
            </label>
          );
        })}
      </div>

      {selected ? (
        <ComfyImageParams model={selected} mode={mode} params={params || {}} disabled={disabled} onChange={onParamsChange} />
      ) : null}

      <div className="comfy-image-footer">
        <span>
          {models.length} installed
          {data.scanned_at ? ` · scanned ${new Date(data.scanned_at).toLocaleString()}` : ''}
          {scanning ? ` · ${data.scan.progress || 'scanning…'}` : ''}
        </span>
        <button type="button" onClick={rescan} disabled={disabled || scanning} title="Re-check the ComfyUI gallery against the models installed now">
          {scanning ? 'Scanning…' : 'Rescan'}
        </button>
      </div>

      {unavailable.length ? (
        <div className="comfy-image-unavailable">
          <button type="button" className="link-button" onClick={() => setShowUnavailable((v) => !v)}>
            {showUnavailable ? '▾' : '▸'} {unavailable.length} more template{unavailable.length === 1 ? '' : 's'} take references but are not installed
          </button>
          {showUnavailable ? (
            <ul>
              {unavailable.map((u) => (
                <li key={u.template}>
                  <strong>{u.label}</strong> <span className="comfy-image-template">{u.template}</span>
                  <div>{u.reason}</div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// 16:9 sizes on the 32px grid most local models want.
const SIZE_PRESETS = [
  [1344, 768],
  [1664, 928],
  [1920, 1088],
];

function ComfyImageParams({ model, mode, params, disabled, onChange }) {
  const specs = model.params || {};
  const value = (key) => (params[key] !== undefined ? params[key] : specs[key]?.default ?? null);
  const set = (patch) => onChange?.({ ...params, ...patch });
  const sized = specs.width && specs.height && mode !== 'edit';
  const current = `${value('width')}x${value('height')}`;
  const presets = SIZE_PRESETS.filter(([w, h]) => w <= (specs.width?.max ?? w) && h <= (specs.height?.max ?? h));
  return (
    <div className="comfy-image-params">
      {sized ? (
        <label>
          <span className="field-label">Frame size</span>
          <select value={current} disabled={disabled} onChange={(e) => {
            const [w, h] = e.target.value.split('x').map(Number);
            set({ width: w, height: h });
          }}>
            {presets.some(([w, h]) => `${w}x${h}` === current) ? null : <option value={current}>{current.replace('x', ' × ')}</option>}
            {presets.map(([w, h]) => <option key={`${w}x${h}`} value={`${w}x${h}`}>{w} × {h}</option>)}
          </select>
        </label>
      ) : null}
      {mode === 'edit' && specs.width ? (
        <p className="comfy-image-note" style={{ gridColumn: '1 / -1', margin: 0 }}>An edit keeps the current frame's size.</p>
      ) : null}
      {['steps', 'cfg', 'seed'].filter((k) => specs[k]).map((key) => (
        <label key={key} title={specs[key].help || ''}>
          <span className="field-label">
            {specs[key].label || key}
            {key !== 'seed' && typeof specs[key].min === 'number' ? <span className="comfy-image-range"> {specs[key].min}–{specs[key].max}</span> : null}
          </span>
          <input
            type="number"
            value={value(key) ?? ''}
            min={specs[key].min}
            max={specs[key].max}
            step={specs[key].step ?? 1}
            placeholder={key === 'seed' ? 'random' : ''}
            disabled={disabled}
            onChange={(e) => set({ [key]: e.target.value === '' ? null : Number(e.target.value) })}
          />
        </label>
      ))}
    </div>
  );
}
