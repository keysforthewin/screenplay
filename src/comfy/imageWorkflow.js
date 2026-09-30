// Graph edits for ComfyUI IMAGE templates (frontend-format workflow JSON).
//
// An image-edit template ships with one or two LoadImage nodes wired into the
// node that consumes the references — usually a subgraph instance that has
// more IMAGE inputs than the template bothers to wire (Qwen Image 2.1 exposes
// image_1…image_10 and wires two). A start frame carries as many references
// as the cut has characters and sets, so before a run we reshape the graph to
// the render at hand: extra LoadImage nodes on the spare inputs, the unused
// stock LoadImages removed (they point at sample files that would otherwise
// leak into the picture), and every output node but the one we read pruned.
//
// Pure: no I/O, no ComfyUI. `analyzeImageWorkflow` only reads; 
// `prepareImageWorkflow` returns an edited deep copy.

const PREVIEW_RE = /^(ImageCompare|PreviewImage|PreviewAny)$/;
const SAVE_RE = /^SaveImage/;
// LiteGraph modes: 2 = muted, 4 = bypassed. A bypassed pipeline still counts:
// templates ship their multi-reference variant switched off (Flux.2 Klein),
// and prepareImageWorkflow switches the chosen one back on.
const isLive = (n) => n && n.mode !== 2;

// Top-level links come as [id, origin, origin_slot, target, target_slot, type]
// (subgraph interiors use objects; tolerate both).
function linkOf(l) {
  if (Array.isArray(l)) {
    return { id: l[0], origin_id: l[1], origin_slot: l[2], target_id: l[3], target_slot: l[4], type: l[5] };
  }
  return l && typeof l === 'object' ? l : null;
}

function nodesOf(wf) {
  return Array.isArray(wf?.nodes) ? wf.nodes : [];
}

function linksOf(wf) {
  return (Array.isArray(wf?.links) ? wf.links : []).map(linkOf).filter(Boolean);
}

// What the template's reference plumbing looks like:
//   consumerId        the node the references feed (null when none)
//   loadImages        [{ nodeId, address, slot }] feeding it, in input order
//   spareInputs       [{ slot, name }] unwired IMAGE inputs on the consumer
//   outputNodeId      the SaveImage-type node downstream of the consumer
//   maxReferenceImages loadImages + spareInputs
export function analyzeImageWorkflow(wf) {
  const nodes = nodesOf(wf).filter(isLive);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links = linksOf(wf);
  const loads = nodes.filter((n) => n.type === 'LoadImage');
  const loadIds = new Set(loads.map((n) => n.id));

  // consumer candidates: nodes an IMAGE link from a LoadImage lands on.
  const feeds = new Map(); // consumer id → [{ nodeId, slot }]
  for (const l of links) {
    if (!loadIds.has(l.origin_id) || l.origin_slot !== 0) continue;
    const target = byId.get(l.target_id);
    if (!target || PREVIEW_RE.test(String(target.type)) || SAVE_RE.test(String(target.type))) continue;
    if (!feeds.has(target.id)) feeds.set(target.id, []);
    feeds.get(target.id).push({ nodeId: l.origin_id, slot: l.target_slot });
  }
  const imageInputCount = (n) => (n.inputs || []).filter((i) => i?.type === 'IMAGE').length;
  let consumer = null;
  for (const [id, list] of feeds) {
    const node = byId.get(id);
    const distinct = new Set(list.map((f) => f.nodeId)).size;
    const rank = [distinct, imageInputCount(node), -Number(id)];
    if (!consumer || rank[0] > consumer.rank[0] || (rank[0] === consumer.rank[0] && (rank[1] > consumer.rank[1] || (rank[1] === consumer.rank[1] && rank[2] > consumer.rank[2])))) {
      consumer = { node, list, rank };
    }
  }
  if (!consumer) {
    const save = nodes.find((n) => SAVE_RE.test(String(n.type)));
    return { consumerId: null, loadImages: [], spareInputs: [], outputNodeId: save?.id ?? null, maxReferenceImages: 0 };
  }

  const seen = new Set();
  const loadImages = consumer.list
    .slice()
    .sort((a, b) => a.slot - b.slot)
    .filter((f) => (seen.has(f.nodeId) ? false : seen.add(f.nodeId)))
    .map((f) => ({ nodeId: f.nodeId, address: `${f.nodeId}.image`, slot: f.slot }));
  const spareInputs = (consumer.node.inputs || [])
    .map((input, slot) => ({ input, slot }))
    .filter(({ input }) => input?.type === 'IMAGE' && (input.link === null || input.link === undefined))
    .map(({ input, slot }) => ({ slot, name: String(input.label || input.name || `image_${slot}`) }));

  // The save node we read: breadth-first downstream of the consumer.
  let outputNodeId = null;
  const queue = [consumer.node.id];
  const visited = new Set(queue);
  while (queue.length && outputNodeId === null) {
    const id = queue.shift();
    for (const l of links) {
      if (l.origin_id !== id || visited.has(l.target_id)) continue;
      const t = byId.get(l.target_id);
      if (!t) continue;
      if (SAVE_RE.test(String(t.type))) {
        outputNodeId = t.id;
        break;
      }
      visited.add(t.id);
      queue.push(t.id);
    }
  }
  if (outputNodeId === null) outputNodeId = nodes.find((n) => SAVE_RE.test(String(n.type)))?.id ?? null;

  return {
    consumerId: consumer.node.id,
    loadImages,
    spareInputs,
    outputNodeId,
    maxReferenceImages: loadImages.length + spareInputs.length,
  };
}

function removeNode(wf, nodeId) {
  const byId = new Map(nodesOf(wf).map((n) => [n.id, n]));
  const dead = new Set();
  for (const raw of wf.links || []) {
    const l = linkOf(raw);
    if (!l || (l.origin_id !== nodeId && l.target_id !== nodeId)) continue;
    dead.add(l.id);
    const target = byId.get(l.target_id);
    const input = target?.inputs?.[l.target_slot];
    if (input && input.link === l.id) input.link = null;
    const out = byId.get(l.origin_id)?.outputs?.[l.origin_slot];
    if (out && Array.isArray(out.links)) out.links = out.links.filter((x) => x !== l.id);
  }
  wf.links = (wf.links || []).filter((raw) => !dead.has(linkOf(raw)?.id));
  wf.nodes = nodesOf(wf).filter((n) => n.id !== nodeId);
}

function maxId(values, fallback) {
  let m = Number.isFinite(Number(fallback)) ? Number(fallback) : 0;
  for (const v of values) if (Number.isFinite(Number(v)) && Number(v) > m) m = Number(v);
  return m;
}

// Reshape a copy of the template for `count` reference images. Returns
// { workflow, addresses, outputNodeId } — `addresses[i]` is the LoadImage slot
// for reference i (set the uploaded filename there). Throws when the template
// cannot take that many.
export function prepareImageWorkflow(template, count) {
  const wf = JSON.parse(JSON.stringify(template));
  const plan = analyzeImageWorkflow(wf);
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n > plan.maxReferenceImages) {
    throw new Error(`this template takes at most ${plan.maxReferenceImages} reference image(s), got ${n}`);
  }
  const keep = plan.loadImages.slice(0, n);
  for (const extra of plan.loadImages.slice(n)) removeNode(wf, extra.nodeId);

  const addresses = keep.map((l) => l.address);
  const consumer = nodesOf(wf).find((x) => x.id === plan.consumerId);
  const objectLinks = (wf.links || []).some((l) => l && !Array.isArray(l));
  let nextNode = maxId(nodesOf(wf).map((x) => x.id), wf.last_node_id);
  let nextLink = maxId((wf.links || []).map((l) => linkOf(l)?.id), wf.last_link_id);
  const anchor = nodesOf(wf).find((x) => x.id === keep[keep.length - 1]?.nodeId) || consumer;
  const [ax, ay] = Array.isArray(anchor?.pos) ? anchor.pos : [0, 0];
  const spares = plan.spareInputs.slice(0, Math.max(0, n - keep.length));
  spares.forEach((spare, i) => {
    const nodeId = ++nextNode;
    const linkId = ++nextLink;
    wf.nodes.push({
      id: nodeId,
      type: 'LoadImage',
      pos: [ax, ay + 160 * (i + 1)],
      size: [290, 110],
      flags: {},
      order: 0,
      mode: 0,
      inputs: [],
      outputs: [
        { name: 'IMAGE', type: 'IMAGE', links: [linkId] },
        { name: 'MASK', type: 'MASK', links: null },
      ],
      properties: { 'Node name for S&R': 'LoadImage' },
      widgets_values: ['', 'image'],
    });
    wf.links.push(
      objectLinks
        ? { id: linkId, origin_id: nodeId, origin_slot: 0, target_id: consumer.id, target_slot: spare.slot, type: 'IMAGE' }
        : [linkId, nodeId, 0, consumer.id, spare.slot, 'IMAGE'],
    );
    consumer.inputs[spare.slot].link = linkId;
    addresses.push(`${nodeId}.image`);
  });
  wf.last_node_id = nextNode;
  wf.last_link_id = nextLink;

  for (const node of nodesOf(wf)) {
    if ((node.id === plan.consumerId || node.id === plan.outputNodeId) && node.mode === 4) node.mode = 0;
  }

  // One output: previews and any second pipeline's save node would run (and
  // a preview of a removed LoadImage would fail validation).
  for (const node of nodesOf(wf).slice()) {
    const type = String(node.type);
    if (PREVIEW_RE.test(type) || (SAVE_RE.test(type) && node.id !== plan.outputNodeId)) removeNode(wf, node.id);
  }
  return { workflow: wf, addresses, outputNodeId: plan.outputNodeId };
}
