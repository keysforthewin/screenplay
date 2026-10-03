import { useEffect, useState } from 'react';
import { thumbUrl } from '../api.js';
import { Modal } from './Modal.jsx';
import { StartFrameModelChooser, useStartFrameModel } from './StartFrameModelChooser.jsx';

// "Render frames" for the whole beat: every cut's start frame (the still the
// clip opens on) and/or end frame (the still it lands on). Nothing renders
// until the button in here is pressed: the dialog shows which frames would be
// rendered, lets the user pick which of the two, the provider and model (the
// same chooser, and the same remembered choice, as the single-cut dialog) and
// whether frames that already exist are redone. `onStart(body)` posts the job;
// the page shows its progress. A cut renders its start frame before its end
// frame, so the end frame can use it as a continuity reference.
//
// cuts: [{ _id, label, title, start_frame, end_frame }] in beat order.
const FRAMES = ['start', 'end'];

export function RenderStartFramesDialog({ open, onClose, cuts = [], onStart }) {
  const model = useStartFrameModel();
  const [redo, setRedo] = useState(false);
  const [check, setCheck] = useState(true);
  const [which, setWhich] = useState({ start: true, end: true });
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (open) {
      setRedo(false);
      setWhich({ start: true, end: true });
      setStarting(false);
    }
  }, [open]);

  if (!open) return null;
  const frames = FRAMES.filter((f) => which[f]);
  const has = (c, f) => Boolean(c[`${f}_frame`]?.image_id);
  const hasPrompt = (c, f) => Boolean(String(c[`${f}_frame`]?.prompt || '').trim());
  const all = cuts.flatMap((c) => frames.map((f) => ({ c, f })));
  const rendered = all.filter(({ c, f }) => has(c, f));
  const missing = all.filter(({ c, f }) => !has(c, f));
  const targets = redo ? all : missing;
  const count = targets.length;
  const noPrompt = targets.filter(({ c, f }) => !hasPrompt(c, f));
  const noun = frames.length === 2 ? 'frame' : `${frames[0] || 'start'} frame`;

  async function start() {
    setStarting(true);
    model.remember();
    try {
      await onStart?.({ skip_rendered: !redo, frames, check, ...model.requestFields() });
    } finally {
      setStarting(false);
    }
  }

  return (
    <Modal open={open} title="Render frames" onClose={onClose} size="fullscreen" dismissible={!starting}>
      <div className="cut-sf-dialog">
        <div className="cut-sf-dialog-left">
          <div className="sf-bulk-which">
            <label><input type="checkbox" checked={which.start} disabled={starting} onChange={(e) => setWhich((w) => ({ ...w, start: e.target.checked }))} /> Start frames</label>
            <label><input type="checkbox" checked={which.end} disabled={starting} onChange={(e) => setWhich((w) => ({ ...w, end: e.target.checked }))} /> End frames</label>
          </div>
          <p style={{ marginTop: 8 }}>
            {!frames.length
              ? 'Pick start frames, end frames, or both.'
              : missing.length
                ? `${missing.length} of ${all.length} ${noun}${all.length === 1 ? '' : 's'} not rendered yet.`
                : `All ${all.length} ${noun}s are already rendered.`}{' '}
            Each frame is rendered from its still prompt and its reference artwork. An end frame is built from the cut's start frame: a held camera's is the start frame edited, a moving camera's takes it as the reference for clothing, props and layout.
          </p>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, marginBottom: 6 }}>
            <input type="checkbox" checked={check} disabled={starting} onChange={(e) => setCheck(e.target.checked)} />
            <span>
              Check &amp; repair continuity
              <span style={{ display: 'block', fontSize: 12, color: 'var(--fg-muted)' }}>
                Once a cut has both frames they are compared — people, clothing, props, furniture layout — and what the cut does not perform is fixed in the frame that is wrong (up to two rounds; up to six for a blocking problem — one the clip would visibly show — and a pair that still has one is marked in red). Cuts whose frames exist but were never checked are checked too.
              </span>
            </span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={redo} disabled={starting || !rendered.length} onChange={(e) => setRedo(e.target.checked)} />
            Also re-render the {rendered.length} {noun}{rendered.length === 1 ? '' : 's'} already rendered
          </label>
          {noPrompt.length ? (
            <p style={{ fontSize: 12, color: '#e6b566' }}>
              {noPrompt.length} {noun}{noPrompt.length === 1 ? ' has' : 's have'} no still prompt — a missing start prompt is reported as failed, a missing end prompt is skipped (re-plan the scene to write one).
            </p>
          ) : null}
          <div className="sf-bulk-grid">
            {cuts.map((c) => (
              <div key={c._id} className="sf-bulk-cell is-target" title={c.title || ''}>
                <div className="sf-bulk-pair">
                  {FRAMES.map((f) => {
                    const img = c[`${f}_frame`]?.image_id;
                    const will = which[f] && (redo || !img);
                    return (
                      <div key={f} className={`sf-bulk-frame${will ? ' will' : ''}${which[f] ? '' : ' off'}`} title={`${f} frame — ${will ? (img ? 're-render' : 'render') : 'keep'}`}>
                        {img ? <img src={thumbUrl(String(img))} alt="" loading="lazy" /> : <div className="sf-bulk-empty">{f}</div>}
                      </div>
                    );
                  })}
                </div>
                <div className="sf-bulk-caption">
                  <span>{c.label}</span>
                  <span>{FRAMES.filter((f) => which[f] && (redo || !has(c, f))).join(' + ') || 'keep'}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="cut-sf-dialog-right">
          <StartFrameModelChooser state={model} disabled={starting} />
          <div className="cut-sf-footer">
            <div className="video-prompt-actions">
              <button type="button" className="primary" disabled={starting || !count || !model.ready} onClick={start}>
                🖼 Render {count} {noun}{count === 1 ? '' : 's'}
              </button>
              <button type="button" disabled={starting} onClick={onClose}>Cancel</button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
