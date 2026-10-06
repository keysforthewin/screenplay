// The Artwork half of the Critique tab: does the art library hold the
// pictures this beat's writing needs? Runs the server's artwork critique
// (requirements → vision audit → proposals; SSE progress), shows each
// subject's coverage checklist and the issues in its existing artwork, and
// lets the user tick the drafted proposals and render them onto the owning
// set / character. Artwork broadcasts go to the set/character rooms, not the
// beat room, so the generation job is polled.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import CoverageCarousel from './CoverageCarousel.jsx';
import IrrelevantArtwork from './IrrelevantArtwork.jsx';
import { apiGet, apiPatchJson, apiPostJson, apiDelete, apiSseUrl, thumbUrl } from '../api.js';
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

// The review rubric's criteria, in the order the server scores them.
const RUBRIC_LABEL = {
  requirement: 'Does the job',
  beat: 'Agrees with the beat',
  subject: 'True to the subject',
  reference: 'Usable as a reference',
  technical: 'Technically clean',
};
const ACTION_LABEL = { keep: 'keep', edit: 'edit it', regenerate: 'make it again' };

// The reviewer's verdict on one artwork: rubric rows + keep / edit / regenerate.
function ReviewVerdict({ artwork }) {
  if (!artwork.audited_image_id) {
    return <div className="artwork-critique-muted">Matched to this beat by its description — not looked at by the reviewer yet.</div>;
  }
  const rows = artwork.criteria || [];
  return (
    <div className="artwork-critique-review">
      {artwork.action ? (
        <div className="artwork-critique-review-action">
          <span className={`review-action is-${artwork.action}`}>Reviewer: {ACTION_LABEL[artwork.action] || artwork.action}</span>
          {artwork.action === 'regenerate' && artwork.regenerate_reason ? <span className="artwork-critique-muted"> {artwork.regenerate_reason}</span> : null}
        </div>
      ) : null}
      {rows.length ? (
        <ul className="artwork-critique-rubric">
          {rows.map((c) => (
            <li key={c.key}>
              <span className={`lens-score ${scoreBand(c.score)}`}>{c.score}</span>
              <span className="rubric-label">{RUBRIC_LABEL[c.key] || c.key}</span>
              {c.note ? <span className="artwork-critique-muted">{c.note}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// What a climb did (or is doing) to one artwork, as a thumbnail badge.
const CLIMB_WORKING = new Set(['queued', 'editing', 'checking']);
function climbBadge(act, live) {
  if (!act) return null;
  if (CLIMB_WORKING.has(act.status)) {
    if (!live) return null;
    return { tone: 'is-working', text: act.status === 'queued' ? 'edit queued' : act.status === 'editing' ? 'editing…' : 'checking…' };
  }
  if (act.status === 'kept') return { tone: 'is-kept', text: act.from != null && act.to != null ? `${act.from} → ${act.to}` : 'edit kept' };
  if (act.status === 'undone') return { tone: 'is-undone', text: 'edit undone' };
  if (act.status === 'failed') return { tone: 'is-failed', text: 'edit failed' };
  return null;
}

function climbLine(act, live) {
  if (!act) return null;
  if (act.status === 'queued') return live ? 'Climb: waiting its turn to be edited in place.' : null;
  if (act.status === 'editing') return live ? 'Climb: editing this picture in place now…' : null;
  if (act.status === 'checking') return live ? 'Climb: edited — the new picture is being checked against the beat…' : null;
  if (act.status === 'kept') return `Climb round ${act.round}: edit kept${act.from != null && act.to != null ? ` — score ${act.from} → ${act.to}` : ''}.`;
  if (act.status === 'undone') return `Climb round ${act.round}: edit undone${act.to != null ? ` — the edited picture scored ${act.to} against ${act.from}` : ''}; the picture is back as it was.`;
  if (act.status === 'failed') return `Climb round ${act.round}: the edit failed${act.error ? ` — ${act.error}` : ''}.`;
  return null;
}

function ArtworkStrip({ artworks, model, onModel, onFix, onUndo, busy, activity, climbing }) {
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
          const act = activity?.[id];
          const badge = climbBadge(act, climbing);
          // While an edit waits for its re-check, show the edited picture.
          const imageId = climbing && act?.status === 'checking' && act.image_id ? act.image_id : a.result_image_id;
          return (
            <button
              type="button"
              key={id}
              className={`artwork-critique-thumb${openId === id ? ' is-open' : ''}${n ? ' has-issues' : ''}${fixState === 'done' ? ' is-fixed' : ''}${badge ? ` climb-${badge.tone}` : ''}${a.audited_image_id ? '' : ' is-unreviewed'}`}
              title={a.name || 'artwork'}
              onClick={() => setOpenId(openId === id ? null : id)}
            >
              <img src={thumbUrl(imageId)} alt={a.name || ''} />
              {n ? <span className="issue-badge">{n}</span> : null}
              {typeof a.score === 'number'
                ? <span className={`score-badge ${scoreBand(a.score)}`} title="The reviewer's rubric score for what this beat needs from it">{formatScore(a.score)}</span>
                : <span className="score-badge is-unreviewed" title="Matched by its description; not reviewed yet">?</span>}
              {!badge && a.action === 'regenerate' ? <span className="fix-badge climb-badge is-failed">remake</span> : null}
              {badge ? <span className={`fix-badge climb-badge ${badge.tone}`}>{badge.text}</span>
                : fixState === 'generating' ? <span className="fix-badge">fixing…</span> : fixState === 'done' ? <span className="fix-badge">fixed</span> : null}
            </button>
          );
        })}
      </div>
      {open && (
        <div className="artwork-critique-issues">
          <div className="artwork-critique-issues-title">
            {open.name || 'Artwork'}
            {typeof open.score === 'number' ? <span className="artwork-critique-muted"> · {formatScore(open.score)}/10</span> : null}
            {open.edit_attempts ? <span className="artwork-critique-muted"> · {open.edit_attempts} climb edit{open.edit_attempts === 1 ? '' : 's'} undone</span> : null}
          </div>
          {climbLine(activity?.[String(open.artwork_id)], climbing) ? (
            <div className="artwork-critique-climb-line">
              {climbLine(activity?.[String(open.artwork_id)], climbing)}
              {(activity[String(open.artwork_id)].why || []).length ? (
                <div className="artwork-critique-muted">What needed to change: {activity[String(open.artwork_id)].why.join('; ')}</div>
              ) : null}
              {activity[String(open.artwork_id)].prompt ? <div className="artwork-critique-muted">Edit sent to the image model: {activity[String(open.artwork_id)].prompt}</div> : null}
            </div>
          ) : null}
          <ReviewVerdict artwork={open} />
          {(open.issues || []).length ? (
            <ul>
              {open.issues.map((i, n) => <li key={n}><span className="issue-chip sev-should_fix">{i.kind.replace(/_/g, ' ')}</span> {i.note}</li>)}
            </ul>
          ) : open.audited_image_id ? <div className="artwork-critique-muted">Nothing in it disagrees with the writing.</div> : null}
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

// Pieces of a large library whose descriptions say they are the same picture.
// Shown only — nothing is deleted; open the set / character to remove one.
function DuplicateGroups({ subject }) {
  const groups = subject.inventory?.duplicates || [];
  if (!groups.length) return null;
  return (
    <div className="artwork-critique-duplicates">
      <span className="artwork-critique-muted">
        {groups.length} possible duplicate group{groups.length === 1 ? '' : 's'} by description —{' '}
        <Link to={hostPath(subject.kind, subject.id)}>review on the {subject.kind}</Link>
      </span>
    </div>
  );
}

function SubjectCard({ subject, fixProps, activity, climbing, audit }) {
  const artworksById = useMemo(() => new Map((subject.artworks || []).map((a) => [String(a.artwork_id), a])), [subject.artworks]);
  const reqs = subject.requirements || [];
  const covered = reqs.filter((r) => r.status === 'covered').length;
  // A run in progress keeps showing the last audit; only a subject that has
  // never been audited has nothing to show yet.
  const audited = reqs.length > 0 || (subject.artworks || []).length > 0;
  const working = Object.entries(activity || {}).filter(([id, a]) => climbing && CLIMB_WORKING.has(a.status) && artworksById.has(id)).length;
  return (
    <div className="artwork-critique-subject">
      <div className="artwork-critique-subject-head">
        <span className={`critique-scope ${subject.kind === 'set' ? 'scope-story' : ''}`}>{subject.kind === 'set' ? 'Set' : 'Character'}</span>
        <Link to={hostPath(subject.kind, subject.id)} className="artwork-critique-subject-name">{subject.name}</Link>
        {subject.status === 'pending' && !audited && <span className="artwork-critique-muted">waiting…</span>}
        {subject.status === 'error' && <span className="critique-error">errored: {subject.error_message}</span>}
        {working > 0 && <span className="climb-chip is-running">{working} being edited</span>}
        {working === 0 && audit ? (
          <span className="climb-chip is-running">
            {audit.status === 'matching' ? 'matching its artwork descriptions…'
              : audit.status === 'auditing' ? `reviewing its artwork… ${audit.audited ? `${audit.audited} looked at` : ''}`
              : audit.status === 'proposing' ? 'drafting what to render…'
                : audit.status === 'done' ? 'checked ✓'
                  : audit.status === 'error' ? 'check failed' : 'waiting to be checked'}
          </span>
        ) : null}
        {working === 0 && !audit && subject.status === 'pending' && audited && <span className="climb-chip is-running">re-checking…</span>}
        {(subject.status === 'done' || (subject.status === 'pending' && audited)) && (
          <>
            <span className="artwork-critique-muted">{reqs.filter((r) => r.status !== 'missing').length}/{reqs.length} have a picture{covered < reqs.length ? ` (${covered} exact)` : ''}</span>
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
      <ArtworkStrip artworks={subject.artworks} {...fixProps} activity={activity} climbing={climbing} />
      <DuplicateGroups subject={subject} />
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
        {p.review_brief ? <div className="proposal-review-brief"><b>Reviewer's findings this image has to put right:</b> {p.review_brief}</div> : null}
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
        {refs.length === 0 && selectable ? <div className="artwork-critique-muted">No reference images — the look comes from the prompt alone (upload a photo of the place to the set's Images, or add artwork).</div> : null}
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

// A critique job that is no longer running.
const JOB_ENDED = new Set(['done', 'partial', 'error', 'cancelled']);

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
  const [clearing, setClearing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const esRef = useRef(null);
  const pollRef = useRef(null);
  const logRef = useRef(null);

  const climbing = isClimbRunning(climb);
  const generating = Boolean(genJob && !TERMINAL.has(genJob.status)) || climbing;

  // `quiet` (the climb's 2 s poll): refresh what is shown without touching
  // the proposal ticks and prompt overrides.
  async function load({ quiet = false } = {}) {
    const r = await apiGet(`/beat/${beatId}/artwork-critique`);
    const c = r.artwork_critique || null;
    setCritique(c);
    setClimb(r.climb || null);
    // A critique run this page is not following yet (the page was left and
    // reopened, or another tab started it): pick it up where it is.
    if (r.job && !JOB_ENDED.has(r.job.status) && !esRef.current) {
      setJob(r.job);
      setRunning(true);
      follow(r.job.job_id);
    }
    if (!quiet) {
      setSelected(new Set((c?.proposals || []).filter((p) => p.status === 'proposed' || p.status === 'error').map((p) => String(p._id))));
      setOverrides({});
    }
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
    const timer = setInterval(() => { load({ quiet: true }).catch((e) => { if (alive) setError(e.message); }); }, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [beatId, climbing]);

  // When the climb stops, tick the proposals it left open.
  const wasClimbing = useRef(false);
  useEffect(() => {
    if (wasClimbing.current && !climbing) {
      setSelected(new Set((critique?.proposals || []).filter((p) => p.status === 'proposed' || p.status === 'error').map((p) => String(p._id))));
      setOverrides({});
    }
    wasClimbing.current = climbing;
  }, [climbing]);

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

  // The critique in two steps. 'coverage': start from nothing — what the
  // beat needs, matched against the artwork on file by description, plus a
  // draft for everything missing; the page empties and fills as it lands.
  // 'quality': the matched pieces are looked at and scored, updated in place.
  // Either one ends the last climb: its status is cleared.
  // Follow a critique run over its SSE stream — one this page just started,
  // or one found running when the page (re)opened. The first event is a
  // snapshot of the job as it stands, so progress resumes where it is.
  function follow(jobId) {
    closeStream();
    const es = new EventSource(apiSseUrl(`/beat/${beatId}/artwork-critique/${jobId}/events`));
    esRef.current = es;
    // The run writes each subject as it goes (after its match, after every
    // review batch): refresh the page on every progress event.
    const apply = (ev) => {
      const snap = safeParse(ev.data);
      if (!snap) return null;
      setJob(snap);
      load({ quiet: true }).catch(() => {});
      return snap;
    };
    const finish = async (ev, failed) => {
      apply(ev);
      closeStream();
      setCancelling(false);
      try { await load(); } catch (e) { setError(e.message); }
      setRunning(false);
      if (failed) setError('The artwork critique finished with errors.');
    };
    es.addEventListener('snapshot', (ev) => { const snap = apply(ev); if (snap && JOB_ENDED.has(snap.status)) finish(ev, snap.status === 'error'); });
    es.addEventListener('update', apply);
    es.addEventListener('done', (ev) => finish(ev, false));
    es.addEventListener('error', (ev) => {
      if (ev?.data) finish(ev, true);
      else if (es.readyState === EventSource.CLOSED) { closeStream(); setRunning(false); setCancelling(false); setError('Connection lost.'); }
    });
  }

  async function run(stage) {
    setRunning(true); setError(null); setJob(null); setCancelling(false);
    try {
      const r = await apiPostJson(`/beat/${beatId}/artwork-critique`, { stage });
      setClimb(null);
      setGenJob(null);
      follow(r.job_id);
    } catch (e) { setRunning(false); setError(e.message); }
  }

  // Stop the run now. What it had already stored stays on the page.
  async function cancelRun() {
    setCancelling(true); setError(null);
    try { await apiPostJson(`/beat/${beatId}/artwork-critique/cancel`, {}); }
    catch (e) { setCancelling(false); setError(e.message); }
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

  async function clearCritique() {
    if (!confirm('Clear the artwork critique? Its requirements, reviews, proposals and the climb status are removed. No artwork is deleted.')) return;
    setError(null); setClearing(true);
    try {
      await apiDelete(`/beat/${beatId}/artwork-critique`);
      setCritique(null); setClimb(null); setJob(null); setGenJob(null);
      setSelected(new Set()); setOverrides({});
    } catch (e) { setError(e.message); } finally { setClearing(false); }
  }

  const fixProps = { model, onModel: setModel, onFix: fixArtwork, onUndo: undoFix, busy: fixBusy || running || climbing };

  const proposals = critique?.proposals || [];
  const selectable = proposals.filter((p) => p.status === 'proposed' || p.status === 'error');
  const requirementLabel = useMemo(() => {
    const map = new Map();
    for (const s of critique?.subjects || []) for (const r of s.requirements || []) map.set(r.id, r.summary);
    return (id) => map.get(id) || '';
  }, [critique]);
  const anySelectedRefless = selectable.some((p) => selected.has(String(p._id)) && ((overrides[String(p._id)]?.reference_image_ids ?? p.reference_image_ids) || []).length === 0);

  const busy = running || generating || clearing;
  const hasCoverage = (critique?.subjects || []).some((s) => (s.requirements || []).length > 0);
  // Open proposals: for a requirement nothing answers (Create missing) or
  // for a piece the reviewer wants made again.
  const missingOpen = selectable.filter((p) => !p.replaces_artwork_id);
  const selectedRemakes = selectable.filter((p) => p.replaces_artwork_id && selected.has(String(p._id))).length;

  const pct = critique?.coverage?.pct;
  const quality = critique?.coverage?.quality_pct;
  const meta = (
    <>
      {typeof pct === 'number'
        ? <span className={`critique-overall ${coverageBand(pct)}`}>{pct}<span className="max">% covered</span></span>
        : <span className="critique-overall none">{critique ? 'nothing to cover' : 'not critiqued'}</span>}
      {typeof quality === 'number'
        ? (
          <span className="critique-counts" title="Each requirement weighted by the reviewer's rubric score of the best piece answering it — what Climb raises. A requirement whose picture has not been reviewed counts 0.">
            {critique?.coverage?.reviewed ? `${quality}% quality` : 'quality: not reviewed yet'}
            {critique?.coverage?.reviewed != null && critique.coverage.total ? ` · ${critique.coverage.reviewed}/${critique.coverage.total} reviewed` : ''}
          </span>
        )
        : null}
      {critique?.generated_at ? <span className="critique-counts">{new Date(critique.generated_at).toLocaleString()}</span> : null}
      <ClimbChip climb={climb} />
    </>
  );

  const progressLine = running && job ? (
    job.phase === 'requirements' ? 'Reading the beat for what it needs…'
      : job.phase === 'matching' ? `Coverage — matching the requirements against the artwork descriptions… ${job.images_done ?? 0}/${job.images_total ?? 0} images`
        : job.phase === 'proposing' ? 'Coverage — drafting the missing artwork…'
        : job.phase === 'auditing' ? `Quality — reviewing the matched artwork… ${job.subjects.filter((s) => s.status === 'done' || s.status === 'error').length}/${job.subjects.length} subjects · ${job.subjects.reduce((n, s) => n + (s.audited || 0), 0)} looked at, ${job.subjects.reduce((n, s) => n + (s.reused || 0), 0)} unchanged`
        : 'Starting…'
  ) : null;

  return (
    <CritiqueSection title="Coverage" meta={meta}>
      <div className="tab-actions critique-head">
        {progressLine ? <span className="artwork-critique-progress">{progressLine}</span> : null}
        <span className="spacer" />
        <button
          type="button"
          className={hasCoverage ? undefined : 'primary'}
          disabled={busy}
          title="Step 1 — list the artwork this beat needs and compare it with every artwork on file (by description; no image is looked at). The list is kept while the beat's text and roster are unchanged, so a re-check after creating artwork is measured against the same list — Clear critique first to start from nothing. What is missing is drafted for Create missing."
          onClick={() => run('coverage')}
        >
          {running && job?.stage !== 'quality' ? 'Checking coverage…' : 'Check coverage'}
        </button>
        <button
          type="button"
          className={hasCoverage && !missingOpen.length ? 'primary' : undefined}
          disabled={busy || !hasCoverage}
          title={hasCoverage
            ? 'Step 2 — look at the matched artwork and score each piece: keep, edit or make again. Open a thumbnail to fix it; pieces to remake are drafted below.'
            : 'Check coverage first'}
          onClick={() => run('quality')}
        >
          {running && job?.stage === 'quality' ? 'Checking quality…' : 'Check quality'}
        </button>
        {running && !climbing ? (
          <button type="button" disabled={cancelling} title="Stop this check now. What it has already stored stays; a model call already under way is left to finish in the background and its answer is discarded." onClick={cancelRun}>
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          title="Phase 1: render a picture for every requirement nothing on file answers. Phase 2: the reviewer scores each matched piece; edit or remake until the quality score reaches a target"
          onClick={() => setClimbOpen(true)}
        >
          {climbing ? 'Climbing…' : 'Climb'}
        </button>
        {(critique || climb) ? (
          <button type="button" disabled={busy} title="Remove the critique and the climb status, to start fresh. No artwork is deleted." onClick={clearCritique}>
            {clearing ? 'Clearing…' : 'Clear critique'}
          </button>
        ) : null}
      </div>
      {job?.stage === 'coverage' ? <CoverageCarousel job={job} running={running} /> : null}
      {error && <div className="critique-error">{error}</div>}
      <ClimbPanel climb={climb} onCancel={cancelClimb} />
      <ClimbDialog
        open={climbOpen}
        kind="artwork"
        last={climb}
        intro="Two phases. 1 — Coverage: the requirements are matched against the artwork descriptions (no image is looked at); a new picture is rendered for each requirement nothing on file answers. 2 — Quality: once every requirement has a picture, the reviewer (Admin → Models → Artwork reviewer) scores each matched piece on the rubric and says keep, edit or make again. Edits are applied in place with the model below and undone if the score does not rise; a piece that cannot be edited into shape is rendered again from a prompt and references. The target is the quality score. Dismissed proposals are skipped."
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
          <b>Check coverage</b> lists the views, costumes, expressions and poses this beat's writing calls for and compares
          them with the sets' and characters' artwork on file; <b>Create missing</b> then renders what is not there.
          <b> Check quality</b> looks at each matched piece, scores it, and lets you fix it or make it again.
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

      {(critique?.subjects || []).map((s) => <SubjectCard key={`${s.kind}:${s.id}`} subject={s} fixProps={fixProps} activity={climb?.activity} climbing={climbing} audit={climbing ? (climb?.audit?.subjects || []).find((a) => a.id === String(s.id)) : running ? (job?.subjects || []).find((a) => a.id === String(s.id)) : null} />)}

      {proposals.length > 0 && (
        <div className="artwork-critique-proposals">
          <div className="artwork-critique-proposals-head">
            <b>Artwork to create</b>
            <span className="artwork-critique-muted">
              {missingOpen.length} missing{selectable.length > missingOpen.length ? ` · ${selectable.length - missingOpen.length} to make again` : ''} · {proposals.filter((p) => p.status === 'done').length} done
            </span>
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
                {generating ? 'Generating…' : selectedRemakes ? `Create selected (${selected.size})` : `Create missing (${selected.size})`}
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
      {critique && !running ? (
        <IrrelevantArtwork beatId={beatId} version={String(critique.generated_at || '')} disabled={busy} onChanged={() => load({ quiet: true }).catch(() => {})} />
      ) : null}
    </CritiqueSection>
  );
}
