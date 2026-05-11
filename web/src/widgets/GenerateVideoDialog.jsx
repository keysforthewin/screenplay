import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { apiGet, apiPostJson } from '../api.js';
import { VideoProgressBar } from './VideoProgressBar.jsx';

const POLL_INTERVAL_MS = 2000;

// "Generate video…" dialog opened from the storyboard scene's AudioSlot.
// Posts to /storyboard/:id/video/generate, then polls the job endpoint while
// rendering a smooth progress bar. The Wan task continues server-side even if
// the user closes the dialog — when the storyboard's video_file_id lands the
// inline player will appear automatically via the room's fields_updated ping.
export function GenerateVideoDialog({ open, onClose, storyboardId, sb, onRefresh }) {
  const [prompt, setPrompt] = useState('');
  const [duration, setDuration] = useState(5);
  const [resolution, setResolution] = useState('720P');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [job, setJob] = useState(null);
  const [estimatedSeconds, setEstimatedSeconds] = useState(180);
  const pollRef = useRef(null);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  // Reset form when the dialog opens.
  useEffect(() => {
    if (!open) {
      stopPolling();
      return;
    }
    setError(null);
    setJob(null);
    setGenerating(false);
    // Pre-fill the prompt with the row's text_prompt (markdown is fine; the
    // server strips it before passing to Wan).
    setPrompt(typeof sb?.text_prompt === 'string' ? sb.text_prompt : '');
    setDuration(
      Number.isFinite(Number(sb?.duration_seconds)) && Number(sb.duration_seconds) > 0
        ? Math.min(15, Math.max(2, Math.round(Number(sb.duration_seconds))))
        : 5,
    );
    setResolution('720P');
  }, [open, sb?._id]);

  useEffect(() => () => stopPolling(), []);

  async function pollOnce(jobId) {
    try {
      const r = await apiGet(`/storyboard/${storyboardId}/video-job/${jobId}`);
      const fresh = r?.job;
      if (!fresh) return;
      setJob(fresh);
      if (fresh.status === 'done') {
        stopPolling();
        setGenerating(false);
        // Refresh the parent so video_file_id flows into the inline player.
        // Hold the dialog open briefly so the user sees 100% then close.
        onRefresh?.();
        setTimeout(() => onClose?.(), 700);
      } else if (fresh.status === 'error') {
        stopPolling();
        setGenerating(false);
        setError(fresh.error || 'Generation failed.');
      }
    } catch {
      // Transient errors are tolerated; the loop keeps trying.
    }
  }

  async function submit() {
    setError(null);
    setJob({
      status: 'queued',
      step: 'Queued',
      started_at: new Date().toISOString(),
    });
    setGenerating(true);
    try {
      const body = {
        prompt: prompt.trim() || null,
        duration_seconds: duration,
        resolution,
      };
      const r = await apiPostJson(`/storyboard/${storyboardId}/video/generate`, body);
      const jobId = r?.job_id;
      if (r?.estimated_seconds) setEstimatedSeconds(Number(r.estimated_seconds));
      if (!jobId) {
        setGenerating(false);
        setError('Server did not return a job id.');
        return;
      }
      pollOnce(jobId);
      pollRef.current = setInterval(() => pollOnce(jobId), POLL_INTERVAL_MS);
    } catch (e) {
      setGenerating(false);
      setError(e.message || 'Generation failed.');
    }
  }

  return (
    <Modal
      open={open}
      title="Generate video with Wan 2.7"
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
            disabled={generating}
            onClick={submit}
          >
            {generating ? 'Generating…' : 'Generate video'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {error && <div className="error-banner">{error}</div>}

        <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
          Wan 2.7 will animate from the <b>start frame</b> to the <b>end frame</b>,
          using the <b>character sheet</b> as a likeness anchor and the <b>audio</b>{' '}
          for lip-sync. Rendering takes 1–5 minutes — you can leave this dialog open
          to watch progress, or close it; the video will appear inline on the scene
          card when it's ready.
        </div>

        {generating || job ? (
          <VideoProgressBar job={job} estimatedSeconds={estimatedSeconds} />
        ) : null}

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
            Wan caps prompts at 1500 chars. Markdown is stripped server-side.
          </span>
        </label>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="field-label">Duration (seconds)</span>
            <input
              type="number"
              min={2}
              max={15}
              step={1}
              value={duration}
              disabled={generating}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isFinite(n)) return;
                setDuration(Math.min(15, Math.max(2, Math.round(n))));
              }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="field-label">Resolution</span>
            <select
              value={resolution}
              disabled={generating}
              onChange={(e) => setResolution(e.target.value)}
            >
              <option value="480P">480P</option>
              <option value="720P">720P</option>
              <option value="1080P">1080P</option>
            </select>
          </label>
        </div>
      </div>
    </Modal>
  );
}
