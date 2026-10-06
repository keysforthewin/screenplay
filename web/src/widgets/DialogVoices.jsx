import { useState } from 'react';
import { Modal } from './Modal.jsx';

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// Confirm step of "Generate all voices": what will be rendered, what is left
// out and why, and the one choice — whether lines that already have audio
// (a recording, an upload, an earlier render) are replaced.
export function GenerateVoicesDialog({ open, preview, onConfirm, onCancel }) {
  const [overwrite, setOverwrite] = useState(false);
  if (!open || !preview) return null;
  const count = preview.ready + (overwrite ? preview.with_audio : 0);
  return (
    <Modal
      open={open}
      title="Generate all voices"
      onClose={onCancel}
      footer={
        <>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={!count} onClick={() => onConfirm({ overwrite })}>
            Generate {plural(count, 'line')}
          </button>
        </>
      }
    >
      {!preview.configured ? (
        <p style={{ margin: 0 }}>ElevenLabs is not configured on this server (ELEVEN_LABS_KEY missing).</p>
      ) : (
        <>
          <p style={{ marginTop: 0 }}>
            Each line is performed by its own ElevenLabs voice, else its character’s, with <strong>Eleven v4</strong>,
            audio tags included, and stored as that line’s audio.
          </p>
          <ul className="dialog-voices-summary">
            <li>{plural(preview.ready, 'line')} ready to generate</li>
            {preview.with_audio > 0 && (
              <li>
                {plural(preview.with_audio, 'line')} already {preview.with_audio === 1 ? 'has' : 'have'} audio
                <label className="dialog-voices-overwrite">
                  <input
                    type="checkbox"
                    checked={overwrite}
                    onChange={(e) => setOverwrite(e.target.checked)}
                  />{' '}
                  replace it (recordings included)
                </label>
              </li>
            )}
            {preview.no_voice > 0 && (
              <li>
                {plural(preview.no_voice, 'line')} skipped — no ElevenLabs voice
                {preview.unvoiced_speakers?.length ? `: ${preview.unvoiced_speakers.join(', ')}` : ''}
              </li>
            )}
            {preview.empty > 0 && <li>{plural(preview.empty, 'empty line')} skipped</li>}
          </ul>
        </>
      )}
    </Modal>
  );
}

// Progress / final tally of the beat's voice batch.
export function DialogVoicesBanner({ job, onCancel, onDismiss }) {
  if (!job) return null;
  const c = job.counts || {};
  const total = (job.items || []).filter((it) => it.status !== 'skipped' || it.reason === 'line was deleted').length;
  const finished = (c.done || 0) + (c.error || 0);
  const running = job.status === 'running';
  const failed = (job.items || []).filter((it) => it.status === 'error');
  return (
    <div className="dialog-voices-banner">
      <div className="dialog-voices-banner-row">
        <span>
          {running
            ? `Generating voices… ${finished} / ${total}`
            : job.status === 'cancelled'
              ? `Voice generation stopped — ${plural(c.done || 0, 'line')} generated`
              : job.status === 'error'
                ? `Voice generation failed: ${job.error || 'unknown error'}`
                : `Voices generated for ${plural(c.done || 0, 'line')}`}
          {!running && (c.error || 0) > 0 && ` · ${c.error} failed`}
          {!running && (c.skipped || 0) > 0 && ` · ${c.skipped} skipped`}
        </span>
        {running
          ? <button type="button" onClick={onCancel}>Stop</button>
          : <button type="button" onClick={onDismiss}>Dismiss</button>}
      </div>
      {running && (
        <progress value={finished} max={Math.max(total, 1)} style={{ width: '100%' }} />
      )}
      {failed.length > 0 && (
        <ul className="dialog-voices-errors">
          {failed.map((it) => (
            <li key={it.dialog_id}>{it.label}: {it.error}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
