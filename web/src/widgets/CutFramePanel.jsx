import { useState } from 'react';
import { apiDelete, apiPatchJson, apiPostJson, imageUrl, thumbUrl } from '../api.js';
import { CollabField } from '../editor/CollabField.jsx';
import { Modal } from './Modal.jsx';
import { ImageLightbox } from './ImageLightbox.jsx';
import { PromptReferencePicker } from './PromptReferencePicker.jsx';
import { StartFrameModelChooser, useStartFrameModel } from './StartFrameModelChooser.jsx';
import { frameJobKey, isFrameJobActive, useCutFrameJobs } from './cutFrameJobs.jsx';

const MAX_REFS = 9;

function readError(e) {
  let msg = e?.message || 'Request failed.';
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.error) msg = parsed.error;
  } catch {}
  return msg;
}

// Where a frame of a cut lives: `frame` is 'start', 'end' or 'kf:<keyframe id>'
// (the key the server's routes and jobs use). The three differ only in their
// sub-document, their prompt fragment and their URLs.
export function frameApi(cut, frame) {
  const id = String(cut._id);
  const kf = /^kf:([a-f0-9]{24})$/.exec(String(frame || ''));
  if (kf) {
    const entry = (cut.keyframes || []).find((k) => String(k.id) === kf[1]) || null;
    const t = entry?.at_seconds;
    return {
      kind: 'keyframe',
      doc: entry,
      label: 'Keyframe',
      title: t != null ? `Keyframe at ${t} s` : 'Keyframe',
      promptField: `item:${id}:kf:${kf[1]}:prompt`,
      promptPlaceholder: 'What this frame of the cut shows at this moment…',
      base: `/cut/${id}/keyframe/${kf[1]}`,
      imagePath: `/cut/${id}/keyframe/${kf[1]}/image`,
    };
  }
  const which = frame === 'end' ? 'end' : 'start';
  return {
    kind: which,
    doc: cut[`${which}_frame`] || null,
    label: which === 'end' ? 'End frame' : 'Start frame',
    title: which === 'end' ? 'End frame' : 'Start frame',
    promptField: `item:${id}:${which}_frame_prompt`,
    promptPlaceholder: `What the ${which === 'end' ? 'last' : 'first'} frame of this cut shows…`,
    base: `/cut/${id}/${which}-frame`,
    imagePath: `/cut/${id}/${which}-frame`,
  };
}

// One still of a cut — its start frame, its end frame or a keyframe: the
// prompt, the reference images sent to the image model with that prompt, and
// the rendered picture. Each frame has its own references. `header` renders
// beside the label (a keyframe's time and strength controls).
export function CutFramePanel({ cut, frame, beatId, disabled, onRefresh, header = null }) {
  const id = String(cut._id);
  const api = frameApi(cut, frame);
  const label = api.title;
  const sf = api.doc;
  const image = sf?.image_id ? String(sf.image_id) : null;
  const refIds = (sf?.reference_ids || []).map(String);
  // Every frame but the start frame can take the cut's own start frame as a reference.
  const startImage = api.kind !== 'start' && cut.start_frame?.image_id ? String(cut.start_frame.image_id) : null;

  const store = useCutFrameJobs();
  const key = frameJobKey(id, frame);
  const job = store?.jobs?.[key] || null;
  const rendering = isFrameJobActive(job);
  const model = useStartFrameModel();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [renderOpen, setRenderOpen] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const locked = busy || disabled || rendering;

  async function call(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onRefresh?.();
    } catch (e) {
      setError(readError(e));
    } finally {
      setBusy(false);
    }
  }

  const setRefs = (ids) => call(() => apiPatchJson(api.base, { reference_ids: ids }));

  async function render() {
    setError(null);
    store?.dismiss(key);
    try {
      const r = await apiPostJson(`${api.base}/generate`, model.requestFields());
      model.remember();
      setRenderOpen(false);
      store?.track({ job_id: r.job_id, cut_id: id, frame, status: 'running' });
    } catch (e) {
      setError(readError(e));
    }
  }

  return (
    <div className={`cut-frame${api.kind === 'keyframe' ? ' cut-frame-keyframe' : ''}`}>
      <div className="cut-frame-picture">
        {header ? <div className="cut-frame-header">{header}</div> : <div className="field-label">{label}</div>}
        {image ? (
          <img src={thumbUrl(image)} alt={label} loading="lazy" onClick={() => setLightbox(true)} />
        ) : (
          <div className="cut-frame-empty">{rendering ? 'Rendering…' : 'Not generated yet'}</div>
        )}
        <div className="cut-frame-buttons">
          <button type="button" className={image ? '' : 'primary'} disabled={locked} onClick={() => setRenderOpen(true)}>
            {rendering ? 'Rendering…' : image ? 'Regenerate…' : 'Generate…'}
          </button>
          {sf?.previous_image_id ? (
            <button type="button" disabled={locked} title="Restore the previous image" onClick={() => call(() => apiPostJson(`${api.base}/undo`, {}))}>Undo</button>
          ) : null}
          {image ? (
            <button
              type="button"
              className="danger"
              disabled={locked}
              onClick={() => {
                if (confirm(`Remove the generated ${label.toLowerCase()}? Its prompt and reference images are kept.`)) call(() => apiDelete(api.imagePath));
              }}
            >
              Remove
            </button>
          ) : null}
        </div>
        {job?.status === 'error' ? <div className="error-banner small">{job.error || 'The render failed.'}</div> : null}
        {error ? <div className="error-banner small">{error}</div> : null}
      </div>

      <div className="cut-frame-text">
        <CollabField label={`${api.label} prompt`} field={api.promptField} multiline placeholder={api.promptPlaceholder} />
        <div className="field-label">Reference images</div>
        <div className="video-prompt-ref-strip">
          {refIds.map((rid) => (
            <div key={rid} className="video-prompt-ref-chip" title={rid === startImage ? "This cut's start frame" : 'Reference image'}>
              <img src={thumbUrl(rid)} alt="Reference" loading="lazy" />
              {rid === startImage ? <span className="video-prompt-ref-owner">start frame</span> : null}
              <div className="video-prompt-ref-actions">
                <button type="button" title="Remove" disabled={locked} onClick={() => setRefs(refIds.filter((x) => x !== rid))}>×</button>
              </div>
            </div>
          ))}
          <button type="button" className="video-prompt-ref-add" disabled={locked || refIds.length >= MAX_REFS} onClick={() => setPickerOpen(true)}>+ Add reference</button>
          {startImage && !refIds.includes(startImage) ? (
            <button type="button" className="video-prompt-ref-add" disabled={locked || refIds.length >= MAX_REFS} title={`Send this cut's start frame along, so the ${api.label.toLowerCase()} is the same place and the same people`} onClick={() => setRefs([...refIds, startImage])}>+ Start frame</button>
          ) : null}
        </div>
      </div>

      <Modal
        open={renderOpen}
        title={`${image ? 'Regenerate' : 'Generate'} the ${label.toLowerCase()}`}
        onClose={() => setRenderOpen(false)}
        size="xl"
        footer={
          <>
            <button type="button" onClick={() => setRenderOpen(false)}>Cancel</button>
            <button type="button" className="primary" disabled={!model.ready} onClick={render}>{image ? 'Regenerate' : 'Generate'}</button>
          </>
        }
      >
        <p style={{ color: 'var(--fg-muted)', marginTop: 0 }}>
          The {label.toLowerCase()} prompt is sent with {refIds.length ? `its ${refIds.length} reference image${refIds.length === 1 ? '' : 's'}` : 'no reference images'}.
        </p>
        {error ? <div className="error-banner small">{error}</div> : null}
        <div className="cut-frame-models">
          <StartFrameModelChooser state={model} referenceCount={refIds.length} />
        </div>
      </Modal>
      <PromptReferencePicker
        open={pickerOpen}
        beatId={beatId}
        existingIds={refIds}
        maxTotal={MAX_REFS}
        onClose={() => setPickerOpen(false)}
        onPick={(ids) => {
          setPickerOpen(false);
          setRefs([...refIds, ...ids]);
        }}
      />
      {lightbox && image ? <ImageLightbox src={imageUrl(image)} alt={label} onClose={() => setLightbox(false)} /> : null}
    </div>
  );
}
