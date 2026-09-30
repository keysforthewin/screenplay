// ComfyUI still images: the graph reshaping that gives a template as many
// LoadImage nodes as a render has references, the auto-mapper the gallery
// scan uses, and the runner (upload → slots → run → poll → fetch) behind
// image model ids `comfy:<id>`. comfy-mcp is faked; fixtures are real
// templates fetched from the gallery.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.COMFYUI_URL = '';
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-image-test-'));
process.env.COMFY_WORK_DIR = WORK_DIR;
process.env.COMFY_TEMPLATE_DIR = path.join(WORK_DIR, 'templates');

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import express from 'express';

vi.mock('../src/log.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'comfy');
const QWEN = 'image_qwen_image_2_1_image_edit';
const KLEIN = 'image_flux2_klein_image_edit_9b_distilled';
const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));

vi.mock('../src/comfy/templates.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    ensureTemplateFile: vi.fn(async (model) => ({ path: path.join(FIXTURES, `${model.template}.json`), local_check: { checked: true, runnable: true } })),
  };
});

const { analyzeImageWorkflow, prepareImageWorkflow } = await import('../src/comfy/imageWorkflow.js');
const Models = await import('../src/comfy/imageModels.js');
const Client = await import('../src/comfy/client.js');
const Video = await import('../src/web/comfyVideoGenerate.js');
const Gen = await import('../src/web/comfyImageGenerate.js');
const { dispatchStillImage } = await import('../src/web/stillImageDispatch.js');
const { maxReferenceImagesFor } = await import('../src/web/imageModelInfo.js');

function fakeClient({ status = 'completed', outputName = null } = {}) {
  const calls = [];
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'upload_file') return { uploads: args.paths.map((p) => ({ local_path: p, cloud_name: path.basename(p) })) };
      if (name === 'set_workflow_slot') return { ok: true };
      if (name === 'run_workflow') return { prompt_id: 'p-1' };
      if (name === 'job') return args.action === 'status' ? { status } : { exception_message: 'CUDA out of memory' };
      if (name === 'fetch_outputs') {
        const prefix = calls.find((c) => c.name === 'set_workflow_slot').args.overrides.find((o) => o.address === '461.filename_prefix').value;
        await fsp.mkdir(path.join(args.out_dir, 'screenplay'), { recursive: true });
        await fsp.writeFile(path.join(args.out_dir, 'screenplay', outputName || `${path.basename(prefix)}_00001_.png`), Buffer.from('rendered-png'));
        return { ok: true };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };
}

beforeEach(() => {
  Video._resetComfyJobsForTests();
  Video._setComfyRunnerOptionsForTests({ pollIntervalMs: 2, jobTimeoutMs: 5000 });
  Client._setComfyClientForTests(null);
  Models._setComfyImageCatalogForTests({
    scanned_at: '2026-09-30T00:00:00.000Z',
    models: [{ id: 'qwen-image-2-1-image-edit', template: QWEN, label: 'auto', maxReferenceImages: 10, params: {}, output: {} }],
  });
});

afterAll(async () => {
  await fsp.rm(WORK_DIR, { recursive: true, force: true });
});

describe('analyzeImageWorkflow', () => {
  it('finds the wired LoadImages in input order and the spare IMAGE inputs', () => {
    const plan = analyzeImageWorkflow(readFixture(QWEN));
    expect(plan.consumerId).toBe(459);
    expect(plan.loadImages.map((l) => l.address)).toEqual(['470.image', '475.image']);
    expect(plan.spareInputs).toHaveLength(8);
    expect(plan.maxReferenceImages).toBe(10);
    expect(plan.outputNodeId).toBe(461);
  });

  it('picks the pipeline with the most reference inputs in a two-pipeline template', () => {
    const plan = analyzeImageWorkflow(readFixture(KLEIN));
    expect(plan.consumerId).toBe(92);
    expect(plan.loadImages.map((l) => l.nodeId)).toEqual([76, 121]);
    expect(plan.outputNodeId).toBe(122);
  });
});

describe('prepareImageWorkflow', () => {
  const loadNodes = (wf) => wf.nodes.filter((n) => n.type === 'LoadImage');

  it('adds LoadImage nodes on the spare inputs for extra references', () => {
    const template = readFixture(QWEN);
    const { workflow, addresses } = prepareImageWorkflow(template, 4);
    expect(addresses).toHaveLength(4);
    expect(addresses.slice(0, 2)).toEqual(['470.image', '475.image']);
    expect(loadNodes(workflow)).toHaveLength(4);
    const consumer = workflow.nodes.find((n) => n.id === 459);
    const wired = consumer.inputs.filter((i) => i.type === 'IMAGE' && i.link != null);
    expect(wired.map((i) => i.label)).toEqual(['image_1', 'image_2', 'image_3', 'image_4']);
    // every new link exists, lands on the consumer, and ids did not collide
    const ids = workflow.links.map((l) => l[0]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const input of wired) expect(workflow.links.some((l) => l[0] === input.link && l[3] === 459)).toBe(true);
    expect(workflow.last_node_id).toBeGreaterThan(template.last_node_id);
    // the template itself is untouched
    expect(loadNodes(template)).toHaveLength(2);
  });

  it('removes unused stock LoadImages and the preview that read them', () => {
    const { workflow, addresses } = prepareImageWorkflow(readFixture(QWEN), 1);
    expect(addresses).toEqual(['470.image']);
    expect(loadNodes(workflow).map((n) => n.id)).toEqual([470]);
    expect(workflow.nodes.some((n) => n.type === 'ImageCompare')).toBe(false);
    const consumer = workflow.nodes.find((n) => n.id === 459);
    expect(consumer.inputs.find((i) => i.label === 'image_2').link).toBeNull();
    const nodeIds = new Set(workflow.nodes.map((n) => n.id));
    for (const l of workflow.links) expect(nodeIds.has(l[1]) && nodeIds.has(l[3])).toBe(true);
  });

  it('keeps only the output of the chosen pipeline', () => {
    const { workflow, outputNodeId } = prepareImageWorkflow(readFixture(KLEIN), 2);
    expect(workflow.nodes.filter((n) => /^SaveImage/.test(n.type)).map((n) => n.id)).toEqual([outputNodeId]);
    // the template ships this pipeline bypassed
    expect(workflow.nodes.filter((n) => [92, 122].includes(n.id)).map((n) => n.mode)).toEqual([0, 0]);
  });

  it('refuses more references than the template has inputs', () => {
    expect(() => prepareImageWorkflow(readFixture(QWEN), 11)).toThrow(/at most 10/);
  });
});

describe('autoMapImageTemplate', () => {
  const slots = [
    { address: '459.prompt', name: 'prompt', type: 'STRING', current_value: 'Replace costumes', instance_id: '459' },
    { address: '459.negative_prompt', name: 'negative_prompt', type: 'STRING', current_value: '', instance_id: '459' },
    { address: '459.width', name: 'width', type: 'INT', current_value: 1024, instance_id: '459' },
    { address: '459.height', name: 'height', type: 'INT', current_value: 1024, instance_id: '459' },
    { address: '459.steps', name: 'steps', type: 'INT', current_value: 25, instance_id: '459' },
    { address: '459.cfg', name: 'cfg', type: 'FLOAT', current_value: 1, instance_id: '459' },
    { address: '459.seed', name: 'seed', type: 'INT', current_value: 5, instance_id: '459' },
    { address: '461.filename_prefix', name: 'filename_prefix', type: 'STRING', current_value: 'Qwen', instance_id: '461' },
    { address: '470.image', name: 'image', type: 'COMBO', current_value: 'a.png', instance_id: '470', node_type: 'LoadImage' },
  ];

  it('maps prompt, canvas, sampler params, the save prefix and the reference cap', () => {
    const entry = Models.autoMapImageTemplate({ name: QWEN, info: { title: 'Qwen Image 2.1: Image Edit' }, slots, workflow: readFixture(QWEN) });
    expect(entry.id).toBe('qwen-image-2-1-image-edit');
    expect(entry.maxReferenceImages).toBe(10);
    expect(entry.params.prompt.address).toBe('459.prompt');
    expect(entry.params.negative_prompt.address).toBe('459.negative_prompt');
    expect(entry.params.width.address).toBe('459.width');
    expect(entry.params.seed.address).toBe('459.seed');
    expect(entry.output.filenamePrefix).toBe('461.filename_prefix');
    expect(entry.verified).toBe(false);
  });

  it('returns null without a prompt slot', () => {
    expect(Models.autoMapImageTemplate({ name: QWEN, slots: slots.filter((s) => s.type !== 'STRING' || s.name === 'filename_prefix'), workflow: readFixture(QWEN) })).toBeNull();
  });
});

describe('registry', () => {
  it('lists the curated entry over a discovered mapping of the same template, marked installed', () => {
    const cat = Models.comfyImageCatalog();
    expect(cat.models.map((m) => m.id)).toEqual(['comfy:qwen-image-2.1-edit']);
    expect(cat.models[0]).toMatchObject({ installed: true, verified: true, max_reference_images: 10, size_follows_reference: false });
    expect(cat.models[0].params.width).toBeDefined();
    expect(cat.models[0].params.prompt).toBeUndefined();
  });

  it('feeds the reference cap for comfy model ids', () => {
    expect(maxReferenceImagesFor('comfy:qwen-image-2.1-edit')).toBe(10);
    expect(maxReferenceImagesFor('comfy:nope')).toBe(1);
  });
});

describe('composeComfyStillPrompt', () => {
  const model = Models.CURATED_COMFY_IMAGE_MODELS[0];
  it('binds the references by position with the model token, their labels and roles', () => {
    const out = Gen.composeComfyStillPrompt(model, 'Wide shot of the counter.', {
      refs: [{ label: 'Sarah', role: 'identity' }, { label: 'the set "Diner"', role: 'look' }],
    });
    expect(out).toContain('This is not an edit of any input image');
    expect(out).toContain('<image1> is Sarah: take only the face, hair, build and wardrobe from it.');
    expect(out).toContain('<image2> shows the set "Diner" from a different camera');
    expect(out).toContain('Do not reuse its framing, viewpoint or composition.');
    expect(out.endsWith('Wide shot of the counter.')).toBe(true);
  });
  it('treats a reference without a role as a look reference', () => {
    const out = Gen.composeComfyStillPrompt(model, 'Wide.', { refs: [{ label: 'Subject 1' }] });
    expect(out).toContain('<image1> shows Subject 1 from a different camera');
  });
  it('passes an edit instruction through untouched', () => {
    expect(Gen.composeComfyStillPrompt(model, 'Remove the lamp.', { mode: 'edit', refs: [{ label: 'x' }] })).toBe('Remove the lamp.');
  });
});

describe('generateComfyStillImage', () => {
  const refs = (n) => Array.from({ length: n }, (_, i) => ({ buffer: Buffer.from(`ref-${i}`), contentType: i ? 'image/jpeg' : 'image/png', label: `Subject ${i + 1}` }));

  it('uploads every reference, sets the slots on a reshaped workflow and returns the saved image', async () => {
    const client = fakeClient();
    Client._setComfyClientForTests(client);
    const result = await dispatchStillImage({
      prompt: 'Wide shot of the counter.',
      model: 'comfy:qwen-image-2.1-edit',
      inputImages: refs(3),
      comfyParams: { width: 1344, height: 768, steps: 12, seed: 7, bogus: 1 },
    });
    expect(result).toMatchObject({ contentType: 'image/png', model: `comfy/${QWEN}` });
    expect(result.buffer.toString()).toBe('rendered-png');

    const upload = client.calls.find((c) => c.name === 'upload_file');
    expect(upload.args.paths.map((p) => path.extname(p))).toEqual(['.png', '.jpg', '.jpg']);
    const set = client.calls.find((c) => c.name === 'set_workflow_slot');
    const by = Object.fromEntries(set.args.overrides.map((o) => [o.address, o.value]));
    expect(by['459.switch']).toBe(true); // custom canvas on
    expect(by['459.width']).toBe(1344);
    expect(by['459.height']).toBe(768);
    expect(by['459.steps']).toBe(12);
    expect(by['459.seed']).toBe(7);
    expect(by['459.switch_1']).toBe(false); // prompt enhancer pinned off
    expect(by['459.prompt']).toContain('<image3> shows Subject 3 from a different camera');
    expect(by['470.image']).toBe(path.basename(upload.args.paths[0]));
    expect(by['475.image']).toBe(path.basename(upload.args.paths[1]));
    const added = set.args.overrides.filter((o) => /^\d+\.image$/.test(o.address) && !['470.image', '475.image'].includes(o.address));
    expect(added).toHaveLength(1);
    expect(added[0].value).toBe(path.basename(upload.args.paths[2]));
    expect(client.calls.find((c) => c.name === 'run_workflow').args.wait).toBe(false);
    // scratch is gone
    expect((await fsp.readdir(WORK_DIR)).filter((n) => n.startsWith('still-'))).toEqual([]);
  });

  it('edit mode follows the frame being edited: no custom canvas, no size slots', async () => {
    const client = fakeClient();
    Client._setComfyClientForTests(client);
    await dispatchStillImage({ prompt: 'Remove the lamp.', model: 'comfy:qwen-image-2.1-edit', inputImages: refs(1), mode: 'edit' });
    const by = Object.fromEntries(client.calls.find((c) => c.name === 'set_workflow_slot').args.overrides.map((o) => [o.address, o.value]));
    expect(by['459.switch']).toBe(false);
    expect(by['459.width']).toBeUndefined();
    expect(by['459.prompt']).toBe('Remove the lamp.');
    expect(by['475.image']).toBeUndefined();
  });

  it('caps the references at what the model takes', async () => {
    const client = fakeClient();
    Client._setComfyClientForTests(client);
    await Gen.generateComfyStillImage({ model: 'comfy:qwen-image-2.1-edit', prompt: 'x', inputImages: refs(12) });
    expect(client.calls.find((c) => c.name === 'upload_file').args.paths).toHaveLength(10);
  });

  it('rejects a render without references and an unknown model with 400', async () => {
    Client._setComfyClientForTests(fakeClient());
    await expect(Gen.generateComfyStillImage({ model: 'comfy:qwen-image-2.1-edit', prompt: 'x', inputImages: [] })).rejects.toMatchObject({ status: 400 });
    await expect(Gen.generateComfyStillImage({ model: 'comfy:nope', prompt: 'x', inputImages: refs(1) })).rejects.toMatchObject({ status: 400 });
  });

  it("surfaces ComfyUI's own error when the job fails", async () => {
    Client._setComfyClientForTests(fakeClient({ status: 'error' }));
    await expect(Gen.generateComfyStillImage({ model: 'comfy:qwen-image-2.1-edit', prompt: 'x', inputImages: refs(1) })).rejects.toThrow(/CUDA out of memory/);
  });

  it('answers 503 when ComfyUI is not configured', async () => {
    await expect(Gen.generateComfyStillImage({ model: 'comfy:qwen-image-2.1-edit', prompt: 'x', inputImages: refs(1) })).rejects.toMatchObject({ status: 503 });
  });
});

describe('gallery scan + routes', () => {
  async function request(app, method, url) {
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method });
      return { status: res.status, body: await res.json() };
    } finally {
      server.close();
    }
  }

  it('keeps runnable reference-taking templates, lists the uninstalled ones with a reason, and serves the catalog', async () => {
    await fsp.mkdir(process.env.COMFY_TEMPLATE_DIR, { recursive: true });
    const io = { inputs: [{ nodeType: 'LoadImage' }, { nodeType: 'LoadImage' }] };
    const slots = [
      { address: '459.prompt', name: 'prompt', type: 'STRING', current_value: 'x', instance_id: '459' },
      { address: '461.filename_prefix', name: 'filename_prefix', type: 'STRING', current_value: 'Q', instance_id: '461' },
    ];
    Client._setComfyClientForTests({
      async callTool(name, args) {
        if (name === 'search_templates') {
          return {
            rows: [
              { name: QWEN, title: 'Qwen 2.1', tags: ['Image Edit'], category_title: 'Image' },
              { name: KLEIN, title: 'Klein', tags: ['Image', 'Image Edit'], category_title: 'Image' },
              { name: 't2i_only', title: 'T2I', tags: ['Text to Image'], category_title: 'Image' },
              { name: 'utility_upscale', title: 'Upscale', tags: ['Image Upscale'], category_title: 'Image Tools' },
            ],
          };
        }
        if (name === 'get_template') {
          if (args.name === QWEN) return { template: { title: 'Qwen 2.1', io }, local_check: { checked: true, runnable: true } };
          if (args.name === KLEIN) {
            return { template: { title: 'Klein', io }, local_check: { checked: true, runnable: false, error_count: 3, errors: ["node 75/70: 'flux-2-klein-9b-fp8.safetensors' not in 18 known options for unet_name — closest: x (this install has: a, b)"] } };
          }
          if (args.name === 't2i_only') return { template: { title: 'T2I', io: { inputs: [] } }, local_check: { checked: true, runnable: true } };
          throw new Error(`should not inspect ${args.name}`);
        }
        if (name === 'fetch_template') {
          await fsp.copyFile(path.join(FIXTURES, `${args.name}.json`), args.out_path);
          return { path: args.out_path, local_check: { checked: true, runnable: true } };
        }
        if (name === 'list_workflow_slots') return { slots };
        throw new Error(`unexpected tool ${name}`);
      },
    });
    Models._setComfyImageCatalogForTests({});
    await Models._runComfyImageScanForTests();

    const { buildComfyRouter } = await import('../src/web/comfyRoutes.js');
    const app = express();
    app.use('/comfy', buildComfyRouter());
    const { status, body } = await request(app, 'GET', '/comfy/image-models');
    expect(status).toBe(200);
    expect(body.configured).toBe(true);
    expect(body.scanned_at).toBeTruthy();
    expect(body.models.map((m) => m.id)).toEqual(['comfy:qwen-image-2.1-edit']);
    expect(body.unavailable).toEqual([
      expect.objectContaining({ template: KLEIN, reason: 'Model file not installed: flux-2-klein-9b-fp8.safetensors (+2 more)' }),
    ]);
    expect(body.scan.running).toBe(false);
    // the scan cache landed next to the template dir
    expect(fs.existsSync(path.join(WORK_DIR, 'image-models.json'))).toBe(true);
  });

  it('reports unconfigured without scanning', async () => {
    const { buildComfyRouter } = await import('../src/web/comfyRoutes.js');
    const app = express();
    app.use('/comfy', buildComfyRouter());
    const get = await request(app, 'GET', '/comfy/image-models');
    expect(get.body).toMatchObject({ configured: false, models: [] });
    const post = await request(app, 'POST', '/comfy/image-models/scan');
    expect(post.status).toBe(503);
  });
});
