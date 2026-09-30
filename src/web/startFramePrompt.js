// startFramePrompt.js
//
// What an image model is told about a start frame's reference images. The
// still prompt describes the frame, not the inputs, so the binding is ours to
// write — and it decides whether a reference is copied or merely consulted.
// Multi-reference models (and edit models above all) otherwise treat the
// first input as the canvas: one exterior set artwork then comes back as the
// same picture for every camera around the building.
//
// Roles:
//   identity — a character: take the face, hair, build and wardrobe only.
//   look     — a set seen from another camera: the same place (architecture,
//              materials, colours, signage style) rebuilt from THIS camera.
//   framing  — a set whose viewpoint this cut reproduces: stay close to it.
//   continuity — the cut's own rendered start frame, handed to its END frame:
//              match light, palette and wardrobe; never its framing.

export const REFERENCE_ROLES = ['identity', 'look', 'framing', 'continuity'];

function bindingLine(handle, { label, role }) {
  const name = String(label || '').trim() || 'this subject';
  if (role === 'identity') {
    return `${handle} is ${name}: take only the face, hair, build and wardrobe from it.`;
  }
  if (role === 'continuity') {
    return `${handle} is the opening frame of this same shot, a few seconds earlier: match its light, colour palette, wardrobe and the look of the place, but do not copy its framing — the camera and everyone in shot are where the description below puts them now.`;
  }
  if (role === 'framing') {
    return `${handle} shows ${name} from almost this camera: keep its architecture, layout and palette, and stay close to its viewpoint.`;
  }
  return `${handle} shows ${name} from a different camera: it is the same place — keep its architecture, materials, colours and signage style — but rebuild it from the camera described below. Do not reuse its framing, viewpoint or composition.`;
}

// refs: [{ label, role }] in upload order. `token` is the model's handle
// pattern with {n} (ComfyUI Qwen: '<image{n}>'). No refs → the prompt as-is.
export function composeStartFramePrompt(prompt, refs = [], { token = 'Image {n}' } = {}) {
  const text = String(prompt || '').trim();
  const list = Array.isArray(refs) ? refs : [];
  if (!list.length) return text;
  const handle = (n) => String(token).replace('{n}', String(n));
  return [
    'Generate a new cinematic 16:9 film still. This is not an edit of any input image — the inputs are references only, and the frame, camera position and everything in shot come from the description below.',
    list.map((r, i) => bindingLine(handle(i + 1), r)).join('\n'),
    'The shot:',
    text,
  ].join('\n\n');
}

// Edit-style models anchor hardest on image 1. A framing reference wants
// exactly that, so it goes first; then identities; look references last, so
// a building seen from elsewhere never becomes the canvas. The continuity
// frame goes last of all for the same reason.
export function orderReferencesByRole(refs = []) {
  const rank = (r) => (r.role === 'framing' ? 0 : r.role === 'identity' ? 1 : r.role === 'continuity' ? 3 : 2);
  return refs.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map(({ r }) => r);
}
