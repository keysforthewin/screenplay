// The dialog behind "Regenerate beat from critique": the critique's rubric —
// every facet, its criteria and their scores, the issues filed under each —
// as a tree of checkboxes. Everything starts ticked; unticking a facet sets
// the whole of it aside, unticking a criterion sets aside that criterion and
// its issues. Only what stays ticked reaches the rewrite.
import { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal.jsx';
import { scoreBand, formatScore, sortIssues, hasCriteria, SEVERITY_LABELS } from './critiqueDisplay.js';

const WHOLE = '*'; // the one selectable entry of a facet stored without criteria

const idOf = (facetKey, criterionKey) => `${facetKey}/${criterionKey}`;

// The selectable ids of a facet: its applicable criteria, or the facet itself.
function facetIds(f) {
  if (!hasCriteria(f)) return [idOf(f.key, WHOLE)];
  return f.criteria.filter((c) => c.applicable !== false).map((c) => idOf(f.key, c.key));
}

// {facetKey: true | [criterionKey, …]} — the request's `apply`. A facet with
// nothing ticked is left out; criteria that were n/a ride along with a facet
// that is in.
export function buildApply(facets, checked) {
  const apply = {};
  for (const f of facets) {
    const ids = facetIds(f).filter((id) => checked.has(id));
    if (!ids.length) continue;
    if (!hasCriteria(f)) { apply[f.key] = true; continue; }
    apply[f.key] = f.criteria.filter((c) => c.applicable === false || checked.has(idOf(f.key, c.key))).map((c) => c.key);
  }
  return apply;
}

function Score({ score }) {
  return (
    <>
      <span className={`lens-score ${scoreBand(score)}`}>{formatScore(score)}</span>
      <span className="lens-bar"><i className={scoreBand(score)} style={{ width: `${((score || 0) / 10) * 100}%` }} /></span>
    </>
  );
}

function IssueList({ issues }) {
  if (!issues.length) return null;
  return (
    <ul className="lens-issues">
      {issues.map((i, n) => (
        <li key={n} className={`sev-${i.severity}`}>
          <span className={`issue-chip sev-${i.severity}`}>{SEVERITY_LABELS[i.severity] || i.severity}</span>
          {i.quote ? <span className="issue-quote">“{i.quote}”</span> : null}
          <span className="issue-problem">{i.problem}</span>
          {i.fix ? <span className="issue-fix"><b>Fix:</b> {i.fix}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function TriCheckbox({ state, onChange, label }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={state === 'all'}
      ref={(el) => { if (el) el.indeterminate = state === 'some'; }}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

export function RegenerateDialog({ open, facets, onStart, onClose }) {
  const done = useMemo(() => (facets || []).filter((f) => f.status === 'done'), [facets]);
  const allIds = useMemo(() => done.flatMap(facetIds), [done]);
  const [checked, setChecked] = useState(() => new Set());
  const [direction, setDirection] = useState('');

  useEffect(() => {
    if (open) setChecked(new Set(allIds));
  }, [open]);

  function setMany(ids, on) {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const id of ids) { if (on) next.add(id); else next.delete(id); }
      return next;
    });
  }

  const stateOf = (ids) => {
    const n = ids.filter((id) => checked.has(id)).length;
    return n === 0 ? 'none' : n === ids.length ? 'all' : 'some';
  };

  const selected = allIds.filter((id) => checked.has(id)).length;

  function start() {
    const everything = selected === allIds.length;
    onStart({ ...(everything ? {} : { apply: buildApply(done, checked) }), direction: direction.trim() });
    onClose();
  }

  return (
    <Modal
      open={open}
      size="xl"
      title="Regenerate beat from critique"
      onClose={onClose}
      footer={(
        <>
          <span className="regen-count">{selected} of {allIds.length} selected</span>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" disabled={!selected} onClick={start}>Regenerate</button>
        </>
      )}
    >
      <p className="modal-help">
        Tick the parts of the critique the rewrite should act on. Unticking a category sets all of it aside; unticking a
        criterion sets aside that criterion and the issues filed under it. What is set aside is left as written.
      </p>
      <div className="regen-all">
        <label>
          <TriCheckbox state={stateOf(allIds)} onChange={(on) => setMany(allIds, on)} label="Everything" /> Everything
        </label>
      </div>
      <div className="regen-tree">
        {done.map((f) => {
          const ids = facetIds(f);
          const state = stateOf(ids);
          const issues = sortIssues(f.issues);
          const criteria = hasCriteria(f) ? f.criteria : [];
          const known = new Set(criteria.map((c) => c.key));
          const loose = issues.filter((i) => !known.has(i.criterion));
          return (
            <details className={`critique-lens-detail${state === 'none' ? ' is-off' : ''}`} key={f.key} open>
              <summary className="critique-lens">
                <TriCheckbox state={state} onChange={(on) => setMany(ids, on)} label={f.label} />
                <span className="lens-name">{f.label}</span>
                <Score score={f.score} />
                <span className="lens-comment">{f.summary || f.comments}</span>
              </summary>
              <div className="lens-detail">
                {criteria.map((c) => {
                  const id = idOf(f.key, c.key);
                  const na = c.applicable === false;
                  const on = checked.has(id);
                  return (
                    <div className={`lens-criterion${!na && !on ? ' is-off' : ''}`} key={c.key}>
                      {na ? <span /> : (
                        <input type="checkbox" aria-label={c.label || c.key} checked={on} onChange={(e) => setMany([id], e.target.checked)} />
                      )}
                      <span className="lens-criterion-name">{c.label || c.key}</span>
                      {na ? <span className="lens-criterion-na">n/a</span> : <Score score={c.score} />}
                      <span className="lens-criterion-body">
                        {c.rationale ? <span className="lens-rationale">{c.rationale}</span> : null}
                        {c.to_raise ? <span className="lens-raise"><b>To fix:</b> {c.to_raise}</span> : null}
                        <IssueList issues={issues.filter((i) => i.criterion === c.key)} />
                      </span>
                    </div>
                  );
                })}
                <IssueList issues={loose} />
              </div>
            </details>
          );
        })}
      </div>
      <label className="climb-field regen-direction">
        <span className="field-label">Direction (optional)</span>
        <textarea
          rows={3}
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
          placeholder="e.g. Keep the argument under the surface — nobody says what they mean. Do not add dialogue."
        />
      </label>
    </Modal>
  );
}
