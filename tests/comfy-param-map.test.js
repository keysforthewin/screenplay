// Pure parameter mapping for ComfyUI renders, checked against the slot
// addresses comfy-cli reported for each registered template
// (tests/fixtures/comfy/slots.json) so a typo'd address can't creep in.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  COMFY_VIDEO_MODELS,
  getComfyVideoModel,
  describeComfyVideoModel,
  CANONICAL_PARAM_ORDER,
} from '../src/comfy/videoModels.js';
import {
  validateComfyParams,
  buildSlotOverrides,
  assembleCutPrompt,
  slotAddressesFromListing,
} from '../src/comfy/paramMap.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SLOTS = JSON.parse(readFileSync(path.join(here, 'fixtures/comfy/slots.json'), 'utf8'));

describe('registry addresses', () => {
  it('every registered model maps only onto slots comfy-cli reported for its template', () => {
    for (const m of COMFY_VIDEO_MODELS) {
      if (m.graph) {
        // A builder model has no template and no addresses; its graph is
        // covered by tests/ltx-keyframe-workflow.test.js.
        expect(m.template).toBeNull();
        expect(m.imageSlots).toEqual([]);
        for (const [key, spec] of Object.entries(m.params)) {
          expect(CANONICAL_PARAM_ORDER, `${m.id}.${key} is not canonical`).toContain(key);
          expect(spec.address).toBeUndefined();
        }
        continue;
      }
      const known = new Set(SLOTS[m.template] || []);
      expect(known.size, `no slot fixture for ${m.template}`).toBeGreaterThan(0);
      for (const [key, spec] of Object.entries(m.params)) {
        expect(CANONICAL_PARAM_ORDER, `${m.id}.${key} is not canonical`).toContain(key);
        expect(known.has(spec.address), `${m.id}: ${key} → ${spec.address}`).toBe(true);
      }
      for (const f of m.fixed || []) expect(known.has(f.address), `${m.id}: fixed ${f.address}`).toBe(true);
      for (const s of m.imageSlots || []) expect(known.has(s.address), `${m.id}: image ${s.address}`).toBe(true);
      for (const s of m.audioSlots || []) expect(known.has(s.address), `${m.id}: audio ${s.address}`).toBe(true);
      if (m.inputs?.audio === 'required') expect((m.audioSlots || []).length, `${m.id} needs audio but has no audioSlots`).toBeGreaterThan(0);
      expect(known.has(m.output.filenamePrefix), `${m.id}: prefix ${m.output.filenamePrefix}`).toBe(true);
      if (typeof m.derived === 'function') {
        for (const d of m.derived({ steps: 4 })) expect(known.has(d.address), `${m.id}: derived ${d.address}`).toBe(true);
      }
      expect(m.params.prompt, `${m.id} has no prompt param`).toBeTruthy();
      expect(m.params.duration_seconds, `${m.id} has no duration param`).toBeTruthy();
    }
  });

  it('describeComfyVideoModel strips addresses and functions, adds labels', () => {
    const d = describeComfyVideoModel(getComfyVideoModel('wan-2.2-14b-i2v'));
    expect(d.params.width.address).toBeUndefined();
    expect(d.params.width.label).toBe('Width');
    expect(d.derived).toBeUndefined();
    expect(d.kind).toBe('local');
    expect(d.spends_credits).toBe(false);
    expect(describeComfyVideoModel(getComfyVideoModel('kling-3.0')).spends_credits).toBe(true);
  });
});

describe('validateComfyParams', () => {
  const ltx = getComfyVideoModel('ltx-2.5-i2v');
  const wan = getComfyVideoModel('wan-2.2-14b-i2v');
  const sd = getComfyVideoModel('seedance-2.5-i2v-1080p');

  it('fills defaults, clamps ranges with warnings, keeps seed null', () => {
    const { params, warnings, errors } = validateComfyParams(ltx, { duration_seconds: 99 });
    expect(errors).toEqual([]);
    expect(params.duration_seconds).toBe(20);
    expect(warnings.some((w) => w.includes('duration_seconds 99 lowered'))).toBe(true);
    expect(params.fps).toBe(24);
    expect(params.seed).toBeNull();
    expect(params.prompt_enhance).toBe(false);
    expect(params.aspect_ratio).toBe('16:9 (Widescreen)');
  });

  it('rounds Wan width/height to multiples of 16 and coerces numeric strings', () => {
    const { params, warnings } = validateComfyParams(wan, { width: '840', height: 479, steps: '6' });
    expect(params.width).toBe(848);
    expect(params.height).toBe(480);
    expect(params.steps).toBe(6);
    expect(warnings.some((w) => w.includes('multiple of 16'))).toBe(true);
  });

  it('rejects enum mismatches and non-numeric numbers, warns on unknown keys, coerces bools', () => {
    const r = validateComfyParams(sd, { resolution: '8k', duration_seconds: 'long', generate_audio: 'true', bogus: 1 });
    expect(r.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('resolution must be one of'), expect.stringContaining('duration_seconds must be a number')]),
    );
    expect(r.params.generate_audio).toBe(true);
    expect(r.warnings).toEqual(expect.arrayContaining([expect.stringContaining('bogus')]));
  });
});

describe('buildSlotOverrides', () => {
  const ltx = getComfyVideoModel('ltx-2.5-i2v');
  const ia2v = getComfyVideoModel('ltx-2.3-ia2v');
  const wan = getComfyVideoModel('wan-2.2-14b-i2v');
  const r2v = getComfyVideoModel('seedance-2.0-r2v');
  const kling = getComfyVideoModel('kling-3.0');

  function asMap(overrides) {
    return Object.fromEntries(overrides.map((o) => [o.address, o.value]));
  }

  it('LTX-2.3 ia2v: the joined dialogue MP3 fills the LoadAudio slot; the enhancer ships off; a missing audio warns', () => {
    const { params } = validateComfyParams(ia2v, { duration_seconds: 3.5 });
    params.prompt = 'She answers without looking up.';
    const { overrides, warnings } = buildSlotOverrides(ia2v, {
      params,
      imageFilenames: { start_frame: 'cut-abc-start.png', reference: [], audio: 'cut-abc-dialogue.mp3' },
      filenamePrefix: 'video/screenplay/cut-abc',
    });
    const m = asMap(overrides);
    expect(m['269.image']).toBe('cut-abc-start.png');
    expect(m['276.audio']).toBe('cut-abc-dialogue.mp3');
    expect(m['340.value']).toBe('She answers without looking up.');
    expect(m['340.value_4']).toBe(3.5);
    expect(m['340.value_5']).toBe(false);
    expect(m['341.filename_prefix']).toBe('video/screenplay/cut-abc');
    expect(warnings).toEqual([]);
    const noAudio = buildSlotOverrides(ia2v, { params, imageFilenames: { start_frame: 'x.png', reference: [] } });
    expect(noAudio.warnings.join(' ')).toMatch(/no audio for slot 276\.audio/);
    expect(asMap(noAudio.overrides)['276.audio']).toBeUndefined();
  });

  it('LTX: canonical params land on their addresses, the start image fills the LoadImage slot, seed is filled', () => {
    const { params } = validateComfyParams(ltx, { duration_seconds: 4, megapixels: 0.5 });
    params.prompt = 'A slow push in.';
    const { overrides, warnings } = buildSlotOverrides(ltx, {
      params,
      imageFilenames: { start_frame: 'cut-abc-start.png', reference: [] },
      filenamePrefix: 'video/screenplay/cut-abc',
    });
    const m = asMap(overrides);
    expect(m['395.image']).toBe('cut-abc-start.png');
    expect(m['398.value']).toBe('A slow push in.');
    expect(m['398.value_2']).toBe(4);
    expect(m['403.megapixels']).toBe(0.5);
    expect(m['398.value_1']).toBe(false);
    expect(Number.isInteger(m['398.noise_seed'])).toBe(true);
    expect(m['398.noise_seed']).toBeGreaterThanOrEqual(0);
    expect(m['75.filename_prefix']).toBe('video/screenplay/cut-abc');
    expect(warnings).toEqual([]);
    for (const o of overrides) expect(SLOTS.video_ltx2_5_i2v).toContain(o.address);
  });

  it('Wan: derived switch step follows steps; advanced overrides pass through and win', () => {
    const { params } = validateComfyParams(wan, { steps: 8, seed: 42 });
    params.prompt = 'p';
    const { overrides, warnings } = buildSlotOverrides(wan, {
      params,
      imageFilenames: { start_frame: 'x.png' },
      advanced: [
        { address: '129/86.sampler_name', value: 'dpmpp_2m' },
        { address: '129.noise_seed', value: 7 },
        { address: 'nope.value', value: 1 },
        { value: 3 },
      ],
      slotAddresses: SLOTS.video_wan2_2_14B_i2v,
    });
    const m = asMap(overrides);
    expect(m['129/118.value']).toBe(8);
    expect(m['129/124.value']).toBe(4);
    expect(m['129/86.sampler_name']).toBe('dpmpp_2m');
    expect(m['129.noise_seed']).toBe(7);
    expect(m['nope.value']).toBeUndefined();
    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('nope.value'), expect.stringContaining('without an address')]),
    );
    // Last write wins but the address appears once.
    expect(overrides.filter((o) => o.address === '129.noise_seed')).toHaveLength(1);
  });

  it('reference-to-video: references fill the reference slot in order; extras are reported', () => {
    const { params } = validateComfyParams(r2v, {});
    params.prompt = 'p';
    const { overrides, warnings } = buildSlotOverrides(r2v, {
      params,
      imageFilenames: { start_frame: null, reference: ['ref-1.png', 'ref-2.png'] },
    });
    const m = asMap(overrides);
    expect(m['356.image']).toBe('ref-1.png');
    expect(m['361.model']).toBe('Seedance 2.0');
    expect(m['361.watermark']).toBe(false);
    expect(warnings.some((w) => w.includes('1 reference image(s) beyond'))).toBe(true);
  });

  it('Kling: the prompt lands on storyboard 1 and multi_shot is pinned to one storyboard', () => {
    const { params } = validateComfyParams(kling, { duration_seconds: 6 });
    params.prompt = 'p';
    const m = asMap(buildSlotOverrides(kling, { params, imageFilenames: { start_frame: 's.png' } }).overrides);
    expect(m['3.multi_shot']).toBe('1 storyboard');
    expect(m['3.multi_shot.storyboard_1_prompt']).toBe('p');
    expect(m['3.multi_shot.storyboard_1_duration']).toBe(6);
    expect(m['1.image']).toBe('s.png');
  });

  it('warns when a required image slot has nothing to fill it', () => {
    const { params } = validateComfyParams(ltx, {});
    params.prompt = 'p';
    const { warnings } = buildSlotOverrides(ltx, { params, imageFilenames: {} });
    expect(warnings).toEqual(expect.arrayContaining([expect.stringContaining('no start frame for slot 395.image')]));
  });

  it('slotAddressesFromListing reads both listing shapes', () => {
    expect(slotAddressesFromListing({ slots: [{ address: 'a.b' }] }).has('a.b')).toBe(true);
    expect(slotAddressesFromListing([{ address: 'c.d' }]).has('c.d')).toBe(true);
  });
});

describe('assembleCutPrompt', () => {
  const cut = {
    prompt: 'Medium shot from the aisle. **Sarah** slides the cup an inch. Stop when her hand lets go.',
    // Fields of the retired planner: never part of the prompt any more.
    reference_binding: '@Image1 controls Sarah’s identity and wardrobe only.',
    exclusions: ['Do not show the door opening yet.'],
  };
  const strip = (s) => s.replace(/\*\*/g, '');

  it('is the cut’s own prompt, markdown stripped, for every model', () => {
    const expected = 'Medium shot from the aisle. Sarah slides the cup an inch. Stop when her hand lets go.';
    expect(assembleCutPrompt(getComfyVideoModel('ltx-2.5-i2v'), cut, { stripMarkdown: strip })).toBe(expected);
    expect(assembleCutPrompt(getComfyVideoModel('seedance-2.0-r2v'), cut, { stripMarkdown: strip })).toBe(expected);
    expect(assembleCutPrompt(getComfyVideoModel('ltx-2.5-i2v'), { prompt: '  padded  ' })).toBe('padded');
    expect(assembleCutPrompt(getComfyVideoModel('ltx-2.5-i2v'), {})).toBe('');
  });

  it('an override replaces everything', () => {
    expect(assembleCutPrompt(getComfyVideoModel('ltx-2.5-i2v'), cut, { promptOverride: '  custom  ' })).toBe('custom');
  });
});
