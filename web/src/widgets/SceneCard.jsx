import { useEffect, useRef, useState } from 'react';
import { apiDelete, apiGet, apiPatchJson, apiPostJson } from '../api.js';
import { CollabField } from '../editor/CollabField.jsx';
import { BeatVideoPanel } from './BeatVideoPanel.jsx';

const TERMINAL = new Set(['done', 'error']);

export const DIRECTORS_READ_FIELDS = [
  'dramatic_function', 'turn', 'pov', 'power_shift', 'hidden_want', 'obstacle_tactic',
  'subtext', 'suppressed_behavior', 'non_transferable_detail', 'stock_solution_refused',
];
const SCOPE_BUCKETS = ['already_happened', 'this_scene_only', 'reserved_for_later', 'do_not_show_yet'];
const words = (s) => String(s || '').replace(/_/g, ' ');

function readError(e) {
  let msg = e?.message || 'Update failed.';
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.error) msg = parsed.error;
  } catch {}
  return msg;
}

function PatchText({ value, onCommit, disabled, rows = 1, placeholder, className }) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);
  const commit = () => { if ((draft ?? '') !== (value ?? '')) onCommit(draft); };
  if (rows > 1) return <textarea className={className} rows={rows} value={draft} disabled={disabled} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />;
  return <input className={className} type="text" value={draft} disabled={disabled} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />;
}

export function LoadBadge({ load }) {
  if (!load || !load.verdict) return null;
  const s = Number.isFinite(load.s) ? load.s.toFixed(1) : '?';
  const title = `${load.beats ?? '?'} beats + ${load.load_points ?? '?'} load over ${load.total_seconds ?? '?'} s → S = ${s}. Safe ≥ 3, Stretch 2–3, Ambitious < 2 (split a cut rather than cram).`;
  return <span className={`scene-load-badge is-${load.verdict}`} title={title}>{load.verdict} · S {s}</span>;
}

// One scene: its header (title, slug, load), the collapsible director's
// read / scope / floor plan, and its cuts (children).
export function SceneCard({ scene, index, count, beatId, disabled, onRefresh, onReplan, onMove, children }) {
  const id = scene._id?.toString?.() || String(scene._id);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [assembling, setAssembling] = useState(false);
  const pollRef = useRef(null);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const cuts = scene.cuts || [];
  const unrendered = cuts.filter((c) => !c.video_file_id).length;
  const canAssemble = cuts.length > 0 && unrendered === 0;

  // Join this scene's cut clips into one MP4 (background job, polled).
  async function assemble() {
    setError(null);
    setAssembling(true);
    try {
      const r = await apiPostJson(`/video-scene/${id}/assemble`, {});
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const s = await apiGet(`/cuts/assemble/job/${r.job_id}`);
          if (TERMINAL.has(s.job?.status)) {
            clearInterval(pollRef.current);
            pollRef.current = null;
            setAssembling(false);
            if (s.job.status === 'error') setError(s.job.error || 'Assembly failed.');
            onRefresh?.();
          }
        } catch (e) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setAssembling(false);
          setError(readError(e));
        }
      }, 2000);
    } catch (e) {
      setAssembling(false);
      setError(readError(e));
    }
  }

  async function patch(body) {
    setBusy(true);
    setError(null);
    try {
      await apiPatchJson(`/video-scene/${id}`, body);
      onRefresh?.();
    } catch (e) {
      setError(readError(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete scene ${index + 1} "${scene.title || ''}" and its ${(scene.cuts || []).length} cut(s)?`)) return;
    setBusy(true);
    try {
      await apiDelete(`/video-scene/${id}`);
      onRefresh?.();
    } catch (e) {
      setError(readError(e));
    } finally {
      setBusy(false);
    }
  }

  const read = scene.directors_read || {};
  const scope = scene.scope || {};

  return (
    <section className="scene-card">
      <div className="scene-card-header">
        <span className="scene-card-index">Scene {index + 1}</span>
        <PatchText className="scene-card-title" value={scene.title} disabled={busy || disabled} placeholder="Scene title" onCommit={(v) => patch({ title: v })} />
        <PatchText className="scene-card-slug" value={scene.slug} disabled={busy || disabled} placeholder="INT./EXT. LOCATION — TIME" onCommit={(v) => patch({ slug: v })} />
        <LoadBadge load={scene.load} />
        <div className="scene-card-actions">
          <button type="button" title="Move scene up" disabled={busy || disabled || index === 0} onClick={() => onMove?.(-1)}>▲</button>
          <button type="button" title="Move scene down" disabled={busy || disabled || index === count - 1} onClick={() => onMove?.(+1)}>▼</button>
          <button type="button" onClick={() => setOpen((v) => !v)}>{open ? 'Hide read' : "Director's read…"}</button>
          <button type="button" disabled={busy || disabled} onClick={() => onReplan?.(scene)} title="Re-plan this scene's cuts (table → blocks → still prompts); other scenes are kept">↻ Replan cuts</button>
          <button type="button" disabled={busy || disabled || assembling || !canAssemble} onClick={assemble}
            title={!cuts.length ? 'No cuts in this scene yet' : unrendered ? `${unrendered} cut(s) have no video yet` : 'Join this scene\'s cut clips into one MP4'}>
            {assembling ? 'Assembling…' : '🎞 Assemble scene'}
          </button>
          <button type="button" className="danger" disabled={busy || disabled} onClick={remove}>Delete scene</button>
        </div>
      </div>
      {error ? <div className="error-banner small">{error}</div> : null}
      <div className="scene-card-meta">
        <span>Sets: {(scene.set_names || []).join(', ') || '—'}</span>
        <span>Characters: {(scene.character_names || []).join(', ') || '—'}</span>
        {scene.text_span?.starts_with ? <span title={`…${scene.text_span.ends_with || ''}`}>Starts: “{scene.text_span.starts_with}”</span> : null}
      </div>

      {open ? (
        <div className="scene-card-read">
          <div className="scene-read-row">
            <span className="field-label">Intention</span>
            <PatchText value={scene.intention} disabled={busy || disabled} placeholder="What this scene must do to the audience, in one sentence" onCommit={(v) => patch({ intention: v })} />
          </div>
          <div className="scene-read-grid">
            {DIRECTORS_READ_FIELDS.map((f) => (
              <label key={f} className="scene-read-cell">
                <span className="field-label">{words(f)}</span>
                <PatchText rows={2} value={read[f]} disabled={busy || disabled} onCommit={(v) => patch({ directors_read: { ...read, [f]: v } })} />
              </label>
            ))}
          </div>
          <div className="scene-read-grid scene-scope-grid">
            {SCOPE_BUCKETS.map((b) => (
              <label key={b} className="scene-read-cell">
                <span className="field-label">{words(b)}</span>
                <PatchText rows={2} value={(scope[b] || []).join('\n')} disabled={busy || disabled} placeholder="one fact per line" onCommit={(v) => patch({ scope: { ...scope, [b]: v.split('\n').map((s) => s.trim()).filter(Boolean) } })} />
              </label>
            ))}
          </div>
          <div className="scene-floor-plan">
            <CollabField label="Floor plan" field={`scene:${id}:floor_plan`} multiline placeholder="Landmarks, who is where at the start and facing what, the light source and its colour, the axis." />
          </div>
        </div>
      ) : null}

      <BeatVideoPanel entity={scene} prefix="video" title="Scene video" clipNoun="cut" deletePath={`/video-scene/${id}/video`} onRefresh={onRefresh} className="scene-video-panel" />

      <div className="scene-card-cuts">{children}</div>
    </section>
  );
}
