// Body-field validators shared by the fal video routes (storyboard rows in
// entityRoutes.js, cuts in cutVideoRoutes.js).

// Sentinel returned by the resolution/fps validators when they've already
// sent a 400. Callers check `=== ERR` and bail out of the route.
export const ERR = Symbol('input-validation-error');

const RESOLUTION_RE = /^[A-Za-z0-9_]{1,24}$/;

// Validate a `resolution` body field on the /video/preview and
// /video/generate routes. Returns the trimmed string, null when absent,
// or the ERR sentinel after writing a 400 to `res`.
export function parseResolutionField(raw, res) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') {
    res.status(400).json({ error: 'resolution must be a string' });
    return ERR;
  }
  const trimmed = raw.trim();
  if (!RESOLUTION_RE.test(trimmed)) {
    res.status(400).json({ error: 'resolution must be a short alphanumeric tag like "720p"' });
    return ERR;
  }
  return trimmed;
}

// Validate an `fps` body field. Returns an integer in [1, 120], null
// when absent, or ERR after a 400.
export function parseFpsField(raw, res) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 120) {
    res.status(400).json({ error: 'fps must be a number between 1 and 120' });
    return ERR;
  }
  return Math.round(n);
}
