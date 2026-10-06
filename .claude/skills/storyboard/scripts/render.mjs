// Render cut frames through the app's own renderer (fal + reference binding +
// undo slot). Piped into the running bot container:
//   docker compose exec -T -e BEAT=2 -e FRAME=start bot node --input-type=module - < .claude/skills/storyboard/scripts/render.mjs
// env: BEAT (order, required) · PROJECT (title; default project when unset) ·
//      FRAME=start|end · MODEL (default nano-banana-pro) · ONLY=1.1,2.3 ·
//      FORCE=1 (re-render frames that already have an image) · POOL (default 4) ·
//      DRY=1 (print what would happen, render and write nothing)
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
const { setVideoPromptStartFrameViaGateway } = await import('/app/src/web/gateway.js');

const want = (process.env.PROJECT || '').trim().toLowerCase();
const project = want
  ? (await listProjects()).find((p) => p.title.toLowerCase() === want || String(p._id) === want)
  : await getDefaultProject();
if (!project) throw new Error(`unknown project "${process.env.PROJECT}"`);
const projectId = String(project._id);
const beat = ((await getPlot(projectId)).beats || []).find((b) => b.order === Number(process.env.BEAT));
if (!beat) throw new Error(`no beat with order ${process.env.BEAT} in "${project.title}"`);
const beatId = String(beat._id);

const frame = process.env.FRAME === 'end' ? 'end' : 'start';
const key = `${frame}_frame`;
const model = process.env.MODEL || 'nano-banana-pro';
const only = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const force = !!process.env.FORCE;
const dry = !!process.env.DRY;

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const order = new Map((await listVideoScenes({ projectId, beatId })).map((s) => [String(s._id), s.order]));
const all = (await listVideoPrompts({ projectId, beatId })).map((c) => ({ c, label: `${order.get(String(c.scene_id))}.${c.cut_index}` }));
all.forEach((x, i) => {
  const p = all[i - 1];
  const text = norm(x.c.start_frame?.prompt);
  x.prev = p && text && String(p.c.scene_id) === String(x.c.scene_id) && text === norm(p.c.end_frame?.prompt) ? p : null;
  x.wanted = !only.length || only.includes(x.label);
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

// An end frame is always rendered with the cut's own start frame as its LAST
// reference (the continuity frame, Image 4), whether or not `sb.py link-end` ran.
async function linkEnd(x, cut) {
  const start = String(cut.start_frame.image_id);
  const ids = (cut.end_frame?.reference_ids || []).map(String);
  if (ids.length && ids[ids.length - 1] === start) return cut;
  await setVideoPromptStartFrameViaGateway({
    projectId,
    promptId: String(x.c._id),
    frame: 'end',
    startFrame: { ...(cut.end_frame || {}), reference_ids: [...ids.filter((id) => id !== start).slice(0, 3), start] },
  });
  return get(x);
}

async function render(x, which) {
  if (dry) { console.log(`DRY ${x.label} ${which} would render`); return true; }
  return attempt(x.label, which, async () => {
    let fresh = await get(x);
    const k = `${which}_frame`;
    if (which === 'end' && !fresh.start_frame?.image_id) throw new Error('start frame not rendered yet');
    if (which === 'end') fresh = await linkEnd(x, fresh);
    const refs = (fresh[k]?.reference_ids || []).length;
    const u = await renderCutFrame({ projectId, cut: fresh, frame: which, imageModel: model });
    console.log(`OK ${x.label} ${which} refs=${refs} image=${u[k]?.image_id}`);
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
if (frame === 'start') {
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
