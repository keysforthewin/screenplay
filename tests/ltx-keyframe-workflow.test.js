// The LTX-2.5 keyframe graph builder: pure, so every property is checked
// here — node recipe, guide chaining, grid snapping and the input names
// against the object_info fixture.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  buildLtxKeyframeWorkflow,
  ltxFrameCount,
  snapGuideFrameIndex,
  placeKeyframes,
  LTX_DEFAULT_NEGATIVE_PROMPT,
  LTX_DEFAULT_GUIDE_STRENGTH,
} from '../src/comfy/ltxKeyframeWorkflow.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NODE_INPUTS = JSON.parse(readFileSync(path.join(here, 'fixtures/comfy/ltx-nodes.json'), 'utf8'));

const base = {
  prompt: 'A ball rises, hangs, falls.',
  width: 1280,
  height: 720,
  frames: 121,
  fps: 24,
  seed: 7,
  images: { start_frame: 'start.png', end_frame: 'end.png', keyframes: [] },
};

function byType(wf, type) {
  return Object.entries(wf).filter(([, n]) => n.class_type === type);
}

describe('ltxFrameCount / snapGuideFrameIndex', () => {
  it('renders 8k+1 frames, at least 9', () => {
    expect(ltxFrameCount(5, 24)).toBe(121);
    expect(ltxFrameCount(0.1, 24)).toBe(9);
    expect(ltxFrameCount(30, 24)).toBe(721);
    expect(ltxFrameCount(7, 24)).toBe(169); // 168 → k=21 → 169
  });

  it('snaps a keyframe time down to the 8-frame grid, strictly inside the clip', () => {
    expect(snapGuideFrameIndex(1.5, 24, 121)).toBe(32); // 36 → 32
    expect(snapGuideFrameIndex(0, 24, 121)).toBe(8); // never the start guide
    expect(snapGuideFrameIndex(5, 24, 121)).toBe(112); // never the end guide's slot (120)
    expect(snapGuideFrameIndex(2, 24, 9)).toBeNull(); // no interior slot
    expect(snapGuideFrameIndex(1, 24, 25)).toBe(16); // 24 → clamped to the last interior slot (25-1-8)
  });
});

describe('placeKeyframes', () => {
  it('orders by frame, applies the default strength and keeps the later of two colliding keyframes', () => {
    const { guides, warnings } = placeKeyframes(
      [
        { filename: 'b.png', at_seconds: 3.5, strength: 0.4 },
        { filename: 'a.png', at_seconds: 1.5 },
        { filename: 'c.png', at_seconds: 1.6 }, // 38 → 32, same slot as a.png
      ],
      { fps: 24, frames: 121 },
    );
    expect(guides.map((g) => g.filename)).toEqual(['c.png', 'b.png']);
    expect(guides[0]).toMatchObject({ frame_idx: 32, strength: LTX_DEFAULT_GUIDE_STRENGTH });
    expect(guides[1]).toMatchObject({ frame_idx: 80, strength: 0.4 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/same frame 32/);
  });

  it('drops a keyframe the clip has no slot for, with a warning', () => {
    const { guides, warnings } = placeKeyframes([{ filename: 'a.png', at_seconds: 0.2 }], { fps: 24, frames: 9 });
    expect(guides).toEqual([]);
    expect(warnings[0]).toMatch(/too short/);
  });
});

describe('buildLtxKeyframeWorkflow', () => {
  it('with no keyframes is the first/last-frame graph: guides at 0 and -1', () => {
    const { workflow, guides, outputNodeId } = buildLtxKeyframeWorkflow(base);
    const adds = byType(workflow, 'LTXVAddGuide');
    expect(adds).toHaveLength(2);
    expect(adds.map(([, n]) => n.inputs.frame_idx)).toEqual([0, -1]);
    expect(adds.map(([, n]) => n.inputs.strength)).toEqual([0.7, 0.7]);
    expect(guides.map((g) => g.role)).toEqual(['start', 'end']);
    expect(workflow[outputNodeId].class_type).toBe('SaveVideo');
    expect(workflow[outputNodeId].inputs.filename_prefix).toBe('video/screenplay/keyframes');
    expect(byType(workflow, 'LTXVContextWindows')).toHaveLength(0);
    expect(byType(workflow, 'CLIPTextEncode').map(([, n]) => n.inputs.text)).toEqual([base.prompt, LTX_DEFAULT_NEGATIVE_PROMPT]);
  });

  it('chains one guide per keyframe between the start and end guides, in frame order', () => {
    const { workflow, guideNodeIds } = buildLtxKeyframeWorkflow({
      ...base,
      images: {
        start_frame: 'start.png',
        end_frame: 'end.png',
        keyframes: [
          { filename: 'k1.png', frame_idx: 32, strength: 0.7 },
          { filename: 'k2.png', frame_idx: 80, strength: 0.5 },
        ],
      },
    });
    const adds = guideNodeIds.map((id) => workflow[id]);
    expect(adds.map((n) => n.inputs.frame_idx)).toEqual([0, 32, 80, -1]);
    expect(adds.map((n) => n.inputs.strength)).toEqual([0.7, 0.7, 0.5, 0.7]);
    // Each guide takes positive/negative/latent from the previous one.
    for (let i = 1; i < adds.length; i++) {
      expect(adds[i].inputs.positive).toEqual([guideNodeIds[i - 1], 0]);
      expect(adds[i].inputs.negative).toEqual([guideNodeIds[i - 1], 1]);
      expect(adds[i].inputs.latent).toEqual([guideNodeIds[i - 1], 2]);
    }
    // The first takes the conditioning + empty latent.
    const cond = byType(workflow, 'LTXVConditioning')[0][0];
    const empty = byType(workflow, 'EmptyLTXVLatentVideo')[0][0];
    expect(adds[0].inputs.positive).toEqual([cond, 0]);
    expect(adds[0].inputs.latent).toEqual([empty, 0]);
    // The guider, the AV concat and the crop read the LAST guide.
    const last = guideNodeIds[guideNodeIds.length - 1];
    expect(byType(workflow, 'LTXVDualCFGGuider')[0][1].inputs.positive).toEqual([last, 0]);
    expect(byType(workflow, 'LTXVConcatAVLatent')[0][1].inputs.video_latent).toEqual([last, 2]);
    expect(byType(workflow, 'LTXVCropGuides')[0][1].inputs.negative).toEqual([last, 1]);
    // Every guide image: LoadImage → ImageScale → LTXVPreprocess → guide.
    expect(byType(workflow, 'LoadImage').map(([, n]) => n.inputs.image)).toEqual(['start.png', 'k1.png', 'k2.png', 'end.png']);
    expect(byType(workflow, 'LTXVPreprocess')).toHaveLength(4);
    expect(byType(workflow, 'ImageScale').every(([, n]) => n.inputs.width === 1280 && n.inputs.height === 720)).toBe(true);
  });

  it('threads frames, fps, seed and size into the latents, conditioning and output', () => {
    const { workflow } = buildLtxKeyframeWorkflow({ ...base, frames: 241, fps: 25, seed: 99, width: 960, height: 544 });
    expect(byType(workflow, 'EmptyLTXVLatentVideo')[0][1].inputs).toMatchObject({ width: 960, height: 544, length: 241 });
    expect(byType(workflow, 'LTXVEmptyLatentAudio')[0][1].inputs).toMatchObject({ frames_number: 241, frame_rate: 25 });
    expect(byType(workflow, 'LTXVConditioning')[0][1].inputs.frame_rate).toBe(25);
    expect(byType(workflow, 'CreateVideo')[0][1].inputs.fps).toBe(25);
    expect(byType(workflow, 'RandomNoise')[0][1].inputs.noise_seed).toBe(99);
  });

  it('long clips put LTXVContextWindows between the UNET and the guider', () => {
    const { workflow } = buildLtxKeyframeWorkflow({ ...base, frames: 721, longClip: true });
    const [[cwId, cw]] = byType(workflow, 'LTXVContextWindows');
    const [[unetId]] = byType(workflow, 'UNETLoader');
    expect(cw.inputs.model).toEqual([unetId, 0]);
    expect(cw.inputs).toMatchObject({ context_length: 145, context_overlap: 40, context_schedule: 'standard_uniform' });
    expect(byType(workflow, 'LTXVDualCFGGuider')[0][1].inputs.model).toEqual([cwId, 0]);
  });

  it('an end frame is optional (image-to-video with keyframes)', () => {
    const { workflow, guides } = buildLtxKeyframeWorkflow({
      ...base,
      images: { start_frame: 'start.png', keyframes: [{ filename: 'k.png', frame_idx: 56, strength: 0.7 }] },
    });
    expect(guides.map((g) => g.frame_idx)).toEqual([0, 56]);
    expect(byType(workflow, 'LTXVAddGuide')).toHaveLength(2);
  });

  it('rejects a missing prompt or start frame', () => {
    expect(() => buildLtxKeyframeWorkflow({ ...base, prompt: '' })).toThrow(/prompt/);
    expect(() => buildLtxKeyframeWorkflow({ ...base, images: {} })).toThrow(/start_frame/);
  });

  it('writes only input names the live object_info knows (fixture), and every link points at a node', () => {
    const { workflow } = buildLtxKeyframeWorkflow({
      ...base,
      longClip: true,
      images: { start_frame: 's.png', end_frame: 'e.png', keyframes: [{ filename: 'k.png', frame_idx: 40, strength: 0.7 }] },
    });
    for (const [id, node] of Object.entries(workflow)) {
      const known = NODE_INPUTS[node.class_type];
      expect(known, `no fixture entry for ${node.class_type} (node ${id})`).toBeTruthy();
      for (const [name, value] of Object.entries(node.inputs)) {
        expect(known, `${node.class_type}.${name}`).toContain(name);
        if (Array.isArray(value)) {
          expect(workflow[value[0]], `${node.class_type}.${name} → missing node ${value[0]}`).toBeTruthy();
          expect(Number.isInteger(value[1])).toBe(true);
        }
      }
    }
  });
});
