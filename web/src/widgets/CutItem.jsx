import { useEffect, useRef, useState } from 'react';
import { useComfyAvailability, COMFY_DISABLED_MESSAGE } from './comfyControls.jsx';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { apiDelete, apiGet, apiPatchJson, apiPostJson, imageUrl, thumbUrl } from '../api.js';
import { CollabField } from '../editor/CollabField.jsx';
import { GenerateVideoDialog } from './GenerateVideoDialog.jsx';
import { ComfyVideoDialog } from './ComfyVideoDialog.jsx';
import { isComfyJobActive, useComfyCutJobs } from './comfyCutJobs.jsx';
import { ClipVideoPanel } from './ClipVideoPanel.jsx';
import { PromptReferencePicker } from './PromptReferencePicker.jsx';
import { DialogLineChips } from './DialogLineChips.jsx';
import { CutStartFrameDialog } from './CutStartFrameDialog.jsx';
import { ImageLightbox } from './ImageLightbox.jsx';
import { trimWindow } from './cutTiming.js';

const MAX_REFS = 9;
// The cut's two stills: the frame the clip opens on and the one it lands on
// (first-last-frame video models travel between them).
const FRAMES = [
  { frame: 'start', label: 'Start', promptLabel: 'Start frame prompt (t = 0)', placeholder: 'Camera first, each principal as a frozen moment placed against a landmark, the light source and colour…' },
  { frame: 'end', label: 'End', promptLabel: 'End frame prompt (where the cut lands)', placeholder: 'Held camera: "Same frame." then only what has changed. Moving camera: the framing the move has reached, each principal in the final state, the same light, set and wardrobe words as the start frame…' },
];
const SIZES = ['extreme_wide', 'wide', 'medium_wide', 'medium', 'medium_close_up', 'close_up', 'extreme_close_up', 'insert', 'over_the_shoulder', 'two_shot'];
const ANGLES = ['eye_level', 'low', 'high', 'dutch', 'top_down'];
const MOVES = ['static', 'push_in', 'pull_out', 'pan', 'tilt', 'truck', 'track', 'handheld', 'crane'];
const DOFS = ['deep', 'shallow'];
const SPENDS = ['identity', 'motion', 'world'];

const words = (s) => String(s || '').replace(/_/g, ' ');

function readError(e) {
  let msg = e?.message || 'Update failed.';
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.error) msg = parsed.error;
  } catch {}
  return msg;
}

// A text field that PATCHes on blur (for the shot-table cells). Keeps a
// local draft so typing never fights the refetch.
function PatchText({ value, onCommit, disabled, rows = 1, placeholder, className }) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);
  const commit = () => {
    if ((draft ?? '') !== (value ?? '')) onCommit(draft);
  };
  if (rows > 1) {
    return <textarea className={className} rows={rows} value={draft} disabled={disabled} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />;
  }
  return <input className={className} type="text" value={draft} disabled={disabled} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />;
}

// Which part of the rendered clip the assembly keeps. Blank = automatic: a
// travelling camera loses its eased head and tail, a clip rendered longer than
// the cut keeps its end. A number (0 included) sets that end by hand. Takes
// effect on the next Assemble — never a re-render.
function CutTrim({ cut, disabled, onPatch }) {
  const clip = Number(cut.video_duration_seconds) || null;
  const w = trimWindow(clip, cut);
  const manual = cut.trim_head_seconds != null || cut.trim_tail_seconds != null;
  const commit = (key) => (raw) => {
    const text = String(raw ?? '').trim();
    if (text === '') return onPatch({ [key]: null });
    const n = Number(text);
    if (Number.isFinite(n) && n >= 0 && n <= 60) onPatch({ [key]: n });
  };
  return (
    <div className="cut-trim" title="What the beat assembly keeps of this clip. Leave blank for automatic.">
      <span className="field-label">Trim</span>
      <label>start <PatchText className="cut-table-short" value={cut.trim_head_seconds ?? ''} disabled={disabled} placeholder="auto" onCommit={commit('trim_head_seconds')} /></label>
      <label>end <PatchText className="cut-table-short" value={cut.trim_tail_seconds ?? ''} disabled={disabled} placeholder="auto" onCommit={commit('trim_tail_seconds')} /></label>
      <span className="cut-trim-note">
        {w ? `assembly uses ${w.start}–${w.end} s of ${clip} s${w.auto ? ' (auto)' : ''}` : clip ? `assembly uses the whole ${clip} s clip${manual ? '' : ' (auto)'}` : 'assembly uses the whole clip'}
      </span>
    </div>
  );
}

// One cut: the shot-table row, its compiled block, its start frame, and the
// video render actions (ComfyUI first, fal.ai as the second provider).
// The pair check (src/web/cutFrameCheck.js): a first-last-frame model animates
// every difference between the two stills, so the server compares them and
// lists what the cut does not perform. Check only looks; Repair edits the
// frame each issue names (either one) and checks again, up to two rounds.
function FramePairCheck({ cut, disabled, onRefresh }) {
  const id = cut._id?.toString?.() || String(cut._id);
  const [job, setJob] = useState(null); // { repair, status }
  const [error, setError] = useState(null);
  const pollRef = useRef(null);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const startImage = cut.start_frame?.image_id ? String(cut.start_frame.image_id) : null;
  const endImage = cut.end_frame?.image_id ? String(cut.end_frame.image_id) : null;
  if (!startImage || !endImage) return null;
  const fc = cut.frame_check || null;
  const current = Boolean(fc) && String(fc.start_image_id || '') === startImage && String(fc.end_image_id || '') === endImage;
  const issues = Array.isArray(fc?.issues) ? fc.issues : [];
  const running = Boolean(job);

  async function run(repair) {
    setError(null);
    setJob({ repair, status: 'queued' });
    try {
      const r = await apiPostJson(`/cut/${id}/frames/check`, { repair });
      pollRef.current = setInterval(async () => {
        try {
          const s = await apiGet(`/cuts/start-frames/job/${r.job_id}`);
          if (['done', 'partial', 'error'].includes(s.job?.status)) {
            clearInterval(pollRef.current);
            pollRef.current = null;
            setJob(null);
            if (s.job.status === 'error') setError(s.job.error || 'The check failed.');
            onRefresh?.();
          } else {
            setJob({ repair, status: s.job?.status || 'running' });
          }
        } catch (e) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setJob(null);
          setError(readError(e));
        }
      }, 2000);
    } catch (e) {
      setJob(null);
      setError(readError(e));
    }
  }

  let badge;
  if (running) badge = <span className="cut-lint-badge">{job.repair ? 'repairing…' : 'checking…'}</span>;
  else if (!fc) badge = <span className="cut-lint-badge" title="The two stills have not been compared yet.">pair not checked</span>;
  else if (!current) badge = <span className="cut-lint-badge" title="A frame was re-rendered after the last check.">check out of date</span>;
  else if (fc.status === 'pass') badge = <span className="cut-lint-badge is-clean" title={fc.rounds ? `Matched after ${fc.rounds} repair round${fc.rounds === 1 ? '' : 's'}.` : 'The two stills hold the same people, clothes, props and layout.'}>frames match{fc.rounds ? ' (repaired)' : ''}</span>;
  else if (fc.status === 'fail') badge = <span className="cut-lint-badge is-fail" title="Differences between the two stills that the cut does not perform — the video model would animate them.">{issues.length} difference{issues.length === 1 ? '' : 's'}{fc.rounds ? ` after ${fc.rounds} repair${fc.rounds === 1 ? '' : 's'}` : ''}</span>;
  else badge = <span className="cut-lint-badge" title="The check could not run.">pair not checked</span>;

  return (
    <div className="cut-pair-check">
      <div className="cut-lint">
        <span className="field-label" style={{ margin: 0 }}>Start ↔ end</span>
        {badge}
        <button type="button" disabled={disabled || running} onClick={() => run(false)} title="Compare the two stills: people, clothing, props, furniture layout, light.">Check frames</button>
        {current && fc.status === 'fail' ? (
          <button type="button" className="primary" disabled={disabled || running} onClick={() => run(true)} title="Edit the frame each difference names so the pair matches, then check again (up to two rounds). Undo on a frame restores it as it was before the repair.">Repair</button>
        ) : null}
      </div>
      {current && fc.status === 'fail' && issues.length ? (
        <ul className="cut-pair-issues">
          {issues.map((it, i) => (
            <li key={i} title={it.fix_instruction || ''}><span className="cut-chip">{words(it.kind)} · fix {it.frame_to_fix}</span> {it.note}</li>
          ))}
        </ul>
      ) : null}
      {error ? <div className="error-banner small">{error}</div> : null}
    </div>
  );
}

export function CutItem({ cut, index, sceneIndex = null, beatId, dialogs = [], disabled, onRefresh, onDelete, onRegenerate = null }) {
  const comfyAvail = useComfyAvailability();
  const comfyOff = comfyAvail ? !comfyAvail.configured : false;
  const id = cut._id?.toString?.() || String(cut._id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [videoOpen, setVideoOpen] = useState(false);
  const [falOpen, setFalOpen] = useState(false);
  const [sfOpen, setSfOpen] = useState(null); // 'start' | 'end' | null
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const [lightbox, setLightbox] = useState(null);
  const [durationDraft, setDurationDraft] = useState(null);

  const cam = cut.camera || {};
  const lint = Array.isArray(cut.lint) ? cut.lint : [];
  const refs = Array.isArray(cut.reference_images) ? cut.reference_images : [];
  const refIds = refs.map((r) => r.image_id?.toString?.() || String(r.image_id));
  const hasVideo = Boolean(cut.video_file_id);
  const comfyJob = useComfyCutJobs()?.jobs?.[id] || null;
  const comfyActive = isComfyJobActive(comfyJob);
  const comfyLabel = !comfyActive
    ? hasVideo ? '🎬 Re-render (ComfyUI)' : '🎬 Generate video (ComfyUI)'
    : comfyJob.status === 'queued'
      ? `⏳ Queued${comfyJob.queue_position ? ` #${comfyJob.queue_position}` : ''} (ComfyUI)`
      : '🎬 Rendering… (ComfyUI)';

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 };

  async function patch(body) {
    setBusy(true);
    setError(null);
    try {
      await apiPatchJson(`/cut/${id}`, body);
      onRefresh?.();
    } catch (e) {
      setError(readError(e));
    } finally {
      setBusy(false);
    }
  }

  const patchCamera = (key, value) => patch({ camera: { ...cam, [key]: value } });

  function commitDuration() {
    if (durationDraft == null) return;
    const raw = String(durationDraft).trim();
    setDurationDraft(null);
    if (raw === '') {
      if (cut.duration_seconds != null) patch({ duration_seconds: null });
      return;
    }
    const n = Math.round(Number(raw) * 2) / 2;
    if (!Number.isFinite(n) || n < 1 || n > 60) {
      setError('Duration must be between 1 and 60 seconds.');
      return;
    }
    if (n !== cut.duration_seconds) patch({ duration_seconds: n });
  }

  async function recheck() {
    setBusy(true);
    setError(null);
    try {
      await apiPostJson(`/cut/${id}/lint`, {});
      onRefresh?.();
    } catch (e) {
      setError(readError(e));
    } finally {
      setBusy(false);
    }
  }

  async function discardVideo() {
    if (!confirm('Discard the generated video for this cut?')) return;
    setBusy(true);
    try {
      await apiDelete(`/cut/${id}/video`);
      onRefresh?.();
    } catch (e) {
      setError(readError(e));
    } finally {
      setBusy(false);
    }
  }

  async function undoFrame(frame) {
    setBusy(true);
    try {
      await apiPostJson(`/cut/${id}/${frame}-frame/undo`, {});
      onRefresh?.();
    } catch (e) {
      setError(readError(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeFrame(frame) {
    if (!confirm(`Remove the rendered ${frame} frame? The still prompt and references are kept.`)) return;
    setBusy(true);
    try {
      await apiDelete(`/cut/${id}/${frame}-frame`);
      onRefresh?.();
    } catch (e) {
      setError(readError(e));
    } finally {
      setBusy(false);
    }
  }

  const label = sceneIndex != null ? `${sceneIndex}.${cut.cut_index ?? index + 1}` : `#${index + 1}`;
  const inFrame = Array.isArray(cut.in_frame) ? cut.in_frame : [];

  return (
    <div ref={setNodeRef} style={style} className="dialog-item video-prompt-item cut-item">
      <div className="dialog-item-header">
        <button type="button" className="dialog-drag-handle" aria-label="Drag to reorder" {...attributes} {...listeners}>⋮⋮</button>
        <span className="video-prompt-index">{label}</span>
        <div className="video-prompt-title">
          <CollabField field={`item:${id}:title`} placeholder="Cut title…" />
        </div>
        <label className="video-prompt-duration" title="How long this cut runs in the assembled film, in seconds. A render snaps it up to what the model can do and the assembly trims the rest.">
          <span className="field-label" style={{ margin: 0 }}>Duration</span>
          <input type="number" min={1} max={60} step={0.5} value={durationDraft ?? (cut.duration_seconds ?? '')} disabled={busy || disabled}
            onChange={(e) => setDurationDraft(e.target.value)} onBlur={commitDuration} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} style={{ width: 64 }} />
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>s</span>
        </label>
        {onRegenerate ? (
          <button type="button" onClick={onRegenerate} disabled={busy || disabled} title="Plan this one cut again from scratch — shot table row, video prompt, start and end still prompts — keeping the rest of the scene. Its frames and clip are replaced.">↻ Regenerate</button>
        ) : null}
        <button type="button" className="dialog-item-delete" onClick={onDelete} disabled={busy || disabled}>Delete</button>
      </div>

      <div className="dialog-item-fields">
        {error && <div className="error-banner small">{error}</div>}

        <div className="cut-chips">
          {cam.size ? <span className="cut-chip" title="Framing size">{words(cam.size)}</span> : null}
          {cam.angle ? <span className="cut-chip" title="Angle">{words(cam.angle)}</span> : null}
          {cam.lens_mm ? <span className="cut-chip" title="Lens">{cam.lens_mm}mm</span> : null}
          {cam.movement ? <span className="cut-chip" title={[cam.motivation, cam.travel].filter(Boolean).join(' — ') || 'Camera move'}>{words(cam.movement)}</span> : null}
          {cam.depth_of_field ? <span className="cut-chip" title="Depth of field">{cam.depth_of_field} focus</span> : null}
          {cam.side ? <span className="cut-chip cut-chip-side" title={cam.side}>{cam.side}</span> : null}
          {cut.primary_spend ? <span className="cut-chip cut-chip-spend" title="Primary spend">{cut.primary_spend}</span> : null}
          {cut.reaction ? <span className="cut-chip cut-chip-flag">reaction</span> : null}
          {cut.crossing ? <span className="cut-chip cut-chip-flag">crossing</span> : null}
          <button type="button" className="cut-table-toggle" onClick={() => setTableOpen((v) => !v)}>
            {tableOpen ? 'Hide shot table' : 'Shot table…'}
          </button>
        </div>

        {tableOpen ? (
          <div className="cut-table">
            <div className="cut-table-row"><span>Size</span>
              <select value={cam.size || ''} disabled={busy || disabled} onChange={(e) => patchCamera('size', e.target.value || null)}>
                <option value="">—</option>{SIZES.map((s) => <option key={s} value={s}>{words(s)}</option>)}
              </select>
              <span>Angle</span>
              <select value={cam.angle || ''} disabled={busy || disabled} onChange={(e) => patchCamera('angle', e.target.value || null)}>
                <option value="">—</option>{ANGLES.map((s) => <option key={s} value={s}>{words(s)}</option>)}
              </select>
              <span>Lens</span>
              <PatchText className="cut-table-short" value={cam.lens_mm ?? ''} disabled={busy || disabled} placeholder="mm" onCommit={(v) => patchCamera('lens_mm', v === '' ? null : Number(v))} />
            </div>
            <div className="cut-table-row"><span>Move</span>
              <select value={cam.movement || ''} disabled={busy || disabled} onChange={(e) => patchCamera('movement', e.target.value || null)}>
                <option value="">—</option>{MOVES.map((s) => <option key={s} value={s}>{words(s)}</option>)}
              </select>
              <span>Motivation</span>
              <PatchText value={cam.motivation} disabled={busy || disabled} placeholder="What the move follows or reveals" onCommit={(v) => patchCamera('motivation', v)} />
              <span>Focus</span>
              <select value={cam.depth_of_field || ''} disabled={busy || disabled} onChange={(e) => patchCamera('depth_of_field', e.target.value || null)}>
                <option value="">—</option>{DOFS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {cam.movement && cam.movement !== 'static' && cam.movement !== 'handheld' ? (
              <div className="cut-table-row" title="How far the frame moves between the first and last frame. Speed = travel ÷ duration: a slow pan covers about one frame-width in 6–8 s.">
                <span>Travel</span>
                <PatchText value={cam.travel} disabled={busy || disabled} placeholder="from the box office to the concession counter" onCommit={(v) => patchCamera('travel', v)} />
                <span>Widths</span>
                <PatchText className="cut-table-short" value={cam.travel_widths ?? ''} disabled={busy || disabled} placeholder="1" onCommit={(v) => patchCamera('travel_widths', v === '' ? null : Number(v))} />
              </div>
            ) : null}
            <div className="cut-table-row"><span>Height</span>
              <PatchText value={cam.height} disabled={busy || disabled} placeholder="deck height, seated eye level…" onCommit={(v) => patchCamera('height', v)} />
              <span>Side</span>
              <PatchText value={cam.side} disabled={busy || disabled} placeholder="from the counter end, looking down the aisle…" onCommit={(v) => patchCamera('side', v)} />
            </div>
            <div className="cut-table-row"><span>Light</span>
              <PatchText value={cam.lighting} disabled={busy || disabled} placeholder="source + colour, the floor plan's words" onCommit={(v) => patchCamera('lighting', v)} />
              <span>Spend</span>
              <select value={cut.primary_spend || ''} disabled={busy || disabled} onChange={(e) => patch({ primary_spend: e.target.value || null })}>
                <option value="">—</option>{SPENDS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="cut-table-row cut-table-inframe"><span>In frame</span>
              <div>
                {inFrame.length ? inFrame.map((p) => (
                  <div key={p.character} className="cut-inframe-line">
                    <strong>{p.character}</strong>{p.acts ? ' [acts]' : ''} — {p.position || '?'} — facing {p.facing || '?'}
                  </div>
                )) : <em style={{ color: 'var(--fg-muted)' }}>no one in frame</em>}
              </div>
            </div>
            <div className="cut-table-row"><span>Eyeline</span>
              <PatchText value={cut.eyeline} disabled={busy || disabled} onCommit={(v) => patch({ eyeline: v })} />
            </div>
            <div className="cut-table-row"><span>Action{cut.action_by ? ` (${cut.action_by})` : ''}</span>
              <PatchText rows={2} value={cut.action} disabled={busy || disabled} onCommit={(v) => patch({ action: v })} />
            </div>
            <div className="cut-table-row"><span>Others</span>
              <PatchText rows={2} value={cut.others} disabled={busy || disabled} placeholder="Idle business for everyone else in frame" onCommit={(v) => patch({ others: v })} />
            </div>
            <div className="cut-table-row"><span>Last frame</span>
              <PatchText value={cut.last_frame} disabled={busy || disabled} onCommit={(v) => patch({ last_frame: v })} />
            </div>
            <div className="cut-table-row"><span>Sound</span>
              <PatchText value={cut.sound} disabled={busy || disabled} onCommit={(v) => patch({ sound: v })} />
            </div>
            <div className="cut-table-row"><span>Felt intent</span>
              <PatchText value={cut.felt_intent} disabled={busy || disabled} onCommit={(v) => patch({ felt_intent: v })} />
            </div>
          </div>
        ) : null}

        {dialogs.length ? (
          <div className="cut-dialog-lines">
            <span className="field-label" style={{ marginRight: 8 }}>Covers lines</span>
            <DialogLineChips value={cut.dialog_ids || []} dialogs={dialogs} disabled={busy || disabled} onChange={(ids) => patch({ dialog_ids: ids })} />
          </div>
        ) : null}

        {lint.length ? (
          <div className="cut-lint">
            {lint.map((f, i) => (
              <span key={i} className="cut-lint-badge" title={f.message}>{words(f.code)}</span>
            ))}
            <button type="button" className="cut-table-toggle" disabled={busy || disabled} onClick={recheck} title="Re-run the checks against the current block">Re-check</button>
          </div>
        ) : (
          <div className="cut-lint cut-lint-clean">
            <span className="cut-lint-badge is-clean" title="No lint findings">clean</span>
            <button type="button" className="cut-table-toggle" disabled={busy || disabled} onClick={recheck}>Re-check</button>
          </div>
        )}

        <div className="dialog-item-body">
          <div className="field-label">Block (the prompt the video model receives)</div>
          <CollabField field={`item:${id}:prompt`} multiline placeholder="Camera in words → the one action → idle business → Sound: → the lock line → End with …" />
        </div>

        <div className="cut-lock">
          <div className="cut-lock-row"><span className="field-label">Lock line</span>
            <PatchText value={cut.lock_line} disabled={busy || disabled} placeholder="Same light: … <Name>: age band, hair, wardrobe, position, facing … Camera side." onCommit={(v) => patch({ lock_line: v })} />
          </div>
          <div className="cut-lock-row"><span className="field-label">Exclusions</span>
            <PatchText value={(cut.exclusions || []).join('\n')} rows={Math.max(1, (cut.exclusions || []).length)} disabled={busy || disabled} placeholder="Do not show … yet. (one per line)" onCommit={(v) => patch({ exclusions: v.split('\n').map((s) => s.trim()).filter(Boolean) })} />
          </div>
        </div>

        {FRAMES.map(({ frame, label: frameLabel, promptLabel, placeholder }) => {
          const sf = cut[`${frame}_frame`] || null;
          const sfImage = sf?.image_id ? String(sf.image_id) : null;
          // The end frame is built against the start frame; once that is
          // re-rendered the pair no longer matches.
          const startImage = cut.start_frame?.image_id ? String(cut.start_frame.image_id) : null;
          const builtOn = sf?.continuity_image_id ? String(sf.continuity_image_id) : null;
          // A pair the check has passed is a match whatever each was built on.
          const fc = cut.frame_check;
          const checkedOk = fc?.status === 'pass' && String(fc.start_image_id || '') === startImage && String(fc.end_image_id || '') === sfImage;
          const stale = frame === 'end' && sfImage && startImage && builtOn !== startImage && !checkedOk;
          return (
            <div key={frame} className="cut-start-frame">
              <div className="cut-sf-thumb">
                {sfImage ? (
                  <img src={thumbUrl(sfImage)} alt={`${frameLabel} frame`} loading="lazy" onClick={() => setLightbox({ src: imageUrl(sfImage), alt: `${frameLabel} frame` })} />
                ) : (
                  <div className="cut-sf-placeholder">no {frame} frame</div>
                )}
                <div className="cut-sf-buttons">
                  <button type="button" className={sfImage ? '' : 'primary'} disabled={busy || disabled} onClick={() => setSfOpen(frame)}>
                    {sfImage ? '🖼 Re-render / edit…' : `🖼 Render ${frame} frame…`}
                  </button>
                  {sf?.previous_image_id ? <button type="button" disabled={busy || disabled} onClick={() => undoFrame(frame)} title="Restore the previous frame">Undo</button> : null}
                  {sfImage ? <button type="button" className="danger" disabled={busy || disabled} onClick={() => removeFrame(frame)}>Remove</button> : null}
                </div>
                {frame === 'end' && (sf?.derive || stale) ? (
                  <div className="cut-sf-flags">
                    {sf?.derive ? <span className="cut-chip" title="Held camera: this frame is made by editing the start frame, so the set, the props and the clothing stay identical. Its prompt is the list of what changes.">derived from start frame</span> : null}
                    {stale ? <span className="cut-chip cut-chip-flag" title={builtOn ? 'The start frame was re-rendered after this end frame was made. Re-render the end frame so the pair matches.' : 'This end frame was made without the start frame. Re-render it so the pair matches.'}>start frame changed</span> : null}
                  </div>
                ) : null}
                {sf?.reference_ids?.length && !(frame === 'end' && sf?.derive) ? (
                  <div className="cut-sf-refs">
                    {sf.reference_ids.map((rid) => <img key={String(rid)} src={thumbUrl(String(rid))} alt="" loading="lazy" title="Reference artwork" />)}
                  </div>
                ) : null}
              </div>
              <div className="cut-sf-prompt">
                <div className="field-label">{promptLabel}</div>
                <CollabField field={`item:${id}:${frame}_frame_prompt`} multiline placeholder={placeholder} />
              </div>
            </div>
          );
        })}

        <FramePairCheck cut={cut} disabled={busy || disabled} onRefresh={onRefresh} />

        <details className="cut-r2v">
          <summary>Reference images for reference-to-video models (@Image1…) — {refs.length || 'none'}</summary>
          <div className="video-prompt-ref-strip" style={{ marginTop: 6 }}>
            {refs.map((r, i) => {
              const rid = refIds[i];
              return (
                <div key={rid} className="video-prompt-ref-chip" title={r.label || ''}>
                  <img src={thumbUrl(rid)} alt={r.label || `Reference ${i + 1}`} loading="lazy" />
                  <span className="video-prompt-ref-handle">@Image{i + 1}</span>
                  <span className="video-prompt-ref-owner">{r.owner_name || ''}</span>
                  <div className="video-prompt-ref-actions">
                    <button type="button" disabled={busy || disabled || i === 0} onClick={() => { const n = [...refIds]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; patch({ reference_image_ids: n }); }}>◀</button>
                    <button type="button" disabled={busy || disabled || i === refs.length - 1} onClick={() => { const n = [...refIds]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; patch({ reference_image_ids: n }); }}>▶</button>
                    <button type="button" disabled={busy || disabled} onClick={() => patch({ reference_image_ids: refIds.filter((_, k) => k !== i) })}>×</button>
                  </div>
                </div>
              );
            })}
            <button type="button" className="video-prompt-ref-add" disabled={busy || disabled || refs.length >= MAX_REFS} onClick={() => setPickerOpen(true)}>+ Add reference</button>
          </div>
          {cut.reference_binding ? <div className="cut-binding"><span className="field-label">Binding</span> {cut.reference_binding}</div> : null}
        </details>

        <div className="video-prompt-actions">
          <button type="button" className="primary" disabled={!comfyActive && (busy || disabled || comfyOff)} onClick={() => setVideoOpen(true)}
            title={comfyOff ? COMFY_DISABLED_MESSAGE : comfyActive ? 'Show this render\'s progress' : 'Render this cut with a ComfyUI model'}>
            {comfyLabel}{comfyOff ? ' — disabled' : ''}
          </button>
          <button type="button" disabled={busy || disabled} onClick={() => setFalOpen(true)} title="Render this cut with a fal.ai model">fal.ai…</button>
          {hasVideo ? <button type="button" className="danger" disabled={busy || disabled || comfyActive} onClick={discardVideo}>Discard video</button> : null}
        </div>

        {hasVideo ? <CutTrim cut={cut} disabled={busy || disabled} onPatch={patch} /> : null}

        <ClipVideoPanel sb={cut} />
      </div>

      <ComfyVideoDialog open={videoOpen} onClose={() => setVideoOpen(false)} cut={cut} beatId={beatId} onRefresh={onRefresh} />
      <GenerateVideoDialog open={falOpen} onClose={() => setFalOpen(false)} storyboardId={id} sb={cut} onRefresh={onRefresh} promptField={`item:${id}:prompt`} />
      <CutStartFrameDialog open={Boolean(sfOpen)} frame={sfOpen || 'start'} onClose={() => setSfOpen(null)} cut={cut} beatId={beatId} onRefresh={onRefresh} />
      <PromptReferencePicker open={pickerOpen} beatId={beatId} existingIds={refIds} maxTotal={MAX_REFS} onClose={() => setPickerOpen(false)}
        onPick={(ids) => { setPickerOpen(false); patch({ reference_image_ids: [...refIds, ...ids] }); }} />
      {lightbox ? <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} /> : null}
    </div>
  );
}
