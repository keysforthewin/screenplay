// cutValidation.js
//
// Input rules shared by the Scenes tab's REST routes (cutRoutes.js) and the
// MCP server (src/mcp/).

const HEX24 = /^[a-f0-9]{24}$/i;
export const isOidHex = (s) => typeof s === 'string' && HEX24.test(s);

export const MAX_CUT_SECONDS = 600;
export const MAX_SCENE_TITLE = 500;

// An array of 24-hex ids as strings, or null when it is anything else.
export function cleanIdList(v) {
  return Array.isArray(v) && v.every((x) => isOidHex(String(x))) ? v.map(String) : null;
}

// A cut's length: null / '' clears it, otherwise more than 0 and at most
// MAX_CUT_SECONDS seconds.
export function isValidCutDuration(raw) {
  if (raw == null || raw === '') return true;
  if (typeof raw !== 'number' && typeof raw !== 'string') return false;
  return Number(raw) > 0 && Number(raw) <= MAX_CUT_SECONDS;
}

// A keyframe's time: a number strictly inside the cut's length, half a second
// in from either end (the start and end frames hold those). A cut with no
// length cannot take keyframes.
export const KEYFRAME_MARGIN_SECONDS = 0.5;
export function isValidKeyframeTime(raw, durationSeconds) {
  if (typeof raw !== 'number' && typeof raw !== 'string') return false;
  const t = Number(raw);
  const d = Number(durationSeconds);
  if (!Number.isFinite(t) || !Number.isFinite(d) || d <= 0) return false;
  return t >= KEYFRAME_MARGIN_SECONDS && t <= d - KEYFRAME_MARGIN_SECONDS;
}

// A keyframe's guide strength: null / '' = the renderer's default, else 0..1.
export function isValidStrength(raw) {
  if (raw == null || raw === '') return true;
  if (typeof raw !== 'number' && typeof raw !== 'string') return false;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1;
}
