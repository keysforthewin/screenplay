import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPostJson } from '../api.js';

// Advisory "visual readiness" panel for the storyboard page: surfaces the
// beat's readiness_report (built automatically at the start of every Generate
// run, or on demand via the Re-check button). Never blocks anything — it is a
// checklist for the author, not a gate.
//
// Dismissal is client-side only: localStorage keeps the dismissed report's
// created_at per beat, so a *fresh* report (new created_at) un-dismisses
// itself while the same report stays hidden across reloads.

const dismissKey = (beatId) => `readiness.dismissed.${beatId}`;

function severityLabel(report) {
  const w = report?.counts?.warnings ?? 0;
  if (w === 0) return 'no warnings';
  return `${w} warning${w === 1 ? '' : 's'}`;
}

function entityLink(check) {
  if (!check.subject) return null;
  if (check.code.startsWith('character')) {
    return `/character/${encodeURIComponent(check.subject)}`;
  }
  if (check.code.startsWith('set') || check.code === 'missing_set') {
    return `/set/${encodeURIComponent(check.subject)}`;
  }
  return null;
}

export function ReadinessPanel({ beatId, report: reportProp, onRefresh }) {
  const [report, setReport] = useState(reportProp || null);
  const [expanded, setExpanded] = useState(false);
  const [dismissedAt, setDismissedAt] = useState(() => {
    try {
      return localStorage.getItem(dismissKey(beatId));
    } catch {
      return null;
    }
  });
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  // A newer report from props (page load or live generation polling) replaces
  // whatever we hold.
  useEffect(() => {
    if (reportProp) setReport(reportProp);
  }, [reportProp]);

  useEffect(() => () => clearInterval(pollRef.current), []);

  const recheck = async () => {
    setChecking(true);
    setError(null);
    try {
      const { job_id } = await apiPostJson('/storyboards/readiness', { beat_id: beatId });
      clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const { job } = await apiGet(`/storyboards/readiness/${job_id}`);
          if (job.status === 'done' || job.status === 'error') {
            clearInterval(pollRef.current);
            setChecking(false);
            if (job.status === 'done' && job.report) {
              setReport(job.report);
              setExpanded(true);
              onRefresh?.();
            } else if (job.error) {
              setError(job.error);
            }
          }
        } catch (e) {
          clearInterval(pollRef.current);
          setChecking(false);
          setError(e.message);
        }
      }, 750);
    } catch (e) {
      setChecking(false);
      setError(e.message);
    }
  };

  if (!report) {
    return (
      <div className="readiness-panel readiness-panel--empty">
        <span style={{ color: 'var(--fg-muted)' }}>
          Visual readiness: not checked yet.
        </span>{' '}
        <button type="button" onClick={recheck} disabled={checking}>
          {checking ? 'Checking…' : 'Check readiness'}
        </button>
        {error && <div className="error-banner">{error}</div>}
      </div>
    );
  }

  const createdAt = report.created_at ? String(new Date(report.created_at).getTime()) : '';
  if (dismissedAt && dismissedAt === createdAt) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(dismissKey(beatId), createdAt);
    } catch {
      // localStorage unavailable — dismiss for this render only
    }
    setDismissedAt(createdAt);
  };

  const warns = (report.checks || []).filter((c) => c.severity === 'warn');
  const infos = (report.checks || []).filter((c) => c.severity === 'info');
  const gaps = report.gaps || [];

  return (
    <div className="readiness-panel">
      <div className="readiness-panel__header">
        <button
          type="button"
          className="readiness-panel__toggle"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
        >
          {expanded ? '▾' : '▸'} Visual readiness: {severityLabel(report)}
        </button>
        <span style={{ color: 'var(--fg-muted)', fontSize: '0.85em' }}>
          Advisory only — generation runs regardless.
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={recheck} disabled={checking}>
          {checking ? 'Checking…' : 'Re-check'}
        </button>
        <button type="button" onClick={dismiss} title="Hide until the next check">
          ×
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {expanded && (
        <div className="readiness-panel__body">
          {report.summary && <p>{report.summary}</p>}
          {report.llm_error && (
            <p style={{ color: 'var(--fg-muted)' }}>
              (Script-element scan unavailable: {report.llm_error})
            </p>
          )}
          {[...warns, ...infos].length > 0 && (
            <ul className="readiness-panel__list">
              {[...warns, ...infos].map((c, i) => {
                const link = entityLink(c);
                return (
                  <li key={`${c.code}:${c.subject ?? i}`} data-severity={c.severity}>
                    <span className="readiness-panel__badge">
                      {c.severity === 'warn' ? '⚠️' : 'ℹ️'}
                    </span>{' '}
                    {link ? <Link to={link}>{c.subject}</Link> : null}
                    {link ? ' — ' : null}
                    {c.message}
                  </li>
                );
              })}
            </ul>
          )}
          {gaps.length > 0 && (
            <>
              <h4>Script elements without visual backing</h4>
              <ul className="readiness-panel__list">
                {gaps.map((g, i) => (
                  <li key={`${g.element}:${i}`} data-severity="warn">
                    <span className="readiness-panel__badge">⚠️</span>{' '}
                    <strong>{g.element}</strong> ({g.element_kind}) — {g.note}
                    {g.matched_entity ? ` (matches: ${g.matched_entity})` : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
          {warns.length === 0 && infos.length === 0 && gaps.length === 0 && (
            <p>Everything the beat calls for has visual backing. 🎬</p>
          )}
        </div>
      )}
    </div>
  );
}
