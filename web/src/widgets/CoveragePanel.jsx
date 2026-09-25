// Dialogue-coverage audit from the last "Plan shots" run (job.coverage from
// GET /api/storyboards/generate/:jobId). Purely advisory: warnings name the
// line or shot; the user fixes them with the per-shot dialog chips.
export function CoveragePanel({ coverage, onDismiss }) {
  const checks = Array.isArray(coverage?.checks) ? coverage.checks : [];
  if (!coverage) return null;
  const warnings = checks.filter((c) => c.severity === 'warn');
  const infos = checks.filter((c) => c.severity !== 'warn');
  return (
    <div className={`coverage-panel ${warnings.length ? 'has-warnings' : 'is-clean'}`}>
      <div className="coverage-panel-head">
        <strong>Dialogue coverage</strong>
        <span className="coverage-panel-summary">
          {warnings.length === 0
            ? 'every line is covered by exactly one shot'
            : `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`}
          {infos.length > 0 ? ` · ${infos.length} note${infos.length === 1 ? '' : 's'}` : ''}
        </span>
        {onDismiss && (
          <button type="button" className="coverage-panel-dismiss" onClick={onDismiss} title="Hide">×</button>
        )}
      </div>
      {checks.length > 0 && (
        <ul className="coverage-panel-list">
          {checks.map((c, i) => (
            <li key={i} className={`coverage-check severity-${c.severity}`}>
              <span className="coverage-check-code">{c.code.replace(/_/g, ' ')}</span>
              <span className="coverage-check-msg">{c.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
