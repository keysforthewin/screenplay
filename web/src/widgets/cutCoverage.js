// web/src/widgets/cutCoverage.js
// SPA twin of src/web/cutCoverage.js: is a cut the same camera setup as the
// cut before it? Keep the two in step.
//
// A setup is: who the cut is on, the size, the angle and the side of the room
// the camera stands on. The move is not part of it — a held cut followed by a
// push from the same spot still opens on the same picture.

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'at', 'on', 'in', 'from', 'and', 'with', 'its', 'his', 'her', 'their', 'toward', 'towards', 'looking', 'facing', 'side', 'camera']);

function words(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w && !STOP.has(w)),
  );
}

// 0..1 — how much two "side" cells say the same thing.
export function sideSimilarity(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size && !y.size) return 1;
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / (x.size + y.size - shared);
}

function subjectKey(cut) {
  const names = (cut?.in_frame || []).map((p) => String(p?.character || '').trim().toLowerCase()).filter(Boolean).sort();
  return `${String(cut?.action_by || '').trim().toLowerCase()}|${names.join(',')}`;
}

export const SAME_SIDE_THRESHOLD = 0.6;

export function sameSetup(a, b) {
  const ca = a?.camera || {};
  const cb = b?.camera || {};
  if (!ca.size || !cb.size || ca.size !== cb.size) return false;
  if ((ca.angle || null) !== (cb.angle || null)) return false;
  if (subjectKey(a) !== subjectKey(b)) return false;
  return sideSimilarity(ca.side, cb.side) >= SAME_SIDE_THRESHOLD;
}

// Consecutive rows on one setup that are not marked as a deliberate
// continuation: [{ index (0-based, the second cut of the pair) }].
export function findRepeatedSetups(cuts) {
  const out = [];
  const list = Array.isArray(cuts) ? cuts : [];
  for (let i = 1; i < list.length; i++) {
    if (!list[i]?.continues_previous && sameSetup(list[i - 1], list[i])) out.push({ index: i });
  }
  return out;
}
