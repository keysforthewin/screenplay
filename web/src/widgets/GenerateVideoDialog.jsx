import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { apiGet, apiPostJson, apiSseUrl } from '../api.js';
import { VideoProgressBar } from './VideoProgressBar.jsx';

// "Generate video…" dialog opened from the storyboard scene's AudioSlot.
// Lets the user pick which fal model to render with, then POSTs the request
// and opens an EventSource on the matching job stream so the progress bar
// updates as fal's queue position changes. The fal task continues server-
// side even if the user closes the dialog — when the storyboard's
// video_file_id lands the inline player will appear automatically via the
// room's fields_updated ping.
export function GenerateVideoDialog({ open, onClose, storyboardId, sb, onRefresh }) {
  const [registry, setRegistry] = useState(null); // { default_model_id, models: [...] }
  const [registryError, setRegistryError] = useState(null);
  const [modelId, setModelId] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [duration, setDuration] = useState(null);
  const [generateAudio, setGenerateAudio] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [job, setJob] = useState(null);
  const esRef = useRef(null);

  function closeStream() {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }

  // Fetch the model registry on open (cached for the lifetime of the dialog).
  useEffect(() => {
    if (!open) return;
    if (registry) return;
    let cancelled = false;
    apiGet('/video-models')
      .then((r) => {
        if (cancelled) return;
        setRegistry(r);
        setRegistryError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setRegistryError(e.message || 'Failed to load model list.');
      });
    return () => {
      cancelled = true;
    };
  }, [open, registry]);

  const chosenModel = useMemo(() => {
    if (!registry) return null;
    return registry.models.find((m) => m.id === modelId) || null;
  }, [registry, modelId]);

  // Reset form fields whenever the dialog opens or the storyboard changes.
  useEffect(() => {
    if (!open) {
      closeStream();
      return;
    }
    setError(null);
    setJob(null);
    setGenerating(false);
    setPrompt(typeof sb?.text_prompt === 'string' ? sb.text_prompt : '');
    if (registry) {
      const initial = registry.default_model_id || registry.models[0]?.id;
      setModelId(initial);
    }
  }, [open, sb?._id, registry]);

  // When the chosen model changes, snap duration to that model's default
  // (or to the storyboard's duration_seconds, clamped to allowed values).
  useEffect(() => {
    if (!chosenModel) return;
    const allowed = (chosenModel.durations || []).map((d) => Number(d)).filter(Number.isFinite);
    if (!allowed.length) {
      setDuration(null);
      return;
    }
    const sbDur = Number(sb?.duration_seconds);
    let candidate = Number.isFinite(sbDur) && sbDur > 0 ? sbDur : Number(chosenModel.default_duration);
    if (!Number.isFinite(candidate)) candidate = allowed[0];
    const closest = allowed.reduce(
      (best, n) => (Math.abs(n - candidate) < Math.abs(best - candidate) ? n : best),
      allowed[0],
    );
    setDuration(closest);
  }, [chosenModel, sb?.duration_seconds]);

  useEffect(() => () => closeStream(), []);

  // Pre-flight: which inputs does the chosen model need that aren't on this
  // storyboard yet? Server validates the same thing on submit; this lets us
  // disable the button and show a tooltip without a round-trip.
  const missing = useMemo(() => {
    if (!chosenModel) return [];
    const out = [];
    const need = chosenModel.inputs || {};
    if (need.startFrame === 'required' && !sb?.start_frame_id) out.push('start frame');
    if (need.endFrame === 'required' && !sb?.end_frame_id) out.push('end frame');
    if (need.characterSheet === 'required' && !sb?.character_sheet_image_id) out.push('character sheet');
    if (need.audio === 'required' && !sb?.audio_file_id) out.push('audio');
    return out;
  }, [chosenModel, sb]);

  async function submit() {
    setError(null);
    setJob({ status: 'queued', step: 'Queued', started_at: new Date().toISOString() });
    setGenerating(true);
    try {
      const body = {
        model_id: chosenModel.id,
        prompt: prompt.trim() || null,
      };
      if (duration != null) body.duration_seconds = duration;
      if (chosenModel.supports_generate_audio) body.generate_audio = generateAudio;
      const r = await apiPostJson(`/storyboard/${storyboardId}/video/generate`, body);
      const jobId = r?.job_id;
      if (!jobId) {
        setGenerating(false);
        setError('Server did not return a job id.');
        return;
      }
      const es = new EventSource(
        apiSseUrl(`/storyboard/${storyboardId}/video-job/${jobId}/events`),
      );
      esRef.current = es;
      es.addEventListener('snapshot', (ev) => setJob(safeParse(ev.data)));
      es.addEventListener('update', (ev) => setJob(safeParse(ev.data)));
      es.addEventListener('done', (ev) => {
        setJob(safeParse(ev.data));
        setGenerating(false);
        closeStream();
        onRefresh?.();
        setTimeout(() => onClose?.(), 700);
      });
      es.addEventListener('error', (ev) => {
        // Two cases: SSE-level disconnect (no data) or server-emitted
        // 'error' event with a job payload. Disambiguate by checking data.
        const data = ev?.data ? safeParse(ev.data) : null;
        if (data) {
          setJob(data);
          setError(data.error || 'Generation failed.');
          setGenerating(false);
          closeStream();
        } else if (es.readyState === EventSource.CLOSED) {
          setGenerating(false);
          setError('Connection lost.');
        }
      });
    } catch (e) {
      setGenerating(false);
      setError(e.message || 'Generation failed.');
    }
  }

  const ready = !generating && chosenModel && missing.length === 0;
  const submitTooltip = missing.length ? `Need: ${missing.join(', ')}` : '';

  return (
    <Modal
      open={open}
      title="Generate video"
      onClose={onClose}
      dismissible
      footer={
        <>
          <button type="button" onClick={onClose}>
            {generating ? 'Close' : 'Cancel'}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!ready}
            title={submitTooltip}
            onClick={submit}
          >
            {generating ? 'Generating…' : 'Generate video'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {error && <div className="error-banner">{error}</div>}
        {registryError && <div className="error-banner">{registryError}</div>}

        {registry && !registry.configured ? (
          <div className="error-banner">
            fal.ai is not configured on the server. Set <code>FAL_KEY</code> in your env
            to enable video generation.
          </div>
        ) : null}

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="field-label">Model</span>
          <select
            value={modelId || ''}
            disabled={generating || !registry}
            onChange={(e) => setModelId(e.target.value)}
          >
            {(registry?.models || []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {chosenModel ? (
            <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              {chosenModel.description}
            </span>
          ) : null}
        </label>

        {missing.length ? (
          <div className="warn-banner small" style={{ fontSize: 13, color: '#ffb86b' }}>
            This model needs: <b>{missing.join(', ')}</b>. Add them to the scene first.
          </div>
        ) : null}

        {generating || job ? <VideoProgressBar job={job} /> : null}

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="field-label">Prompt (override)</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={generating}
            rows={6}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
            placeholder="Leave blank to use the scene's text_prompt"
          />
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            Markdown is stripped server-side. Long prompts are truncated at 2000 chars.
          </span>
        </label>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {chosenModel?.durations?.length ? (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="field-label">Duration</span>
              <select
                value={duration ?? ''}
                disabled={generating}
                onChange={(e) => setDuration(Number(e.target.value))}
              >
                {chosenModel.durations.map((d) => (
                  <option key={d} value={Number(d)}>
                    {d}s
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {chosenModel?.supports_generate_audio ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={generateAudio}
                disabled={generating}
                onChange={(e) => setGenerateAudio(e.target.checked)}
              />
              <span className="field-label" style={{ margin: 0 }}>
                Generate audio from prompt
              </span>
            </label>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
