// SHOT_TYPES kept in sync with src/mongo/storyboards.js. The server is the
// source of truth — if you add a type here, update the Mongo module too and
// the planner enum in src/web/storyboardGenerate.js.
export const SHOT_TYPES = [
  'establishing',
  'cinematic_wide',
  'insert',
  'medium',
  'close_up',
  'reaction',
  'two_shot',
  'over_the_shoulder',
];

export const DURATION_CAP = {
  establishing: 15,
  cinematic_wide: 15,
  insert: 15,
  medium: 10,
  close_up: 5,
  reaction: 5,
  two_shot: 5,
  over_the_shoulder: 5,
};

export const ABSOLUTE_DURATION_CAP = 15;

export function durationCapFor(shotType) {
  return DURATION_CAP[shotType] ?? ABSOLUTE_DURATION_CAP;
}

export function shotTypeLabel(t) {
  return t ? t.replace(/_/g, ' ') : '';
}

// mm:ss formatter for the runtime tally header.
export function formatRuntime(totalSeconds) {
  const total = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
