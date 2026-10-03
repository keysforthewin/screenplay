// Pure scoring for the beat writing critique. The model scores each facet's
// criteria against written anchors and names ranked issues; everything that
// turns those into a facet score and an overall lives here, deterministically,
// so the numbers are reproducible and the caps the prompt promises are real.

export const SEVERITY_ORDER = ['must_fix', 'should_fix', 'nit'];
export const QUOTE_MAX = 200;

// Prepended to every facet's system prompt. The caps in rule 6 are also
// enforced in deriveFacetScore — the prompt only asks the model to agree.
export const SCORING_RULES = [
  '# Scoring rules',
  '1. Score the text on the page, not its intent, premise or ambition.',
  '2. For each criterion: first quote the lines you are judging (verbatim from the beat, at most 200 characters each), then pick the anchor the text most resembles. 3, 6 and 9 are anchors; use the full 1-10 range between and beyond them.',
  '3. A 10 means you cannot name a change that would improve it. 5 or below means a reader would notice the problem unaided.',
  '4. A criterion whose context is absent (no scene bible, no dialogue style, no beat-level direction) is reported with applicable=false — never guess what the missing document would say.',
  '5. Every issue names exactly one criterion, quotes the offending line(s), states the problem in one sentence and gives a concrete fix: the rewritten line, the mini-slug to add, the line to cut. Severity: must_fix = a reader or a production would be misled or stalled; should_fix = clearly weaker than it could be; nit = taste.',
  '6. Any must_fix issue caps its criterion at 6 and the whole facet at 7 — the scorer enforces this, so score consistently with the issues you raise.',
  '7. Do not reward length or ambition; do not penalize anything this facet does not judge.',
  '8. Name at least one strength whenever a criterion scores 7 or higher.',
].join('\n');

export function clampScore(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.min(10, Math.max(1, Math.round(v * 10) / 10));
}

function clampInt(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return null;
  return Math.min(10, Math.max(1, v));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function str(s, max = Infinity) {
  const v = typeof s === 'string' ? s.trim() : '';
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

function severityRank(s) {
  const i = SEVERITY_ORDER.indexOf(s);
  return i === -1 ? SEVERITY_ORDER.length : i;
}

export function sortIssues(issues) {
  return [...(issues || [])].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

// Derive one facet's score from its criteria and issues.
//   - weighted mean of applicable criteria (criterion.weight, default 1), one decimal
//   - a criterion named by a must_fix is capped at 6 before averaging
//   - ≥1 must_fix → ≤7; ≥2 must_fix → ≤5; no must_fix but ≥3 should_fix → ≤8
//   - null when no criterion is applicable
export function deriveFacetScore(criteria, issues = [], facet = null) {
  const mustFix = (issues || []).filter((i) => i.severity === 'must_fix');
  const shouldFix = (issues || []).filter((i) => i.severity === 'should_fix');
  const cappedKeys = new Set(mustFix.map((i) => i.criterion));
  let sum = 0;
  let wsum = 0;
  for (const c of criteria || []) {
    if (!c || c.applicable === false || c.score == null) continue;
    const def = facet?.criteria?.find((d) => d.key === c.key);
    const w = Number(c.weight ?? def?.weight ?? 1) || 1;
    const s = cappedKeys.has(c.key) ? Math.min(6, c.score) : c.score;
    sum += s * w;
    wsum += w;
  }
  if (!wsum) return null;
  let score = sum / wsum;
  if (mustFix.length >= 2) score = Math.min(score, 5);
  else if (mustFix.length === 1) score = Math.min(score, 7);
  else if (shouldFix.length >= 3) score = Math.min(score, 8);
  return round1(score);
}

// Weighted mean over finished facets; weights come from the registry
// (required facets 1.5, others 1). One decimal; null when nothing finished.
export function deriveOverall(facets, registry = []) {
  let sum = 0;
  let wsum = 0;
  for (const f of facets || []) {
    if (f.status !== 'done' || typeof f.score !== 'number') continue;
    const def = registry.find((d) => d.key === f.key);
    const w = Number(def?.weight ?? (def?.required ? 1.5 : 1)) || 1;
    sum += f.score * w;
    wsum += w;
  }
  return wsum ? round1(sum / wsum) : null;
}

// Normalize whatever the model (or a test stub) returned into the stored facet
// shape. Accepts the legacy {score, comments} too, so old stubs and the test
// seam keep working: those come back with no criteria and the score kept.
export function normalizeFacetResult(raw, facet) {
  const defs = Array.isArray(facet?.criteria) ? facet.criteria : [];
  const keys = new Set(defs.map((d) => d.key));
  const rawCriteria = Array.isArray(raw?.criteria) ? raw.criteria : [];
  const legacy = !rawCriteria.length && raw?.score != null;

  const byKey = new Map();
  for (const c of rawCriteria) {
    if (!c || !keys.has(c.key) || byKey.has(c.key)) continue;
    const applicable = c.applicable !== false;
    byKey.set(c.key, {
      key: c.key,
      label: defs.find((d) => d.key === c.key)?.label || c.key,
      weight: Number(defs.find((d) => d.key === c.key)?.weight ?? 1) || 1,
      applicable,
      score: applicable ? clampInt(c.score) : null,
      evidence: (Array.isArray(c.evidence) ? c.evidence : [])
        .map((e) => ({ quote: str(e?.quote, QUOTE_MAX), note: str(e?.note, 400) }))
        .filter((e) => e.quote || e.note)
        .slice(0, 6),
      rationale: str(c.rationale, 800),
    });
  }
  const criteria = legacy
    ? []
    : defs.map((d) => byKey.get(d.key) || {
      key: d.key, label: d.label, weight: Number(d.weight ?? 1) || 1, applicable: false, score: null, evidence: [], rationale: '',
    });
  // An applicable criterion without a usable score counts as not applicable.
  for (const c of criteria) if (c.applicable && c.score == null) c.applicable = false;

  const issues = sortIssues(
    (Array.isArray(raw?.issues) ? raw.issues : [])
      .filter((i) => i && SEVERITY_ORDER.includes(i.severity) && (keys.has(i.criterion) || legacy))
      .map((i) => ({
        severity: i.severity,
        criterion: keys.has(i.criterion) ? i.criterion : '',
        quote: str(i.quote, QUOTE_MAX),
        problem: str(i.problem, 600),
        fix: str(i.fix, 800),
      }))
      .filter((i) => i.problem || i.fix),
  ).slice(0, 20);

  const strengths = (Array.isArray(raw?.strengths) ? raw.strengths : []).map((s) => str(s, 300)).filter(Boolean).slice(0, 8);
  const summary = str(raw?.summary, 2000) || str(raw?.comments, 2000);
  const score = legacy ? clampScore(raw.score) : deriveFacetScore(criteria, issues, facet);
  return { score, summary, comments: summary, criteria, issues, strengths };
}

// Every finished facet's issues in one list, most severe first, then by facet
// weight (required facets first). Feeds the rewrite strategy and the UI counts.
export function collectRankedIssues(critique, registry = []) {
  const out = [];
  for (const f of critique?.facets || []) {
    if (f.status !== 'done') continue;
    const def = registry.find((d) => d.key === f.key);
    const weight = Number(def?.weight ?? (def?.required ? 1.5 : 1)) || 1;
    for (const i of f.issues || []) {
      out.push({ facet_key: f.key, facet_label: f.label, facet_weight: weight, ...i });
    }
  }
  return out.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.facet_weight - a.facet_weight);
}
