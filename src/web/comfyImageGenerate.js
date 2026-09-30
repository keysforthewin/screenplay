// Still images through ComfyUI (comfy-mcp) — the local-GPU provider behind
// image model ids `comfy:<id>` (src/comfy/imageModels.js). Reached only via
// dispatchStillImage, so it has the same contract as the fal/OpenAI branches:
// prompt + reference buffers in, { buffer, contentType, model } out.
//
// Per render: reshape a copy of the template for the references at hand
// (imageWorkflow.js), upload them into ComfyUI's input directory, set the
// slots, run_workflow(wait=false), poll, fetch the saved image. Runs on the
// same one-at-a-time GPU queue as the video renders.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../log.js';
import { comfy, isComfyConfigured, ComfyNotConfiguredError } from '../comfy/client.js';
import { getComfyImageModel } from '../comfy/imageModels.js';
import { prepareImageWorkflow } from '../comfy/imageWorkflow.js';
import { validateComfyParams, randomSeed } from '../comfy/paramMap.js';
import { ensureTemplateFile } from '../comfy/templates.js';
import { enqueue, uploadedNameFor, promptIdFrom, waitForComfyPrompt } from './comfyVideoGenerate.js';
import { composeStartFramePrompt } from './startFramePrompt.js';

const IMAGE_EXTENSIONS = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);

function inputError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function extensionFor(contentType) {
  if (contentType === 'image/jpeg') return 'jpg';
  if (contentType === 'image/webp') return 'webp';
  return 'png';
}

// What the model is told about its references: the shared start-frame
// binding (startFramePrompt.js) written with this model's reference token.
// refs: [{ label, role }] in upload order; a ref without a role is a look
// reference. Edit mode passes the instruction through.
export function composeComfyStillPrompt(model, prompt, { mode = 'generate', refs = [] } = {}) {
  const text = String(prompt || '').trim();
  if (mode === 'edit' || !refs.length) return text;
  return composeStartFramePrompt(
    text,
    refs.map((r) => ({ label: r?.label || '', role: r?.role || 'look' })),
    { token: model?.referenceToken || 'image {n}' },
  );
}

// Slot overrides for one render, last write wins: mode pins, then params,
// the reference filenames and the output prefix.
export function buildImageOverrides(model, { mode, params, addresses, filenames, filenamePrefix }) {
  const drop = new Set(model?.modes?.[mode]?.drop || []);
  const byAddress = new Map();
  for (const f of model?.modes?.[mode]?.fixed || []) byAddress.set(f.address, f.value);
  for (const [key, spec] of Object.entries(model?.params || {})) {
    if (drop.has(key) || !spec?.address) continue;
    const value = params[key];
    if (value === null || value === undefined) continue;
    byAddress.set(spec.address, value);
  }
  addresses.forEach((address, i) => byAddress.set(address, filenames[i]));
  if (model?.output?.filenamePrefix) byAddress.set(model.output.filenamePrefix, filenamePrefix);
  return Array.from(byAddress, ([address, value]) => ({ address, value }));
}

async function findImages(dir) {
  const out = [];
  async function walk(d) {
    const entries = await fsp.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (IMAGE_EXTENSIONS.has(path.extname(e.name).toLowerCase())) {
        const st = await fsp.stat(p).catch(() => null);
        if (st) out.push({ path: p, name: e.name, mtime: st.mtimeMs });
      }
    }
  }
  await walk(dir);
  return out.sort((a, b) => b.mtime - a.mtime);
}

// inputImages: [{ buffer, contentType, label?, role? }] — references in order
// (edit mode: the frame being edited first). `params` are the model's
// canonical params (width, height, steps, cfg, seed, …); unknown keys are
// ignored. Throws 400 for bad input, 503 when ComfyUI is not configured.
export async function generateComfyStillImage({ model: modelId, prompt, inputImages = [], mode = 'generate', params = {} }) {
  if (!isComfyConfigured()) throw new ComfyNotConfiguredError();
  const model = getComfyImageModel(modelId);
  if (!model) throw inputError(`Unknown ComfyUI image model "${modelId}" — rescan the ComfyUI image models.`);
  const refs = (Array.isArray(inputImages) ? inputImages : []).filter((r) => r?.buffer).slice(0, model.maxReferenceImages || 1);
  if (!refs.length) {
    throw inputError(`${model.label} composes from reference images — add at least one reference artwork to this cut.`);
  }
  const validated = validateComfyParams(model, { ...(params && typeof params === 'object' ? params : {}), prompt: undefined });
  if (validated.errors.length) throw inputError(`Invalid parameters: ${validated.errors.join('; ')}`);
  if (validated.params.seed == null && model.params?.seed) validated.params.seed = randomSeed();
  validated.params.prompt = composeComfyStillPrompt(model, prompt, { mode, refs });
  if (!validated.params.prompt) throw inputError('A prompt is required.');

  return enqueue(async () => {
    const jobId = new ObjectId().toString();
    const jobDir = path.join(config.comfy.workDir, `still-${jobId}`);
    const outDir = path.join(jobDir, 'out');
    try {
      await fsp.mkdir(outDir, { recursive: true });
      const tpl = await ensureTemplateFile(model);
      const template = JSON.parse(await fsp.readFile(tpl.path, 'utf8'));
      const prepared = prepareImageWorkflow(template, refs.length);
      const workflowPath = path.join(jobDir, 'workflow.json');
      await fsp.writeFile(workflowPath, JSON.stringify(prepared.workflow));

      const files = [];
      for (let i = 0; i < refs.length; i++) {
        const abs = path.join(jobDir, `still-${jobId}-ref-${i + 1}.${extensionFor(refs[i].contentType)}`);
        await fsp.writeFile(abs, refs[i].buffer);
        files.push(abs);
      }
      const uploaded = await comfy.uploadFile(files, { overwrite: true });
      const filenames = files.map((abs) => uploadedNameFor(uploaded, abs));

      const prefix = `screenplay/still-${jobId}`;
      const overrides = buildImageOverrides(model, {
        mode: mode === 'edit' ? 'edit' : 'generate',
        params: validated.params,
        addresses: prepared.addresses,
        filenames,
        filenamePrefix: prefix,
      });
      await comfy.setWorkflowSlot(workflowPath, overrides, { stdout: false });

      const submitted = await comfy.runWorkflow(workflowPath, { wait: false });
      const promptId = promptIdFrom(submitted);
      if (!promptId) throw new Error(`ComfyUI returned no prompt id: ${JSON.stringify(submitted).slice(0, 500)}`);
      await waitForComfyPrompt(promptId);

      await comfy.fetchOutputs(promptId, outDir);
      const images = await findImages(outDir);
      const picked = images.find((f) => f.name.startsWith(`still-${jobId}`)) || images[0];
      if (!picked) throw new Error('ComfyUI finished but no image was found among the outputs.');
      const buffer = await fsp.readFile(picked.path);
      logger.info(`comfy still ${jobId} done model=${model.id} refs=${refs.length} mode=${mode} prompt_id=${promptId}`);
      return {
        buffer,
        contentType: IMAGE_EXTENSIONS.get(path.extname(picked.name).toLowerCase()) || 'image/png',
        model: `comfy/${model.template}`,
      };
    } finally {
      await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    }
  });
}
