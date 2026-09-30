#!/usr/bin/env node
// Manual live check of the ComfyUI STILL-IMAGE provider. Not part of the suite.
//
//   COMFYUI_URL=http://127.0.0.1:8188 node scripts/comfy-image-smoke.js [model-id] [ref.png ...] [--scan] [--out file.png]
//
// --scan runs the gallery scan first (what the dialog's "Rescan" does) and
// prints what it found. Without reference files it renders from three
// generated colour cards, which proves the plumbing (extra LoadImage nodes,
// upload, slots, run, fetch) but not the picture.

import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { isComfyConfigured, closeComfyClient } from '../src/comfy/client.js';
import { comfyImageCatalog, _runComfyImageScanForTests } from '../src/comfy/imageModels.js';
import { generateComfyStillImage } from '../src/web/comfyImageGenerate.js';

async function main() {
  if (!isComfyConfigured()) {
    console.error('COMFYUI_URL is not set — nothing to smoke.');
    process.exit(2);
  }
  const argv = process.argv.slice(2);
  const scan = argv.includes('--scan');
  const outIdx = argv.indexOf('--out');
  const out = outIdx >= 0 ? argv[outIdx + 1] : 'comfy-image-smoke.png';
  const positional = argv.filter((a, i) => !a.startsWith('--') && i !== outIdx + 1);
  const modelId = positional[0] || 'qwen-image-2.1-edit';
  const files = positional.slice(1);

  if (scan) {
    console.log('scanning the gallery (about a minute)…');
    await _runComfyImageScanForTests();
    const cat = comfyImageCatalog();
    for (const m of cat.models) console.log(`  ✔ ${m.id}  refs×${m.max_reference_images}  ${m.label}${m.verified ? '' : '  (untested)'}`);
    console.log(`  ${cat.unavailable.length} more take references but are not installed`);
  }

  const inputImages = [];
  if (files.length) {
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      inputImages.push({
        buffer: await fsp.readFile(f),
        contentType: ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png',
        label: path.basename(f, ext),
      });
    }
  } else {
    const cards = [['a red card', { r: 190, g: 40, b: 40 }], ['a green card', { r: 40, g: 160, b: 70 }], ['a blue card', { r: 40, g: 70, b: 190 }]];
    for (const [label, background] of cards) {
      inputImages.push({
        buffer: await sharp({ create: { width: 768, height: 768, channels: 3, background } }).png().toBuffer(),
        contentType: 'image/png',
        label,
      });
    }
  }

  const t0 = Date.now();
  console.log(`rendering with ${modelId} from ${inputImages.length} reference(s)…`);
  const result = await generateComfyStillImage({
    model: `comfy:${modelId}`,
    prompt: files.length
      ? 'Wide shot, eye level, 35mm. The characters stand together in the location, soft practical light, shallow depth of field.'
      : 'Three playing cards — one red, one green, one blue — fanned out on a dark wooden table, overhead lamp, shallow depth of field.',
    inputImages,
    params: { width: 1344, height: 768, steps: 12 },
  });
  await fsp.writeFile(out, result.buffer);
  const meta = await sharp(result.buffer).metadata();
  console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s → ${out} (${meta.width}×${meta.height}, ${result.contentType}, ${result.model})`);
}

main()
  .catch((e) => {
    console.error('FAILED:', e?.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeComfyClient();
    process.exit();
  });
