// Pure display helpers for storyboard critique scores. No React — unit-tested
// in Node so the score/band/flag logic is covered even without a DOM harness.

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
