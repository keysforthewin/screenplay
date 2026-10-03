// Pure display helpers for the beat critique scores. No React — unit-tested
// in Node so the score/band/flag logic is covered even without a DOM harness.
// (pickCritiqueScore / isFlagged are storyboard-era leftovers kept for their tests.)

export const FLAG_THRESHOLD = 6; // scores strictly below this get a ⚑

// The score to show on a shot: the rendered-image critique if it exists,
// otherwise the prompt critique, otherwise null (not yet critiqued).
export function pickCritiqueScore(sb) {
  const img = sb?.image_critique?.overall;
  if (typeof img === 'number') return img;
  const prm = sb?.prompt_critique?.overall;
  if (typeof prm === 'number') return prm;
  return null;
}

// Color band for a 1-10 score: 8+ good, 6-7 medium, <=5 bad.
export function scoreBand(score) {
  if (typeof score !== 'number') return null;
  if (score >= 8) return 'good';
  if (score >= 6) return 'medium';
  return 'bad';
}

export function isFlagged(score) {
  return typeof score === 'number' && score < FLAG_THRESHOLD;
}

// ── Beat writing critique v2 (criteria + ranked issues) ──────────────────

export const SEVERITY_ORDER = ['must_fix', 'should_fix', 'nit'];
export const SEVERITY_LABELS = { must_fix: 'Must fix', should_fix: 'Should fix', nit: 'Nit' };

// An integer score stays "8"; a derived decimal shows one place ("7.3").
export function formatScore(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function sortIssues(issues) {
  const rank = (s) => { const i = SEVERITY_ORDER.indexOf(s); return i === -1 ? SEVERITY_ORDER.length : i; };
  return [...(issues || [])].sort((a, b) => rank(a.severity) - rank(b.severity));
}

// Counts across finished facets only: { must_fix, should_fix, nit }.
export function issueCounts(facets) {
  const out = { must_fix: 0, should_fix: 0, nit: 0 };
  for (const f of facets || []) {
    if (f?.status !== 'done') continue;
    for (const i of f.issues || []) if (i?.severity in out) out[i.severity] += 1;
  }
  return out;
}

export function hasCriteria(facet) {
  return Array.isArray(facet?.criteria) && facet.criteria.length > 0;
}

// Artwork coverage percentage band: 80+ good, 50-79 medium, below bad.
export function coverageBand(pct) {
  if (typeof pct !== 'number') return null;
  if (pct >= 80) return 'good';
  if (pct >= 50) return 'medium';
  return 'bad';
}
