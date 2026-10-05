// Render cut frames through the app's own renderer (fal + reference binding +
// undo slot). Piped into the running bot container:
//   docker compose exec -T -e BEAT=2 -e FRAME=start bot node --input-type=module - < .claude/skills/storyboard/scripts/render.mjs
// env: BEAT (order, required) · PROJECT (title; default project when unset) ·
//      FRAME=start|end · MODEL (default nano-banana-pro) · ONLY=1.1,2.3 ·
//      FORCE=1 (re-render frames that already have an image) · POOL (default 4)
const { connectMongo, closeMongo } = await import('/app/src/mongo/client.js');
await connectMongo();
const { listProjects, getDefaultProject } = await import('/app/src/mongo/projects.js');
const { getPlot } = await import('/app/src/mongo/plots.js');
const { listVideoPrompts, getVideoPrompt } = await import('/app/src/mongo/videoPrompts.js');
const { listVideoScenes } = await import('/app/src/mongo/videoScenes.js');
const { renderCutFrame } = await import('/app/src/web/cutFrames.js');

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

const order = new Map((await listVideoScenes({ projectId, beatId })).map((s) => [String(s._id), s.order]));
let cuts = (await listVideoPrompts({ projectId, beatId })).map((c) => ({ c, label: `${order.get(String(c.scene_id))}.${c.cut_index}` }));
if (only.length) cuts = cuts.filter((x) => only.includes(x.label));
const queue = cuts.filter((x) => force || !x.c[key]?.image_id);
console.log(`RENDER ${frame} model=${model}: ${queue.length} of ${cuts.length} cuts`);

async function one({ c, label }) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const fresh = await getVideoPrompt(projectId, String(c._id));
      const refs = (fresh[key]?.reference_ids || []).length;
      if (frame === 'end' && !fresh.start_frame?.image_id) throw new Error('start frame not rendered yet');
      const u = await renderCutFrame({ projectId, cut: fresh, frame, imageModel: model });
      console.log(`OK ${label} ${frame} refs=${refs} image=${u[key]?.image_id}`);
      return;
    } catch (e) {
      console.log(`FAIL ${label} ${frame} attempt ${attempt}: ${e?.message || e}`);
    }
  }
}
const pool = Number(process.env.POOL) || 4;
await Promise.all(Array.from({ length: pool }, async () => { while (queue.length) await one(queue.shift()); }));
await closeMongo();
process.exit(0);
