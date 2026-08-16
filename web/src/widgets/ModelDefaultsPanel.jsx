// About page → Models tab: the project's default generation models.
//
// Five slots, persisted per project via GET/PUT /api/model-defaults:
//   - image_with_refs    → pre-selected in the image-sheet "plates with
//                          references" selector
//   - image_prompt_only  → pre-selected in the image-sheet "prompt-only
//                          plates" selector
//   - video_start_end    → pre-selected in the video dialog when the scene
//                          provides a start AND an end frame
//   - video_start_only   → pre-selected when the scene provides only a start
//                          frame
//   - lipsync            → pre-selected when the lip-sync facet is enabled
//
// The two image slots reuse ImageModelSelect (same filtered pools as the
// image-sheet dialog, which also writes these slots back whenever its
// selectors change). The three video slots are plain dropdowns over the
// registered rows of the fal video catalog, filtered by capability.

import { useEffect, useMemo, useState } from 'react';
import { apiGet, apiPutJson } from '../api.js';
import { ImageModelSelect } from './ImageModelSelect.jsx';

const VIDEO_SLOTS = [
  {
    key: 'video_start_end',
    label: 'Videos with a start and end frame',
    help: 'Used when the scene assigns both frames — the model must accept a start AND an end frame.',
    accepts: (caps) => caps?.start_frame === true && caps?.end_frame === true,
  },
  {
    key: 'video_start_only',
    label: 'Videos with just a start frame',
    help: 'Used when the scene provides a single frame — any start-frame-capable model qualifies.',
    accepts: (caps) => caps?.start_frame === true,
  },
  {
    key: 'lipsync',
    label: 'Lip sync (avatar)',
    help: 'Used when generating a lip-synced performance from a frame and real recorded audio.',
    accepts: (caps) => caps?.lip_sync === true,
  },
];

function VideoDefaultSelect({ slot, models, value, disabled, onChange }) {
  const options = useMemo(
    () => (models || [])
      .filter((m) => m.is_registered && slot.accepts(m.capabilities))
      .sort((a, b) => String(a.display_name || a.endpoint_id).localeCompare(String(b.display_name || b.endpoint_id))),
    [models, slot],
  );
  // A stored endpoint that fell out of the registry (catalog refresh, key
  // change) still renders, marked unavailable, so the user sees what's stored.
  const missing = value && !options.some((m) => m.endpoint_id === value);
  return (
    <div className="field-block">
      <label className="field-label">{slot.label}</label>
      <select
        value={value || ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        style={{ width: '100%' }}
      >
        <option value="">No default — the dialog picks its own</option>
        {missing && <option value={value}>{value} (not in the current catalog)</option>}
        {options.map((m) => (
          <option key={m.endpoint_id} value={m.endpoint_id}>
            {m.display_name || m.endpoint_id}
          </option>
        ))}
      </select>
      <p style={{ color: 'var(--fg-muted)', fontSize: 12, margin: '6px 0 0' }}>{slot.help}</p>
    </div>
  );
}

export function ModelDefaultsPanel() {
  const [defaults, setDefaults] = useState(null);
  const [videoModels, setVideoModels] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiGet('/model-defaults');
        if (!cancelled) setDefaults(r?.model_defaults || {});
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
      try {
        const v = await apiGet('/video-models');
        if (!cancelled) setVideoModels(Array.isArray(v?.models) ? v.models : []);
      } catch {
        if (!cancelled) setVideoModels([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function save(key, value) {
    setDefaults((prev) => ({ ...prev, [key]: value }));
    setSaving(true);
    setError(null);
    try {
      const r = await apiPutJson('/model-defaults', { [key]: value });
      setDefaults(r?.model_defaults || {});
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (defaults === null) {
    return <p style={{ color: 'var(--fg-muted)' }}>Loading model defaults…</p>;
  }

  return (
    <div>
      <p style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
        The models pre-selected across this project's generate dialogs. The
        image slots also update themselves whenever someone picks a different
        model in the Create image sheet dialog.
        {saving ? ' Saving…' : ''}
      </p>
      {error && <div className="error-banner">{error}</div>}

      <h2>Images</h2>
      <div className="field-block">
        <span className="field-label">Images with a reference image</span>
        <ImageModelSelect
          value={defaults.image_with_refs || ''}
          onChange={(id) => { if (id && id !== defaults.image_with_refs) save('image_with_refs', id); }}
          compact
          requireReferences
        />
      </div>
      <div className="field-block" style={{ marginTop: 16 }}>
        <span className="field-label">Images without a reference image</span>
        <ImageModelSelect
          value={defaults.image_prompt_only || ''}
          onChange={(id) => { if (id && id !== defaults.image_prompt_only) save('image_prompt_only', id); }}
          compact
          promptOnly
        />
      </div>

      <h2 style={{ marginTop: 24 }}>Videos</h2>
      {videoModels === null ? (
        <p style={{ color: 'var(--fg-muted)' }}>Loading video models…</p>
      ) : (
        VIDEO_SLOTS.map((slot) => (
          <VideoDefaultSelect
            key={slot.key}
            slot={slot}
            models={videoModels}
            value={defaults[slot.key]}
            disabled={saving}
            onChange={(v) => save(slot.key, v)}
          />
        ))
      )}
    </div>
  );
}
