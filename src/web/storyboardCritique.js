// Multi-lens critique panel for storyboard shots. Each lens is an independent
// forced-tool Anthropic call scoring 1–10 with comments; aggregateCritique
// combines them with a strict cap (any lens <= CRITICAL_SCORE pins the overall
// so one hard failure can't be averaged away).

export const CRITICAL_SCORE = 3;

// The four judging lenses. `key` is persisted; `label` is human-facing; `focus`
// is the one-line system-prompt framing for that lens; `instruction` is the
// reminder injected into the judge's user text.
export const CRITIQUE_LENSES = Object.freeze([
  {
    key: 'bible',
    label: 'Bible adherence',
    focus: 'how faithfully the shot honors the scene bible',
    instruction:
      'Judge ONLY whether the shot honors the scene bible — location, time of day, lighting key, palette, mood, blocking, and camera language. Reward consistency; penalize drift or contradiction.',
  },
  {
    key: 'director_notes',
    label: "Director's-notes adherence",
    focus: "how well the shot respects the project-wide director's notes",
    instruction:
      "Judge ONLY whether the shot respects the project-wide director's notes (global tone / style / continuity directives). If there are no notes, score 8 and say so.",
  },
  {
    key: 'cinematic',
    label: 'Cinematic quality',
    focus: 'the cinematic merit of the shot',
    instruction:
      'Judge ONLY cinematic merit — composition, shot value, framing choice, and whether this shot earns its place in the sequence. Ignore bible/notes adherence (other lenses cover those).',
  },
  {
    key: 'continuity',
    label: 'Continuity',
    focus: 'how cleanly the shot hands off to and from its neighbors',
    instruction:
      'Judge ONLY continuity with the neighbor shots shown — does this shot hand off cleanly (shared subject, matching motion vector, deliberate match cut)? Penalize jarring jumps or drift between neighbors.',
  },
]);

const LENS_KEYS = new Set(CRITIQUE_LENSES.map((l) => l.key));

// Coerce a model-provided score to an integer in [1, 10].
export function clampScore(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 1;
  return Math.min(10, Math.max(1, Math.round(v)));
}

// Combine per-lens results into { overall, lowest_lens }. overall = rounded mean,
// but if any lens scored <= CRITICAL_SCORE the overall is capped at the lowest
// such score. lowest_lens names the worst-scoring lens (first one on ties).
export function aggregateCritique(lensResults) {
  const lenses = (Array.isArray(lensResults) ? lensResults : []).filter(
    (l) => l && LENS_KEYS.has(l.lens),
  );
  if (!lenses.length) return { overall: 1, lowest_lens: null };
  const scores = lenses.map((l) => clampScore(l.score));
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  let overall = Math.min(10, Math.max(1, Math.round(mean)));
  const critical = scores.filter((s) => s <= CRITICAL_SCORE);
  if (critical.length) overall = Math.min(overall, ...critical);
  let lowest = lenses[0];
  let lowestScore = clampScore(lenses[0].score);
  for (const l of lenses) {
    const s = clampScore(l.score);
    if (s < lowestScore) {
      lowest = l;
      lowestScore = s;
    }
  }
  return { overall, lowest_lens: lowest.lens };
}
