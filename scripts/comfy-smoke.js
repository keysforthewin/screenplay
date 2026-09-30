#!/usr/bin/env node
// Manual live check of the ComfyUI provider. Not part of the test suite.
//
//   COMFYUI_URL=http://127.0.0.1:8188 node scripts/comfy-smoke.js [model-id] [--audio <file.mp3>]
//
// Spawns comfy-mcp, prints server_info, ensures the model's template is
// fetched and runnable, renders a ~3 s low-res clip from a generated PNG (a
// lip-sync model such as ltx-2.3-ia2v also needs --audio, the recording it
// syncs to; the clip runs its length), and prints where the output landed.
// No Mongo involved.

import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { config } from '../src/config.js';
import { comfy, isComfyConfigured, closeComfyClient } from '../src/comfy/client.js';
import { getComfyVideoModel } from '../src/comfy/videoModels.js';
import { ensureTemplateFile } from '../src/comfy/templates.js';
import { validateComfyParams, buildSlotOverrides } from '../src/comfy/paramMap.js';

async function main() {
  if (!isComfyConfigured()) {
    console.error('COMFYUI_URL is not set — nothing to smoke.');
    process.exit(2);
  }
  const argv = process.argv.slice(2);
  const audioIdx = argv.indexOf('--audio');
  const audioPath = audioIdx >= 0 ? argv[audioIdx + 1] : null;
  const positional = argv.filter((a, i) => a !== '--audio' && (audioIdx < 0 || i !== audioIdx + 1));
  const modelId = positional[0] || 'ltx-2.5-i2v';
  const model = getComfyVideoModel(modelId);
  if (!model) {
    console.error(`unknown model ${modelId}`);
    process.exit(2);
  }
  if (model.spends_credits) {
    console.error(`${modelId} spends credits; the smoke test only runs local models.`);
    process.exit(2);
  }

  console.log('server_info…');
  const info = await comfy.serverInfo();
  console.log(JSON.stringify({ server: info?.server, gpu: info?.hardware?.gpu, target: info?.comfy_target }, null, 2));

  console.log(`ensuring template ${model.template}…`);
  const tpl = await ensureTemplateFile(model);
  console.log('template', tpl.path, 'local_check', JSON.stringify(tpl.local_check));

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'comfy-smoke-'));
  const png = path.join(dir, 'smoke-start.png');
  await sharp({
    create: { width: 640, height: 352, channels: 3, background: { r: 180, g: 40, b: 40 } },
  })
    .png()
    .toFile(png);

  // First-last-frame models also get an end still: a blue square, so the
  // clip visibly travels from one to the other.
  const usesEnd = model.inputs?.endFrame && model.inputs.endFrame !== 'unused';
  const endPng = usesEnd ? path.join(dir, 'smoke-end.png') : null;
  if (endPng) {
    await sharp({ create: { width: 640, height: 352, channels: 3, background: { r: 40, g: 60, b: 190 } } }).png().toFile(endPng);
  }

  const needsAudio = model.inputs?.audio === 'required';
  if (needsAudio && !audioPath) {
    console.error(`${modelId} lip-syncs to a recording — pass --audio <file.mp3>.`);
    process.exit(2);
  }
  const uploads = endPng ? [png, endPng] : [png];
  let audioAbs = null;
  if (audioPath) {
    audioAbs = path.resolve(audioPath);
    await fsp.access(audioAbs);
    uploads.push(audioAbs);
  }
  console.log(`uploading start frame${endPng ? ' + end frame' : ''}${audioAbs ? ' + audio' : ''}…`);
  const up = await comfy.uploadFile(uploads, { overwrite: true });
  console.log('upload', JSON.stringify(up).slice(0, 400));

  const low = {
    prompt: 'A red square on a dark ground. The camera holds. A slow, even push in toward the square. End with the square filling most of the frame.',
    duration_seconds: 3,
    megapixels: 0.2,
    width: 512,
    height: 288,
    fps: model.params.fps?.default ?? 24,
    // The FLF template's full-step path is slow; a smoke only proves the wiring.
    ...(usesEnd && model.params.steps ? { steps: 6 } : {}),
  };
  const { params, warnings, errors } = validateComfyParams(model, low);
  if (errors.length) throw new Error(errors.join('; '));
  for (const w of warnings) console.log('warning:', w);
  const { overrides } = buildSlotOverrides(model, {
    params,
    imageFilenames: { start_frame: path.basename(png), end_frame: endPng ? path.basename(endPng) : null, reference: [], audio: audioAbs ? path.basename(audioAbs) : null },
    filenamePrefix: 'video/screenplay/smoke',
  });
  const wf = path.join(dir, 'workflow.json');
  await fsp.copyFile(tpl.path, wf);
  console.log('setting slots…', overrides.map((o) => o.address).join(', '));
  await comfy.setWorkflowSlot(wf, overrides, { stdout: false });

  console.log('submitting…');
  const submitted = await comfy.runWorkflow(wf, { wait: false });
  const promptId = submitted?.prompt_id || submitted?.id;
  console.log('prompt_id', promptId, JSON.stringify(submitted).slice(0, 300));
  if (!promptId) throw new Error('no prompt id');

  const started = Date.now();
  for (;;) {
    const st = await comfy.job('status', promptId);
    const status = String(st?.status || '').toLowerCase();
    process.stdout.write(`\r${Math.round((Date.now() - started) / 1000)}s ${status || 'pending'}   `);
    if (['completed', 'complete', 'success', 'succeeded', 'done'].includes(status)) break;
    if (['error', 'failed', 'failure', 'cancelled', 'canceled'].includes(status)) {
      const err = await comfy.job('error', promptId).catch(() => null);
      throw new Error(`job ${status}: ${JSON.stringify(err).slice(0, 800)}`);
    }
    await new Promise((r) => setTimeout(r, config.comfy.pollIntervalMs));
  }
  console.log('\nfetching outputs…');
  const out = path.join(dir, 'out');
  const fetched = await comfy.fetchOutputs(promptId, out);
  console.log(JSON.stringify(fetched).slice(0, 600));
  const files = await fsp.readdir(out, { recursive: true }).catch(() => []);
  console.log('files:', files.map((f) => path.join(out, f)).join('\n'));
}

main()
  .catch((e) => {
    console.error('\nsmoke failed:', e?.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeComfyClient();
  });
