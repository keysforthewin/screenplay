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
//              the same place and people a few seconds earlier. It — not the
//              character artwork — owns the clothing, the props, the set
//              dressing and the furniture layout; never its framing. (A jacket
//              became the artwork's T-shirt, a butter dispenser grew out of a
//              counter and seat rows rearranged themselves before this said so.)
//              `cameraMove` (the cut's movement + travel) tells it the camera
//              is the same one, a few seconds along its move.
//
// A HELD camera does not use references at all for its end frame: the end
// frame is an edit of the start frame (composeDerivedEndPrompt).

export const REFERENCE_ROLES = ['identity', 'wardrobe', 'look', 'framing', 'continuity'];

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
  if (role === 'continuity') {
    return `${handle} is the opening frame of this same shot, a few seconds earlier. It is the same place and the same people: the same clothing on each person, the same objects and set dressing in the same places, the same furniture in the same arrangement and count, the same light and colour. Add nothing that is not in it and remove nothing from it, except what the description below says has changed or come into view. Do not copy its framing — the camera and everyone's pose are where the description below puts them now.${cameraMove ? ` It is the SAME camera, which has only done this since that frame: ${String(cameraMove).trim()}. It has not crossed to another side of the place or turned to face it from a new direction: what both frames can see is seen from nearly the same angle.` : ''}`;
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
  const continuityAt = list.findIndex((r) => r.role === 'continuity');
  const continuityHandle = continuityAt >= 0 ? handle(continuityAt + 1) : null;
  return [
    'Generate a new cinematic 16:9 film still. This is not an edit of any input image — the inputs are references only, and the frame, camera position and everything in shot come from the description below.',
    list.map((r, i) => bindingLine(handle(i + 1), r, continuityHandle)).join('\n'),
    'The shot:',
    text,
  ].join('\n\n');
}

// What the still must read as, from the cut it belongs to: the image model
// never sees the block, so the cut's felt intent, eyeline and "Do not show …"
// sentences ride along under the still prompt. Empty when the cut has none.
// `wardrobeLocks`: the `Wardrobe lock — <name>: <text>` block for the people
// in frame (src/web/wardrobe.js#formatWardrobeLocks), appended last.
export function composeIntentNote(cut, { wardrobeLocks = '' } = {}) {
  const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  const lines = [];
  if (clean(cut?.felt_intent)) lines.push(`What it must read as at a glance: ${clean(cut.felt_intent)}`);
  if (clean(cut?.hook)) lines.push(`What catches the eye — place it where the eye lands first, large enough to read: ${clean(cut.hook)}`);
  if (clean(cut?.eyeline)) lines.push(`Eyes: ${clean(cut.eyeline)}`);
  const never = (Array.isArray(cut?.exclusions) ? cut.exclusions : []).map(clean).filter(Boolean);
  if (never.length) lines.push(`Hard limits: ${never.join(' ')}`);
  const locks = String(wardrobeLocks || '').trim();
  if (!lines.length && !locks) return '';
  const head = lines.length ? ['The shot this frame belongs to — the picture must show this in the bodies and the staging, not as a caption:', ...lines] : [];
  const tail = locks ? ['Clothes are locked — each person wears exactly this, whatever the description above or any reference shows:', locks] : [];
  return [...head, ...tail].join('\n');
}

// A held camera's END frame: an edit of the rendered start frame. `changes` is
// the end-frame prompt, which for a held camera is a change list ("Same frame.
// The bucket lies on its side on the carpet by his left shoe…"). The picture
// is the input; only what the list names may differ, so the set, the props,
// the seats and every stitch of clothing are the start frame's own pixels.
export function composeDerivedEndPrompt(changes, { handle = 'This image' } = {}) {
  const text = String(changes || '').trim().replace(/^same frame[.:,;]?\s*/i, '');
  return [
    `${handle} is the opening frame of a film shot. Produce the closing frame of the same shot, a few seconds later, from the identical camera: same position, lens and framing.`,
    'Keep everything exactly as it is — the set, every piece of furniture and every prop in its place, every person\'s face, hair and clothing, the light and the colour. Add nothing and remove nothing.',
    'Change only this:',
    text,
  ].join('\n\n');
}

// The END frame of a camera that moves without sliding the picture (a push, a
// pull, a track forward), REBUILT from the rendered start frame after the pair
// check found the fresh still had changed the people or the place: one edit of
// the start frame, so every face in a crowd is the start frame's own.
// `endPrompt` is the end-frame prompt, `cameraMove` the cut's move in words,
// `guidance` the checker's corrections.
export function composeMovedEndPrompt(endPrompt, { cameraMove = '', guidance = '', handle = 'This image' } = {}) {
  const move = String(cameraMove || '').trim();
  const fixes = String(guidance || '').trim();
  return [
    `${handle} is the opening frame of a film shot. Produce the closing frame of the same shot, a few seconds later, taken by the SAME camera${move ? `, which has only done this since: ${move}` : ', which has barely moved'}. It has not crossed to another side of the place.`,
    'Everyone in the picture is the same individual as in the opening frame — the same face, hair, build and clothing, in the same seat or spot unless the description below moves them. That holds for every background person too: the same people in the same places, never a different crowd of the same size. The same furniture in the same arrangement and count, the same props in the same places, the same architecture, light and colour.',
    'The closing frame, described:',
    String(endPrompt || '').trim(),
    ...(fixes ? ['It must also be true of the closing frame:', fixes] : []),
  ].join('\n\n');
}

// The same end frame when the start frame is not rendered yet: a fresh still
// from the start prompt with the change list applied in words.
export function composeUnderivedEndPrompt(startPrompt, changes) {
  const start = String(startPrompt || '').trim();
  const text = String(changes || '').trim().replace(/^same frame[.:,;]?\s*/i, '');
  if (!start) return text;
  return `${start}\n\nThe same frame a few seconds later, everything else unchanged: ${text}`;
}

// Edit-style models anchor hardest on image 1. A framing reference wants
// exactly that, so it goes first; then identities; look references last, so
// a building seen from elsewhere never becomes the canvas. The continuity
// frame goes last of all for the same reason.
export function orderReferencesByRole(refs = []) {
  const rank = (r) => (r.role === 'framing' ? 0 : r.role === 'identity' ? 1 : r.role === 'wardrobe' ? 2 : r.role === 'continuity' ? 4 : 3);
  return refs.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map(({ r }) => r);
}
