import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPatchJson, apiPostJson, imageUrl, thumbUrl } from '../api.js';
import { Modal } from './Modal.jsx';
import { PromptReferencePicker } from './PromptReferencePicker.jsx';
import { StartFrameModelChooser, useStartFrameModel } from './StartFrameModelChooser.jsx';

const MAX_REFS = 9;

// Render / re-render / edit one cut's START FRAME — or, with frame="end", its
// END FRAME (the still the clip lands on). The still prompt itself is the cut
// row's collaborative `<frame>_frame_prompt` field (edited in place on the
// row); this dialog owns the image model, the reference artwork list and the
// edit-mode prompt, and runs the job. The model comes from one of two
// providers, chosen in StartFrameModelChooser. An end frame also gets the
// rendered start frame as its last, continuity reference (server side).
export function CutStartFrameDialog({ open, onClose, cut, beatId, onRefresh, frame = 'start' }) {
  const id = cut?._id?.toString?.() || String(cut?._id || '');
  const isEnd = frame === 'end';
  const sf = cut?.[`${frame}_frame`] || null;
  const hasImage = Boolean(sf?.image_id);
  const continuityId = isEnd && cut?.start_frame?.image_id ? String(cut.start_frame.image_id) : null;
  const Name = isEnd ? 'End' : 'Start';
  const model = useStartFrameModel();
  const [mode, setMode] = useState('generate');
  const [editPrompt, setEditPrompt] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [job, setJob] = useState(null);
  const pollRef = useRef(null);

  const refIds = (sf?.reference_ids || []).map((x) => x?.toString?.() || String(x));

  useEffect(() => {
    if (!open) return;
    setError(null);
    setJob(null);
    setMode(hasImage ? 'generate' : 'generate');
    setEditPrompt('');
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [open, hasImage]);

  async function patchRefs(next) {
    setBusy(true);
    setError(null);
    try {
      await apiPatchJson(`/cut/${id}/${frame}-frame`, { reference_ids: next });
      onRefresh?.();
    } catch (e) {
      setError(readError(e));
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const body = { mode, ...model.requestFields() };
      if (mode === 'edit') body.edit_prompt = editPrompt;
      const r = await apiPostJson(`/cut/${id}/${frame}-frame/generate`, body);
      model.remember();
      setJob({ status: 'queued' });
      pollRef.current = setInterval(async () => {
        try {
          const s = await apiGet(`/cuts/start-frames/job/${r.job_id}`);
          setJob(s.job);
          if (['done', 'partial', 'error'].includes(s.job?.status)) {
            clearInterval(pollRef.current);
            pollRef.current = null;
            setBusy(false);
            onRefresh?.();
            if (s.job.status === 'done') onClose?.();
            else setError(s.job.error || s.job.warnings?.[0] || 'Render failed.');
          }
        } catch (e) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setBusy(false);
          setError(readError(e));
        }
      }, 1500);
    } catch (e) {
      setBusy(false);
      setError(readError(e));
    }
  }

  if (!open || !cut) return null;
  const running = busy && job;
  const useComfy = model.useComfy;
  const canRun = !busy && !(mode === 'edit' && !editPrompt.trim()) && model.ready;
  return (
    <Modal open={open} title={hasImage ? `${Name} frame` : `Render ${frame} frame`} onClose={onClose} size="fullscreen" dismissible={!running}>
      <div className="cut-sf-dialog">
        <div className="cut-sf-dialog-left">
          {hasImage ? (
            <img className="cut-sf-preview" src={imageUrl(String(sf.image_id))} alt={`Current ${frame} frame`} />
          ) : (
            <div className="cut-sf-empty">No {frame} frame yet. The still prompt and references below are what will be rendered.</div>
          )}
          <div className="field-label" style={{ marginTop: 12 }}>Still prompt (edit it on the cut row)</div>
          <div className="cut-sf-prompt-preview">{sf?.prompt || <em style={{ color: 'var(--fg-muted)' }}>No still prompt yet — the planner writes one, or type one on the row.</em>}</div>

          <div className="field-label" style={{ marginTop: 14 }}>Reference artwork (characters in frame + the set)</div>
          <div className="video-prompt-ref-strip cut-sf-refs-large">
            {refIds.map((rid, i) => (
              <div key={rid} className="video-prompt-ref-chip">
                <img src={thumbUrl(rid)} alt={`Reference ${i + 1}`} loading="lazy" />
                <div className="video-prompt-ref-actions">
                  <button type="button" title="Remove" disabled={busy} onClick={() => patchRefs(refIds.filter((x) => x !== rid))}>×</button>
                </div>
              </div>
            ))}
            <button type="button" className="video-prompt-ref-add" disabled={busy || refIds.length >= MAX_REFS} onClick={() => setPickerOpen(true)}>
              + Add artwork
            </button>
            {continuityId ? (
              <div className="video-prompt-ref-chip" title="The rendered start frame rides along last: light, palette and wardrobe carry over; its framing does not.">
                <img src={thumbUrl(continuityId)} alt="Start frame (continuity)" loading="lazy" />
                <span className="video-prompt-ref-owner">start frame · continuity</span>
              </div>
            ) : null}
          </div>
          {isEnd && !continuityId ? (
            <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '4px 0 0' }}>
              Render the start frame first and it is added here as a continuity reference.
            </p>
          ) : null}
          {!refIds.length ? (
            <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '4px 0 0' }}>
              With no picks, the artwork of everyone in frame and the set is scored and chosen automatically.
            </p>
          ) : null}
        </div>

        <div className="cut-sf-dialog-right">
          <div className="cut-sf-mode">
            <label><input type="radio" checked={mode === 'generate'} disabled={busy} onChange={() => setMode('generate')} /> {hasImage ? 'Re-render from the still prompt' : 'Render from the still prompt'}</label>
            <label><input type="radio" checked={mode === 'edit'} disabled={busy || !hasImage} onChange={() => setMode('edit')} /> Edit the current frame</label>
          </div>
          {mode === 'edit' ? (
            <textarea rows={3} value={editPrompt} disabled={busy} onChange={(e) => setEditPrompt(e.target.value)} placeholder="e.g. Move the lamp out of frame; keep everything else." />
          ) : null}

          <StartFrameModelChooser state={model} disabled={busy} referenceCount={refIds.length + (continuityId && mode !== 'edit' ? 1 : 0)} mode={mode} requireReferences={mode === 'edit'} />

          <div className="cut-sf-footer">
            {error ? <div className="error-banner small">{error}</div> : null}
            {running ? (
              <div className="cut-sf-status">
                {job.status === 'queued' ? 'Queued…' : job.status === 'running' ? (useComfy ? 'Rendering on ComfyUI…' : 'Rendering…') : job.status}
              </div>
            ) : null}
            <div className="video-prompt-actions">
              <button type="button" className="primary" disabled={!canRun} onClick={run}>
                {mode === 'edit' ? '✎ Apply edit' : hasImage ? '↻ Re-render' : `🖼 Render ${frame} frame`}
              </button>
              <button type="button" disabled={running} onClick={onClose}>Close</button>
            </div>
          </div>
        </div>
      </div>
      <PromptReferencePicker
        open={pickerOpen}
        beatId={beatId}
        existingIds={refIds}
        maxTotal={MAX_REFS}
        onClose={() => setPickerOpen(false)}
        onPick={(ids) => {
          setPickerOpen(false);
          patchRefs([...refIds, ...ids]);
        }}
      />
    </Modal>
  );
}

function readError(e) {
  let msg = e?.message || 'Request failed.';
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.error) msg = parsed.error;
  } catch {}
  return msg;
}
