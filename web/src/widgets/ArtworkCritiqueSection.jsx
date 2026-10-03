// The Artwork half of the Critique tab: does the art library hold the
// pictures this beat's writing needs? Runs the server's artwork critique
// (requirements → vision audit → proposals; SSE progress), shows each
// subject's coverage checklist and the issues in its existing artwork, and
// lets the user tick the drafted proposals and render them onto the owning
// set / character. Artwork broadcasts go to the set/character rooms, not the
// beat room, so the generation job is polled.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPatchJson, apiPostJson, apiSseUrl, thumbUrl } from '../api.js';
import { readStoredCatalogModel, writeStoredImageModel } from './imageModels.js';
import { ImageModelSelect } from './ImageModelSelect.jsx';
import { GenerationProgress } from './GenerationProgress.jsx';
import { CritiqueSection } from './CritiqueSection.jsx';
import { scoreBand, formatScore, coverageBand } from './critiqueDisplay.js';
import { ClimbDialog, ClimbPanel, ClimbChip, isClimbRunning } from './Climb.jsx';

const MODEL_STORAGE_KEY = 'screenplay.artworkcritique.model';
const POLL_MS = 2000;
const TERMINAL = new Set(['done', 'partial', 'error']);

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
function hostPath(kind, id) { return `/${kind === 'set' ? 'set' : 'character'}/${id}`; }
const STATUS_GLYPH = { covered: '✓', partial: '◐', missing: '✗' };
const CATEGORY_LABEL = {
  view: 'view', sub_location: 'sub-location', vehicle: 'vehicle', building: 'building', prop: 'prop', light: 'light',
  costume: 'costume', expression: 'expression', pose: 'pose', action: 'action', held_prop: 'held prop',
};

// The fix panel under an audited image: the audit's suggested edit, editable,
// applied as an in-line edit of THAT image on its set / character
// (POST …/artworks/:aid/fix). The edit runs in the background on the host's
// room, so the section polls the entry until the fix settles; the thumbnail
// then shows the new image and Undo swaps the old one back.
function ArtworkFixPanel({ artwork, model, onModel, onFix, onUndo, busy }) {
  const fix = artwork.fix || null;
  const [draft, setDraft] = useState(null);
  const prompt = draft ?? fix?.prompt ?? artwork.suggested_edit ?? '';
  const generating = fix?.status === 'generating';
  const canFix = !busy && !generating && prompt.trim().length > 0;
  return (
    <div className="artwork-critique-fix">
      <textarea
        className="artwork-critique-fix-prompt"
        value={prompt}
        disabled={generating}
        placeholder="What to change in this image (applied as an edit of the current picture)"
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="artwork-critique-fix-tools">
        <ImageModelSelect value={model} onChange={onModel} disabled={generating} collapsible />
        <button type="button" className="primary small" disabled={!canFix} onClick={() => onFix(prompt.trim())}>
          {generating ? 'Fixing…' : fix?.status === 'done' ? 'Fix again' : 'Fix this image'}
        </button>
        {fix?.status === 'done' ? <button type="button" className="small" disabled={busy} onClick={onUndo}>Undo fix</button> : null}
        {fix?.status === 'undone' ? <span className="artwork-critique-muted">Fix undone — the image is back to the one that was critiqued.</span> : null}
      </div>
      {generating ? <div className="artwork-critique-muted">Editing the image with {fix.model}… the thumbnail updates when it is done.</div> : null}
      {fix?.status === 'done' ? (
        <div className="artwork-critique-fix-done">
          {fix.source_image_id ? <img src={thumbUrl(fix.source_image_id)} alt="before" title="Before the fix" /> : null}
          <span>→</span>
          <img src={thumbUrl(fix.result_image_id)} alt="after" title="After the fix" />
          <span className="artwork-critique-muted">Fixed. The issues above describe the picture before the edit — re-run the critique to check the new one.</span>
        </div>
      ) : null}
      {fix?.status === 'error' ? <div className="critique-error">The fix failed{fix.error_message ? `: ${fix.error_message}` : ''}. Edit the instruction and try again.</div> : null}
    </div>
  );
}

function ArtworkStrip({ artworks, model, onModel, onFix, onUndo, busy }) {
  const [openId, setOpenId] = useState(null);
  if (!artworks?.length) return <div className="artwork-critique-empty">No artwork on file.</div>;
  const open = artworks.find((a) => String(a.artwork_id) === openId) || null;
  return (
    <>
      <div className="artwork-critique-strip">
        {artworks.map((a) => {
          const id = String(a.artwork_id);
          const n = (a.issues || []).length;
          const fixState = a.fix?.status;
          return (
            <button
              type="button"
              key={id}
              className={`artwork-critique-thumb${openId === id ? ' is-open' : ''}${n ? ' has-issues' : ''}${fixState === 'done' ? ' is-fixed' : ''}`}
              title={a.name || 'artwork'}
              onClick={() => setOpenId(openId === id ? null : id)}
            >
              <img src={thumbUrl(a.result_image_id)} alt={a.name || ''} />
              {n ? <span className="issue-badge">{n}</span> : null}
              {fixState === 'generating' ? <span className="fix-badge">fixing…</span> : fixState === 'done' ? <span className="fix-badge">fixed</span> : null}
            </button>
          );
        })}
      </div>
      {open && (
        <div className="artwork-critique-issues">
          <div className="artwork-critique-issues-title">{open.name || 'Artwork'}</div>
          {(open.issues || []).length ? (
            <ul>
              {open.issues.map((i, n) => <li key={n}><span className="issue-chip sev-should_fix">{i.kind.replace(/_/g, ' ')}</span> {i.note}</li>)}
            </ul>
          ) : <div className="artwork-critique-muted">Matches the writing.</div>}
          {open.suggested_edit || open.fix ? (
            <ArtworkFixPanel
              key={String(open.artwork_id)}
              artwork={open}
              model={model}
              onModel={onModel}
              busy={busy}
              onFix={(prompt) => onFix(String(open.artwork_id), prompt)}
              onUndo={() => onUndo(String(open.artwork_id))}
            />
          ) : null}
        </div>
      )}
    </>
  );
}

function RequirementList({ requirements, artworksById }) {
  if (!requirements?.length) return <div className="artwork-critique-muted">The beat imposes no requirement on this subject.</div>;
  return (
    <ul className="artwork-critique-reqs">
      {requirements.map((r) => (
        <li className={`req-row req-${r.status}`} key={r.id}>
          <span className="req-glyph">{STATUS_GLYPH[r.status] || '·'}</span>
          <span className="req-body">
            <span className="req-head">
              <span className="critique-scope">{CATEGORY_LABEL[r.category] || r.category}</span>
              <span className="req-summary">{r.summary}</span>
              {r.importance === 'essential' ? <span className="critique-scope scope-story">essential</span> : null}
              {(r.covered_by || []).map((id) => {
                const a = artworksById.get(String(id));
                return a ? <img key={String(id)} className="req-thumb" src={thumbUrl(a.result_image_id)} alt={a.name || ''} title={a.name || ''} /> : null;
              })}
            </span>
            {r.detail ? <span className="req-detail">{r.detail}</span> : null}
            {r.quote ? <blockquote className="lens-quote"><span className="lens-quote-text">“{r.quote}”</span></blockquote> : null}
            {r.note ? <span className="req-note">{r.note}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SubjectCard({ subject, fixProps }) {
  const artworksById = useMemo(() => new Map((subject.artworks || []).map((a) => [String(a.artwork_id), a])), [subject.artworks]);
  const reqs = subject.requirements || [];
  const covered = reqs.filter((r) => r.status === 'covered').length;
  return (
    <div className="artwork-critique-subject">
      <div className="artwork-critique-subject-head">
        <span className={`critique-scope ${subject.kind === 'set' ? 'scope-story' : ''}`}>{subject.kind === 'set' ? 'Set' : 'Character'}</span>
        <Link to={hostPath(subject.kind, subject.id)} className="artwork-critique-subject-name">{subject.name}</Link>
        {subject.status === 'pending' && <span className="artwork-critique-muted">waiting…</span>}
        {subject.status === 'error' && <span className="critique-error">errored: {subject.error_message}</span>}
        {subject.status === 'done' && (
          <>
            <span className="artwork-critique-muted">{covered}/{reqs.length} covered</span>
            {typeof subject.accuracy_score === 'number' && (
              <>
                <span className="artwork-critique-muted">· accuracy</span>
                <span className={`lens-score ${scoreBand(subject.accuracy_score)}`}>{formatScore(subject.accuracy_score)}</span>
                <span className="lens-bar"><i className={scoreBand(subject.accuracy_score)} style={{ width: `${(subject.accuracy_score / 10) * 100}%` }} /></span>
              </>
            )}
          </>
        )}
      </div>
      {subject.summary ? <div className="artwork-critique-summary">{subject.summary}</div> : null}
      <ArtworkStrip artworks={subject.artworks} {...fixProps} />
      <RequirementList requirements={reqs} artworksById={artworksById} />
    </div>
  );
}

function ProposalRow({ p, checked, onToggle, override, onOverride, requirementLabel, generating, onDismiss, onRestore }) {
  const selectable = p.status === 'proposed' || p.status === 'error';
  const refs = override?.reference_image_ids ?? (p.reference_image_ids || []).map(String);
  const prompt = override?.prompt ?? p.prompt;
  return (
    <div className={`artwork-critique-proposal is-${p.status}`}>
      <div className="proposal-check">
        {selectable ? <input type="checkbox" checked={checked} disabled={generating} onChange={onToggle} /> : null}
      </div>
      <div className="proposal-main">
        <div className="proposal-head">
          <span className={`critique-scope ${p.host_type === 'set' ? 'scope-story' : ''}`}>{p.host_type === 'set' ? 'Set' : 'Character'}</span>
          <Link to={hostPath(p.host_type, p.host_id)}>{p.host_name}</Link>
          <b className="proposal-name">{p.name}</b>
          {p.status === 'dismissed' ? <span className="artwork-critique-muted">dismissed</span> : null}
          {p.promoted_wardrobe ? <span className="wardrobe-chip" title="This render became the character's wardrobe plate">👔 promoted to plate</span> : null}
        </div>
        <div className="proposal-covers">
          Covers: {(p.requirement_ids || []).map((id) => requirementLabel(id)).filter(Boolean).join(' · ') || '—'}
          {p.rationale ? <span className="artwork-critique-muted"> — {p.rationale}</span> : null}
        </div>
        {selectable ? (
          <textarea
            className="proposal-prompt"
            value={prompt}
            disabled={generating}
            onChange={(e) => onOverride({ prompt: e.target.value })}
          />
        ) : (
          <div className="proposal-prompt-static">{p.prompt}</div>
        )}
        {refs.length > 0 && (
          <div className="proposal-refs">
            {refs.map((id) => (
              <span className="proposal-ref" key={id}>
                <img src={thumbUrl(id)} alt="" />
                {selectable && !generating ? (
                  <button type="button" className="proposal-ref-x" title="Drop this reference" onClick={() => onOverride({ reference_image_ids: refs.filter((r) => r !== id) })}>×</button>
                ) : null}
              </span>
            ))}
          </div>
        )}
        {refs.length === 0 && selectable ? <div className="artwork-critique-muted">No reference artwork — the look comes from the prompt alone.</div> : null}
      </div>
      <div className="proposal-status">
        {p.status === 'generating' && <span className="artwork-critique-muted">generating…</span>}
        {p.status === 'done' && p.artwork_id && (
          <Link to={hostPath(p.host_type, p.host_id)} className="proposal-done" title="View on its page">
            {p.result_image_id ? <img src={thumbUrl(p.result_image_id)} alt="" /> : null}
            <span>View on {p.host_type}</span>
          </Link>
        )}
        {p.status === 'error' && <span className="critique-error" title={p.error_message}>failed{p.error_message ? `: ${p.error_message}` : ''}</span>}
        {selectable && !generating ? <button type="button" className="small" onClick={onDismiss}>Dismiss</button> : null}
        {p.status === 'dismissed' && !generating ? <button type="button" className="small" onClick={onRestore}>Restore</button> : null}
      </div>
    </div>
  );
}

// The wardrobe lock strip: one row per character in the beat — the plate,
// the character's default outfit (its `wardrobe` field) and an override for
// THIS beat (`PATCH /beat/:id { wardrobe_overrides }`, blank clears).
function WardrobeStrip({ beatId, refreshKey }) {
  const [rows, setRows] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [drafts, setDrafts] = useState({});
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    apiGet(`/beat/${beatId}/characters`).then((r) => {
      if (!alive) return;
      setRows(r.characters || []);
      setOverrides(r.wardrobe_overrides || {});
      setDrafts({});
    }).catch((e) => { if (alive) setError(e?.message || 'Could not load the cast'); });
    return () => { alive = false; };
  }, [beatId, refreshKey]);

  async function commit(id) {
    const text = (drafts[id] ?? overrides[id] ?? '').trim();
    if (text === (overrides[id] || '')) return;
    setSaving(id);
    try {
      await apiPatchJson(`/beat/${beatId}`, { wardrobe_overrides: { [id]: text } });
      setOverrides((o) => { const n = { ...o }; if (text) n[id] = text; else delete n[id]; return n; });
      setDrafts((d) => { const n = { ...d }; delete n[id]; return n; });
    } catch (e) {
      setError(e?.message || 'Could not save the override');
    } finally {
      setSaving(null);
    }
  }

  if (error) return <div className="critique-error">{error}</div>;
  if (!rows || !rows.length) return null;
  return (
    <div className="wardrobe-strip">
      <div className="wardrobe-strip-head">
        <b>Wardrobe lock</b>
        <span className="artwork-critique-muted">Every render of a character copies the plate and quotes these words. An override applies to this beat only.</span>
      </div>
      {rows.map((c) => {
        const id = String(c._id);
        const base = String(c.fields?.wardrobe || '').trim();
        const value = drafts[id] ?? overrides[id] ?? '';
        return (
          <div className="wardrobe-row" key={id}>
            <div className="wardrobe-plate" title={c.wardrobe_image_id ? 'Wardrobe plate' : 'No wardrobe plate yet'}>
              {c.wardrobe_image_id ? <img src={thumbUrl(c.wardrobe_image_id)} alt="" /> : <span className="wardrobe-plate-none">no plate</span>}
            </div>
            <div className="wardrobe-main">
              <div className="wardrobe-name"><Link to={hostPath('character', id)}>{c.name}</Link>{c.wardrobe_image_id ? <span className="wardrobe-chip">👔 plate</span> : <span className="wardrobe-chip is-missing">first costume render becomes the plate</span>}</div>
              <div className="wardrobe-default">{base ? base : <span className="artwork-critique-muted">No wardrobe set — add one on the character page or the costume will be invented.</span>}</div>
              <input
                className="wardrobe-override"
                type="text"
                placeholder="Override for this beat (blank = the default above)"
                value={value}
                disabled={saving === id}
                onChange={(e) => setDrafts((d) => ({ ...d, [id]: e.target.value }))}
                onBlur={() => commit(id)}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ArtworkCritiqueSection({ beatId }) {
  const [critique, setCritique] = useState(null);
  const [job, setJob] = useState(null);
  const [running, setRunning] = useState(false);
  const [genJob, setGenJob] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [overrides, setOverrides] = useState({});
  const [model, setModel] = useState(() => readStoredCatalogModel(MODEL_STORAGE_KEY));
  const [showLog, setShowLog] = useState(false);
  const [error, setError] = useState(null);
  const [climb, setClimb] = useState(null);
  const [climbOpen, setClimbOpen] = useState(false);
  const esRef = useRef(null);
  const pollRef = useRef(null);
  const logRef = useRef(null);

  const climbing = isClimbRunning(climb);
  const generating = Boolean(genJob && !TERMINAL.has(genJob.status)) || climbing;

  async function load() {
    const r = await apiGet(`/beat/${beatId}/artwork-critique`);
    const c = r.artwork_critique || null;
    setCritique(c);
    setClimb(r.climb || null);
    setSelected(new Set((c?.proposals || []).filter((p) => p.status === 'proposed' || p.status === 'error').map((p) => String(p._id))));
    setOverrides({});
    return c;
  }

  useEffect(() => {
    let cancelled = false;
    load().catch((e) => { if (!cancelled) setError(e.message); });
    return () => {
      cancelled = true;
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      setRunning(false);
    };
  }, [beatId]);

  useEffect(() => { writeStoredImageModel(MODEL_STORAGE_KEY, model); }, [model]);

  // A climb runs on the server (critique → generate → critique …) and writes
  // the critique and its own state to the beat as it goes; follow both by
  // polling until it stops. Also what reattaches a reopened tab.
  useEffect(() => {
    if (!climbing) return undefined;
    let alive = true;
    const timer = setInterval(() => { load().catch((e) => { if (alive) setError(e.message); }); }, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [beatId, climbing]);

  async function startClimb(params) {
    setError(null);
    const r = await apiPostJson(`/beat/${beatId}/artwork-critique/climb`, { ...params, model });
    setGenJob(null);
    setClimb(r.climb);
  }

  async function cancelClimb() {
    try {
      const r = await apiPostJson(`/beat/${beatId}/artwork-critique/climb/cancel`, {});
      setClimb(r.climb);
    } catch (e) { setError(e.message); }
  }

  function closeStream() { if (esRef.current) { esRef.current.close(); esRef.current = null; } }

  async function run() {
    setRunning(true); setError(null); setJob(null);
    try {
      const r = await apiPostJson(`/beat/${beatId}/artwork-critique`, {});
      const es = new EventSource(apiSseUrl(`/beat/${beatId}/artwork-critique/${r.job_id}/events`));
      esRef.current = es;
      const apply = (ev) => { const snap = safeParse(ev.data); if (snap) setJob(snap); };
      const finish = async (ev, failed) => {
        apply(ev);
        closeStream();
        try { await load(); } catch (e) { setError(e.message); }
        setRunning(false);
        if (failed) setError('The artwork critique finished with errors.');
      };
      es.addEventListener('snapshot', apply);
      es.addEventListener('update', apply);
      es.addEventListener('done', (ev) => finish(ev, false));
      es.addEventListener('error', (ev) => {
        if (ev?.data) finish(ev, true);
        else if (es.readyState === EventSource.CLOSED) { setRunning(false); setError('Connection lost.'); }
      });
    } catch (e) { setRunning(false); setError(e.message); }
  }

  function startPolling(jobId) {
    if (pollRef.current) clearInterval(pollRef.current);
    const tick = async () => {
      try {
        const r = await apiGet(`/beat/${beatId}/artwork-critique/generate/${jobId}`);
        setGenJob(r.job);
        if (TERMINAL.has(r.job?.status)) {
          clearInterval(pollRef.current); pollRef.current = null;
          await load();
        }
      } catch (e) {
        clearInterval(pollRef.current); pollRef.current = null;
        setError(e.message);
        setGenJob((j) => (j ? { ...j, status: 'error' } : j));
      }
    };
    pollRef.current = setInterval(tick, POLL_MS);
    tick();
  }

  async function generate() {
    setError(null);
    const ids = [...selected];
    if (!ids.length) return;
    const body = { proposal_ids: ids, model, overrides: {} };
    for (const id of ids) if (overrides[id]) body.overrides[id] = overrides[id];
    try {
      const r = await apiPostJson(`/beat/${beatId}/artwork-critique/generate`, body);
      setCritique((c) => (c ? { ...c, proposals: c.proposals.map((p) => (ids.includes(String(p._id)) ? { ...p, status: 'generating' } : p)) } : c));
      setGenJob({ job_id: r.job_id, status: 'queued', planned: r.planned, completed: 0, failed: 0, events: [] });
      startPolling(r.job_id);
    } catch (e) { setError(e.message); }
  }

  async function setStatus(pid, action) {
    setError(null);
    try {
      const r = await apiPostJson(`/beat/${beatId}/artwork-critique/proposals/${pid}/${action}`, {});
      setCritique((c) => (c ? { ...c, proposals: c.proposals.map((p) => (String(p._id) === pid ? { ...p, status: r.proposal.status } : p)) } : c));
      setSelected((s) => { const n = new Set(s); if (action === 'dismiss') n.delete(pid); else n.add(pid); return n; });
    } catch (e) { setError(e.message); }
  }

  // ── Fixing audited artwork ──
  function patchEntry(c, aid, entry) {
    if (!c) return c;
    return {
      ...c,
      subjects: (c.subjects || []).map((s) => ({
        ...s,
        artworks: (s.artworks || []).map((a) => (String(a.artwork_id) === aid ? { ...a, ...entry } : a)),
      })),
    };
  }
  const [fixBusy, setFixBusy] = useState(false);
  const fixingIds = useMemo(
    () => (critique?.subjects || []).flatMap((s) => (s.artworks || []).filter((a) => a.fix?.status === 'generating').map((a) => String(a.artwork_id))),
    [critique],
  );
  const fixingKey = fixingIds.join(',');

  useEffect(() => {
    if (!fixingKey) return undefined;
    let alive = true;
    const tick = async () => {
      for (const aid of fixingKey.split(',')) {
        try {
          const r = await apiGet(`/beat/${beatId}/artwork-critique/artworks/${aid}`);
          if (alive && r.artwork?.fix?.status !== 'generating') setCritique((c) => patchEntry(c, aid, r.artwork));
        } catch (e) {
          if (alive) { setError(e.message); setCritique((c) => patchEntry(c, aid, { fix: { status: 'error', error_message: e.message } })); }
        }
      }
    };
    const timer = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [beatId, fixingKey]);

  async function fixArtwork(aid, prompt) {
    setError(null); setFixBusy(true);
    try {
      const r = await apiPostJson(`/beat/${beatId}/artwork-critique/artworks/${aid}/fix`, { prompt, model });
      setCritique((c) => patchEntry(c, aid, r.artwork));
    } catch (e) { setError(e.message); } finally { setFixBusy(false); }
  }

  async function undoFix(aid) {
    setError(null); setFixBusy(true);
    try {
      const r = await apiPostJson(`/beat/${beatId}/artwork-critique/artworks/${aid}/fix/undo`, {});
      setCritique((c) => patchEntry(c, aid, r.artwork));
    } catch (e) { setError(e.message); } finally { setFixBusy(false); }
  }

  const fixProps = { model, onModel: setModel, onFix: fixArtwork, onUndo: undoFix, busy: fixBusy || running };

  const proposals = critique?.proposals || [];
  const selectable = proposals.filter((p) => p.status === 'proposed' || p.status === 'error');
  const requirementLabel = useMemo(() => {
    const map = new Map();
    for (const s of critique?.subjects || []) for (const r of s.requirements || []) map.set(r.id, r.summary);
    return (id) => map.get(id) || '';
  }, [critique]);
  const anySelectedRefless = selectable.some((p) => selected.has(String(p._id)) && ((overrides[String(p._id)]?.reference_image_ids ?? p.reference_image_ids) || []).length === 0);

  const pct = critique?.coverage?.pct;
  const meta = (
    <>
      {typeof pct === 'number'
        ? <span className={`critique-overall ${coverageBand(pct)}`}>{pct}<span className="max">% covered</span></span>
        : <span className="critique-overall none">{critique ? 'nothing to cover' : 'not critiqued'}</span>}
      {critique?.generated_at ? <span className="critique-counts">{new Date(critique.generated_at).toLocaleString()}</span> : null}
      <ClimbChip climb={climb} />
    </>
  );

  const progressLine = running && job ? (
    job.phase === 'requirements' ? 'Reading the beat for what it needs…'
      : job.phase === 'auditing' ? `Auditing artwork… ${job.subjects.filter((s) => s.status === 'done' || s.status === 'error').length}/${job.subjects.length} subjects`
        : 'Starting…'
  ) : null;

  return (
    <CritiqueSection title="Artwork" meta={meta} defaultOpen={false}>
      <div className="tab-actions critique-head">
        {progressLine ? <span className="artwork-critique-progress">{progressLine}</span> : null}
        <span className="spacer" />
        <button type="button" className="primary" disabled={running || generating} onClick={run}>
          {running ? 'Critiquing…' : critique ? 'Re-run artwork critique' : 'Run artwork critique'}
        </button>
        <button
          type="button"
          disabled={running || generating}
          title="Critique, generate every proposed artwork and critique again, until coverage reaches a target"
          onClick={() => setClimbOpen(true)}
        >
          {climbing ? 'Climbing…' : 'Climb'}
        </button>
      </div>
      {error && <div className="critique-error">{error}</div>}
      <ClimbPanel climb={climb} onCancel={cancelClimb} />
      <ClimbDialog
        open={climbOpen}
        kind="artwork"
        last={climb}
        intro="Runs the artwork critique, generates every proposal it drafts onto the owning set or character, and critiques again, over and over, until coverage reaches the target. Every round renders images with the model below, and the renders stay on file even when a round does not raise coverage. Dismissed proposals are skipped."
        onStart={startClimb}
        onClose={() => setClimbOpen(false)}
      >
        <div className="climb-field is-wide">
          <span className="field-label">Image model</span>
          <ImageModelSelect value={model} onChange={setModel} collapsible />
        </div>
      </ClimbDialog>

      {!critique && !running && (
        <div className="artwork-critique-muted">
          Run the artwork critique to check the sets' and characters' artwork against this beat — which views, costumes,
          expressions and poses the writing calls for, what is on file, and what should be generated.
        </div>
      )}

      <WardrobeStrip beatId={beatId} refreshKey={genJob?.finished_at || critique?.generated_at || null} />

      {(critique?.warnings || []).length > 0 && (
        <ul className="artwork-critique-warnings">{critique.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
      )}
      {(critique?.unlinked_mentions || []).length > 0 && (
        <ul className="artwork-critique-warnings">
          {critique.unlinked_mentions.map((m, i) => (
            <li key={i}>Named in the beat but not linked: {m.kind} “{m.name}”{m.quote ? ` — “${m.quote}”` : ''}. Link it on the {m.kind === 'set' ? 'Sets' : 'Characters'} tab and re-run.</li>
          ))}
        </ul>
      )}

      {(critique?.subjects || []).map((s) => <SubjectCard key={`${s.kind}:${s.id}`} subject={s} fixProps={fixProps} />)}

      {proposals.length > 0 && (
        <div className="artwork-critique-proposals">
          <div className="artwork-critique-proposals-head">
            <b>Proposed artwork</b>
            <span className="artwork-critique-muted">{selectable.length} to generate · {proposals.filter((p) => p.status === 'done').length} done</span>
            <span className="spacer" />
            {selectable.length > 0 && (
              <>
                <button type="button" className="small" disabled={generating} onClick={() => setSelected(new Set(selectable.map((p) => String(p._id))))}>Select all</button>
                <button type="button" className="small" disabled={generating} onClick={() => setSelected(new Set())}>None</button>
              </>
            )}
          </div>
          {selectable.length > 0 && (
            <div className="artwork-critique-proposals-tools">
              <ImageModelSelect value={model} onChange={setModel} disabled={generating} collapsible promptOnly={anySelectedRefless} />
              <button type="button" className="primary" disabled={generating || running || selected.size === 0} onClick={generate}>
                {generating ? 'Generating…' : `Generate selected (${selected.size})`}
              </button>
            </div>
          )}
          {genJob && (
            <GenerationProgress job={genJob} showLog={showLog} onToggleLog={() => setShowLog((v) => !v)} logRef={logRef} noun="artwork" />
          )}
          {proposals.map((p) => {
            const pid = String(p._id);
            return (
              <ProposalRow
                key={pid}
                p={p}
                checked={selected.has(pid)}
                onToggle={() => setSelected((s) => { const n = new Set(s); if (n.has(pid)) n.delete(pid); else n.add(pid); return n; })}
                override={overrides[pid]}
                onOverride={(patch) => setOverrides((o) => ({ ...o, [pid]: { ...(o[pid] || {}), ...patch } }))}
                requirementLabel={requirementLabel}
                generating={generating}
                onDismiss={() => setStatus(pid, 'dismiss')}
                onRestore={() => setStatus(pid, 'restore')}
              />
            );
          })}
        </div>
      )}
    </CritiqueSection>
  );
}
