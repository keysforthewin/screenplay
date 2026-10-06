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
//   wardrobe — a character's wardrobe plate: the clothes, nothing else.
//   prop     — a prop plate (an artwork with `prop` = the object's name): that
//              one object, exactly; never the place — bound as `look` it was
//              read as a view of the set and the object drifted.
//   continuity — the cut's own rendered start frame, when the user adds it to
//              the END frame's references: the same place and people a few
//              seconds earlier. It — not the character artwork — owns the
//              clothing, the props, the set dressing and the furniture layout;
//              never its framing.

export const REFERENCE_ROLES = ['identity', 'wardrobe', 'prop', 'look', 'framing', 'continuity'];

// `continuityHandle`: the handle of the opening frame when one rides along —
// it then owns the clothing, so an identity reference gives only the face.
function bindingLine(handle, { label, role, cameraMove }, continuityHandle = null) {
  const name = String(label || '').trim() || 'this subject';
  if (role === 'identity') {
    if (continuityHandle) {
      return `${handle} is ${name}: take only the face, hair and build from it. The clothing is exactly what this person wears in ${continuityHandle}; only if they are not in ${continuityHandle}, the clothing shown here.`;
    }
    return `${handle} is ${name}: take only the face, hair, build and wardrobe from it.`;
  }
  if (role === 'wardrobe') {
    // The wardrobe plate (src/web/wardrobe.js): the clothes, nothing else.
    return `${handle} is ${name}'s wardrobe plate: this person wears exactly these garments, in these colours, this fit and this footwear; take nothing else from it — not the pose, not the place, not the light.`;
  }
  if (role === 'prop') {
    // A prop plate (artwork.prop): one object by itself on a plain backdrop.
    return `${handle} is a prop plate of the ${name}: wherever the description below puts the ${name}, it is exactly this object — the same shape, material, colours, pattern and wear, at the real-world size the description gives. Take nothing else from it — not the plain background, not the light, not its position or angle. If the description does not mention the ${name}, it is not in the frame.`;
  }
  if (role === 'continuity') {
    return `${handle} is the opening frame of this same shot, a few seconds earlier. It is the same place and the same people: the same clothing on each person, the same objects and set dressing in the same places, the same furniture in the same arrangement and count, the same light and colour. Add nothing that is not in it and remove nothing from it, except what the description below says has changed or come into view. Do not copy its framing — the camera and everyone's pose are where the description below puts them now.${cameraMove ? ` It is the SAME camera, which has only done this since that frame: ${String(cameraMove).trim()}. It has not crossed to another side of the place or turned to face it from a new direction: what both frames can see is seen from nearly the same angle.` : ''}`;
  }
  if (role === 'framing') {
    return `${handle} shows ${name} from almost this camera: keep its architecture, layout and palette, and stay close to its viewpoint.`;
  }
  return `${handle} shows ${name} from a different camera: it is the same place — keep its architecture, materials, colours and signage style — but rebuild it from the camera described below. Do not reuse its framing, viewpoint or composition.`;
}

// refs: [{ label, role }] in upload order — the frame's stored order, never
// re-sorted: handle N is the Nth stored reference, which is what the frame
// prompt means by "Image N". (Edit-style models anchor hardest on image 1, so
// the author lists identities first and set plates after; the skill and the
// SPA's "+ Start frame" button put the continuity frame last.) `token` is the
// model's handle pattern with {n} (ComfyUI Qwen: '<image{n}>'). No refs → the
// prompt as-is.
export function composeStartFramePrompt(prompt, refs = [], { token = 'Image {n}' } = {}) {
  const text = String(prompt || '').trim();
  const list = Array.isArray(refs) ? refs : [];
  if (!list.length) return text;
  const handle = (n) => String(token).replace('{n}', String(n));
  const continuityAt = list.findIndex((r) => r.role === 'continuity');
  const continuityHandle = continuityAt >= 0 ? handle(continuityAt + 1) : null;
  return [
    'Generate a new cinematic 16:9 film still. This is not an edit of any input image — the inputs are references only, numbered in the order they are attached, and the frame, camera position and everything in shot come from the description below.',
    list.map((r, i) => bindingLine(handle(i + 1), r, continuityHandle)).join('\n'),
    'The shot:',
    text,
  ].join('\n\n');
}
