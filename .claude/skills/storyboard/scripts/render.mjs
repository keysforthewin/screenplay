// Render cut frames through the app's own renderer (fal + reference binding +
// undo slot). Piped into the running bot container:
//   docker compose exec -T -e BEAT=2 -e FRAME=start bot node --input-type=module - < .claude/skills/storyboard/scripts/render.mjs
// env: BEAT (order, required) · PROJECT (title; default project when unset) ·
//      FRAME=start|end|kf · MODEL (default nano-banana-pro) · ONLY=1.1,2.3 (FRAME=kf
//      also takes 1.1@2.5 — the keyframe of cut 1.1 at 2.5 s) ·
//      FORCE=1 (re-render frames that already have an image) · POOL (default 4) ·
//      DRY=1 (print what would happen, render and write nothing) ·
//      ONE=1 (render exactly the ONLY= frames: no chain copy, no re-render of
//      later end frames in the chain — for fixing one keyframe by hand)
//
// Edit keyframes. A frame prompt that opens "Image N exactly — …" is an EDIT of
// its Nth reference (the previous keyframe of the same locked-off shot). The
// app's renderer would bind that picture as a set seen "from a different
// camera — rebuild it" (it is in no catalog) or, on an end frame, as an opening
// frame whose framing must NOT be copied — both invite a new picture. This
// script renders such a frame itself, with the same model and storage, and
// binds Image N as the shot to keep; every other reference keeps the app's
// binding (prop plate, identity, wardrobe, look).
//
// Keyframes (FRAME=kf). A cut's keyframes are rendered in time order, each
// after the one before it: before a keyframe renders, the previous picture of
// the cut (the keyframe before it, else the start frame) is put LAST in its
// references, so a prompt opening "Image N exactly" (N = its reference count)
// edits that picture. The end pass does the same for a keyframed cut: its
// end frame follows the LAST keyframe with an image instead of the start
// frame. A keyframed cut never chains — the whole shot is one cut.
//
// Continuous shots. A cut whose start-frame prompt is the same text as the
// previous cut's end-frame prompt (same scene) is CHAINED: its start frame is
// never rendered — it is a copy of the previous cut's end frame, stamped
// `model: chain:<source image id>`. The start pass skips chained cuts. The end
// pass walks each chain in order: render the end frame, copy it into the next
// cut's start frame, put that picture LAST in the next end frame's references
// (Image 4 — the renderer sorts the continuity frame last anyway; keeping it
// last in the stored list keeps the stored order equal to the numbering the
// end prompt uses), render that end frame, and so on. A re-rendered end frame therefore
// re-renders every end frame after it in its chain.
const { connectMongo, closeMongo } = await import('/app/src/mongo/client.js');
await connectMongo();
const { listProjects, getDefaultProject } = await import('/app/src/mongo/projects.js');
const { getPlot } = await import('/app/src/mongo/plots.js');
const { listVideoPrompts, getVideoPrompt } = await import('/app/src/mongo/videoPrompts.js');
const { listVideoScenes } = await import('/app/src/mongo/videoScenes.js');
const { readImageBuffer } = await import('/app/src/mongo/images.js');
const { renderCutFrame, storeCutFrameImage } = await import('/app/src/web/cutFrames.js');
const { setVideoPromptStartFrameViaGateway, getCutFrame } = await import('/app/src/web/gateway.js');
const { composeStartFramePrompt } = await import('/app/src/web/startFramePrompt.js');
const { dispatchStillImage } = await import('/app/src/web/stillImageDispatch.js');
const { buildReferenceCatalog } = await import('/app/src/web/referenceCatalog.js');
const { loadImageInput } = await import('/app/src/web/beatPlanShared.js');
const { stripMarkdown } = await import('/app/src/util/markdown.js');

const want = (process.env.PROJECT || '').trim().toLowerCase();
const project = want
  ? (await listProjects()).find((p) => p.title.toLowerCase() === want || String(p._id) === want)
  : await getDefaultProject();
if (!project) throw new Error(`unknown project "${process.env.PROJECT}"`);
const projectId = String(project._id);
const beat = ((await getPlot(projectId)).beats || []).find((b) => b.order === Number(process.env.BEAT));
if (!beat) throw new Error(`no beat with order ${process.env.BEAT} in "${project.title}"`);
const beatId = String(beat._id);

const frame = process.env.FRAME === 'end' ? 'end' : process.env.FRAME === 'kf' ? 'kf' : 'start';
const key = `${frame}_frame`;
const model = process.env.MODEL || 'nano-banana-pro';
const only = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const force = !!process.env.FORCE;
const dry = !!process.env.DRY;
const one = !!process.env.ONE;

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const order = new Map((await listVideoScenes({ projectId, beatId })).map((s) => [String(s._id), s.order]));
const all = (await listVideoPrompts({ projectId, beatId })).map((c) => ({ c, label: `${order.get(String(c.scene_id))}.${c.cut_index}` }));
all.forEach((x, i) => {
  const p = all[i - 1];
  const text = norm(x.c.start_frame?.prompt);
  x.prev = p && text && String(p.c.scene_id) === String(x.c.scene_id) && text === norm(p.c.end_frame?.prompt) ? p : null;
  x.wanted = !only.length || only.some((o) => o === x.label || o.startsWith(`${x.label}@`));
  // FRAME=kf: 1.1@2.5 picks one keyframe of the cut; 1.1 picks them all.
  x.times = only.filter((o) => o.startsWith(`${x.label}@`)).map((o) => Number(o.split('@')[1]));
});

const get = (x) => getVideoPrompt(projectId, String(x.c._id));

async function attempt(label, what, fn) {
  for (let n = 1; n <= 2; n++) {
    try {
      return await fn();
    } catch (e) {
      console.log(`FAIL ${label} ${what} attempt ${n}: ${e?.message || e}`);
    }
  }
  return null;
}

const kfs = (cut) => (cut.keyframes || []).slice().sort((a, b) => a.at_seconds - b.at_seconds);
const kfKey = (k) => `kf:${k.id}`;
const sub = (cut, which) => getCutFrame(cut, which);

// The picture a frame follows: the end frame follows the last keyframe with an
// image (else the start frame); a keyframe follows the keyframe before it
// (else the start frame). Its id is put LAST in the frame's references (the
// continuity frame — Image 4 with 4 references), whether or not `sb.py
// link-end` ran.
function previousImage(cut, which) {
  const list = kfs(cut);
  if (which === 'end') {
    const last = list.filter((k) => k.image_id).pop();
    return last ? String(last.image_id) : cut.start_frame?.image_id ? String(cut.start_frame.image_id) : null;
  }
  const i = list.findIndex((k) => kfKey(k) === which);
  for (let j = i - 1; j >= 0; j--) if (list[j].image_id) return String(list[j].image_id);
  return cut.start_frame?.image_id ? String(cut.start_frame.image_id) : null;
}

async function linkPrev(x, cut, which) {
  const prev = previousImage(cut, which);
  if (!prev) throw new Error('nothing to follow: the start frame is not rendered yet');
  const ids = (sub(cut, which)?.reference_ids || []).map(String);
  if (ids.length && ids[ids.length - 1] === prev) return cut;
  await setVideoPromptStartFrameViaGateway({
    projectId,
    promptId: String(x.c._id),
    frame: which,
    startFrame: { ...(sub(cut, which) || {}), reference_ids: [...ids.filter((id) => id !== prev && !kfs(cut).some((k) => String(k.image_id) === id) && id !== String(cut.start_frame?.image_id)).slice(0, 3), prev] },
  });
  return get(x);
}
const linkEnd = (x, cut) => linkPrev(x, cut, 'end');

const EDIT_RE = /^\s*Image (\d+) exactly\b/;
let catalog = null;
async function roster() {
  if (!catalog) {
    catalog = new Map();
    for (const e of await buildReferenceCatalog(projectId, beat)) {
      catalog.set(String(e.image_id), { name: e.owner_name, ownerType: e.owner_type, wardrobe: !!e.wardrobe, prop: e.prop || '' });
    }
  }
  return catalog;
}

// Render an edit keyframe: Image N (the base) is kept, the prompt says what changes.
async function renderEdit(cut, which, n) {
  const fr = sub(cut, which);
  const prompt = stripMarkdown(fr.prompt || '').trim();
  const ids = (fr.reference_ids || []).map(String);
  if (n < 1 || n > ids.length) throw new Error(`edit of Image ${n} but the frame has ${ids.length} reference(s)`);
  const who = await roster();
  const refs = [];
  for (const [i, id] of ids.entries()) {
    const img = await loadImageInput(id);
    if (!img) throw new Error(`reference ${id} not found`);
    const w = who.get(id);
    let role = 'look', label = w ? `the set "${w.name}"` : '';
    if (i === n - 1) { role = 'framing'; label = 'the shot'; }
    else if (w?.prop) { role = 'prop'; label = w.prop; }
    else if (w?.ownerType === 'character') { role = w.wardrobe ? 'wardrobe' : 'identity'; label = w.name; }
    refs.push({ ...img, role, label });
  }
  const parts = composeStartFramePrompt(prompt, refs).split('\n\n');
  parts[0] = `Edit Image ${n}. It is one frame of a film shot from a locked-off camera. Keep its framing, viewpoint, lens, composition, place, light and everything in it exactly as they are, and change only what the description below says is different. The other inputs are references, numbered in the order they are attached.`;
  parts[1] = parts[1].split('\n').map((l) => (l.startsWith(`Image ${n} `) ? `Image ${n} is the frame to edit: the same camera, the same place, the same moment's light. Reproduce it exactly, apart from the stated difference.` : l)).join('\n');
  const out = await dispatchStillImage({ prompt: parts.join('\n\n'), model, mode: 'generate', inputImages: refs.map(({ buffer, contentType }) => ({ buffer, contentType })) });
  return storeCutFrameImage({ projectId, cut, frame: which, buffer: out.buffer, contentType: out.contentType, prompt, model, generatedBy: out.model || model });
}

const tag = (cut, which) => (which.startsWith('kf:') ? `kf@${sub(cut, which)?.at_seconds}s` : which);

async function render(x, which) {
  if (dry) { console.log(`DRY ${x.label} ${tag(x.c, which)} would render`); return true; }
  return attempt(x.label, tag(x.c, which), async () => {
    let fresh = await get(x);
    if (which !== 'start' && !fresh.start_frame?.image_id) throw new Error('start frame not rendered yet');
    if (which !== 'start') fresh = await linkPrev(x, fresh, which);
    const fr = sub(fresh, which);
    if (!fr) throw new Error(`${which} no longer exists on the cut`);
    const refs = (fr.reference_ids || []).length;
    const edit = EDIT_RE.exec(stripMarkdown(fr.prompt || ''));
    const u = edit
      ? await renderEdit(fresh, which, Number(edit[1]))
      : await renderCutFrame({ projectId, cut: fresh, frame: which, imageModel: model });
    console.log(`OK ${x.label} ${tag(fresh, which)} refs=${refs}${edit ? ` edit-of=Image ${edit[1]}` : ''} image=${sub(u, which)?.image_id}`);
    return true;
  });
}

// Chained cut: make its start frame a copy of the previous cut's end frame and
// put it last in its own end frame's references. Returns 'same' | 'copied' | null.
async function carry(x) {
  const src = (await get(x.prev))?.end_frame?.image_id;
  if (!src) { console.log(`FAIL ${x.label} chain: ${x.prev.label} has no end frame`); return null; }
  const stamp = `chain:${src}`;
  const cur = await get(x);
  if (cur.start_frame?.image_id && cur.start_frame.model === stamp) return 'same';
  if (dry) { console.log(`DRY ${x.label} start would copy the end frame of ${x.prev.label}`); return 'copied'; }
  return attempt(x.label, 'chain', async () => {
    const read = await readImageBuffer(String(src));
    if (!read) throw new Error(`image ${src} not found`);
    const u = await storeCutFrameImage({ projectId, cut: cur, frame: 'start', buffer: read.buffer, contentType: read.file.contentType || 'image/png', model: stamp });
    const start = String(u.start_frame.image_id);
    await linkEnd(x, u);
    console.log(`CHAIN ${x.label} start = end frame of ${x.prev.label} image=${start}`);
    return 'copied';
  });
}

let queue;
if (frame === 'kf') {
  // Each cut's keyframes in time order, one cut at a time (a keyframe follows
  // the one before it); different cuts in parallel. ONE=1 changes nothing here.
  const jobs = all.filter((x) => x.wanted && kfs(x.c).length);
  const picks = (x) => kfs(x.c).filter((k) => (!x.times.length || x.times.includes(k.at_seconds)) && (force || !k.image_id));
  for (const x of all) if (x.wanted && !kfs(x.c).length && x.times.length) console.log(`SKIP ${x.label} has no keyframes`);
  console.log(`RENDER keyframes model=${model}: ${jobs.map((x) => `${x.label}[${picks(x).map((k) => `${k.at_seconds}s`).join(',') || '-'}]`).join(' ') || 'nothing'}`);
  queue = jobs.map((x) => async () => {
    for (const k of picks(x)) {
      if (!(await render(x, kfKey(k)))) return;
    }
  });
} else if (one) {
  if (!only.length) throw new Error('ONE=1 needs ONLY=<labels>');
  for (const x of all) if (x.wanted && x.prev && frame === 'start') console.log(`SKIP ${x.label} start is a chained copy — fix the end frame of ${x.prev.label}`);
  const jobs = all.filter((x) => x.wanted && !(x.prev && frame === 'start') && (force || !x.c[key]?.image_id));
  console.log(`RENDER ${frame} model=${model} (one frame each, no chain): ${jobs.map((x) => x.label).join(', ') || 'nothing'}`);
  queue = jobs.map((x) => () => render(x, frame));
} else if (frame === 'start') {
  for (const x of all) if (x.prev && x.wanted) console.log(`CHAIN ${x.label} start is the end frame of ${x.prev.label} — filled by the end pass`);
  const jobs = all.filter((x) => !x.prev && x.wanted && (force || !x.c.start_frame?.image_id));
  console.log(`RENDER start model=${model}: ${jobs.length} of ${all.filter((x) => x.wanted).length} cuts`);
  queue = jobs.map((x) => () => render(x, 'start'));
} else {
  // One unit of work per chain (a cut that continues nothing and is continued
  // by nothing is a chain of one); cuts inside a chain go strictly in order.
  const chains = [];
  for (const x of all) (x.prev ? chains[chains.length - 1] : chains[chains.push([]) - 1]).push(x);
  const long = chains.filter((ch) => ch.length > 1);
  for (const ch of long) console.log(`CHAIN ${ch.map((x) => x.label).join(' → ')}`);
  console.log(`RENDER end model=${model}: ${all.filter((x) => x.wanted).length} cuts, ${long.length} continuous shot(s)`);
  queue = chains.map((ch) => async () => {
    let moved = false; // an earlier end frame of this chain changed in this run
    for (const x of ch) {
      if (x.prev) {
        const r = await carry(x);
        if (!r) return;
        if (r === 'copied') moved = true;
      }
      const has = !!(await get(x))?.end_frame?.image_id;
      if (!(moved || (x.wanted && (force || !has)))) continue;
      if (!(await render(x, 'end'))) return;
      moved = true;
    }
  });
}
const pool = Number(process.env.POOL) || 4;
await Promise.all(Array.from({ length: pool }, async () => { while (queue.length) await queue.shift()(); }));
await closeMongo();
process.exit(0);
