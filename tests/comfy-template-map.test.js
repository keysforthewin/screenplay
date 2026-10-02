// The gallery → registry auto-mapper: given comfy-mcp's slot listing (and
// optionally get_template's io block) it proposes a registry entry whose
// every address exists in the listing; the LTX-2.3 ia2v fixture must map to
// exactly what the hand-written built-in entry uses.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoMapTemplate, inactiveNodeIds, summarizeGalleryRow } from '../src/comfy/templateMap.js';
import { getComfyVideoModel, validateRegistryEntry, registerComfyVideoModels, listComfyVideoModels, listRegisteredComfyVideoModels } from '../src/comfy/videoModels.js';
import { slotAddressesFromListing, buildSlotOverrides, validateComfyParams, secondsToFrames } from '../src/comfy/paramMap.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FULL = JSON.parse(readFileSync(path.join(here, 'fixtures/comfy/slots-full.json'), 'utf8'));
const SLOTS = JSON.parse(readFileSync(path.join(here, 'fixtures/comfy/slots.json'), 'utf8'));
// Live listings (2026-09-30) of two Wan first-last-frame templates whose length
// slot counts frames; video_wan2_2_14B_flf2v also carries a bypassed copy.
const FLF = JSON.parse(readFileSync(path.join(here, 'fixtures/comfy/slots-flf.json'), 'utf8'));

describe('autoMapTemplate', () => {
  it('maps the LTX-2.3 ia2v template onto the same addresses as the built-in entry', () => {
    const { slots } = FULL.video_ltx2_3_ia2v;
    const { proposal, warnings } = autoMapTemplate({ name: 'video_ltx2_3_ia2v', slots });
    const builtin = getComfyVideoModel('ltx-2.3-ia2v');
    expect(proposal.id).toBe('ltx2-3-ia2v');
    expect(proposal.template).toBe('video_ltx2_3_ia2v');
    expect(proposal.kind).toBe('local');
    expect(proposal.imageSlots).toEqual(builtin.imageSlots);
    expect(proposal.audioSlots).toEqual(builtin.audioSlots);
    expect(proposal.inputs).toEqual({ startFrame: 'required', endFrame: 'unused', referenceImages: 'unused', audio: 'required' });
    expect(proposal.output).toEqual(builtin.output);
    for (const key of ['prompt', 'negative_prompt', 'duration_seconds', 'width', 'height', 'fps', 'seed', 'prompt_enhance']) {
      expect(proposal.params[key]?.address, key).toBe(builtin.params[key].address);
    }
    expect(proposal.params.prompt_enhance.default).toBe(false);
    expect(proposal.params.duration_seconds.default).toBe(9);
    expect(warnings).toEqual([]);
    // Every proposed address is a real slot, and the proposal validates as-is.
    const known = slotAddressesFromListing({ slots });
    const { ok, errors } = validateRegistryEntry(proposal, known);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  it('uses io.inputs order for start frame vs references, flags API templates, and warns when nothing looks like a duration', () => {
    const slots = [
      { address: '7.image', name: 'image', type: 'COMBO', current_value: 'b.png', instance_id: '7', node_type: 'LoadImage' },
      { address: '3.image', name: 'image', type: 'COMBO', current_value: 'a.png', instance_id: '3', node_type: 'LoadImage' },
      { address: '9.text', name: 'text', type: 'STRING', current_value: 'A slow push in on the diner.', instance_id: '9', node_type: 'CLIPTextEncode' },
      { address: '10.text', name: 'text', type: 'STRING', current_value: 'blurry, low quality', instance_id: '10', node_type: 'CLIPTextEncode' },
      { address: '12.filename_prefix', name: 'filename_prefix', type: 'STRING', current_value: 'video/x', instance_id: '12', node_type: 'SaveVideo' },
      { address: '12.format', name: 'format', type: 'COMBO', current_value: 'auto', instance_id: '12', node_type: 'SaveVideo' },
      { address: '20.seed', name: 'seed', type: 'INT', current_value: 5, instance_id: '20', node_type: 'KSampler' },
      { address: '20.steps', name: 'steps', type: 'INT', current_value: 20, instance_id: '20', node_type: 'KSampler' },
      { address: '20.cfg', name: 'cfg', type: 'FLOAT', current_value: 4.5, instance_id: '20', node_type: 'KSampler' },
      { address: '30.width', name: 'width', type: 'INT', current_value: 832, instance_id: '30', node_type: 'EmptyLatent' },
      { address: '30.height', name: 'height', type: 'INT', current_value: 480, instance_id: '30', node_type: 'EmptyLatent' },
    ];
    const info = { io: { inputs: [{ nodeId: 7, mediaType: 'image' }, { nodeId: 3, mediaType: 'image' }], outputs: [{ nodeId: 12 }] }, tags: ['api', 'video'] };
    const { proposal, warnings } = autoMapTemplate({ name: 'api_kling_x', info, slots, api: true });
    expect(proposal.imageSlots).toEqual([{ address: '7.image', role: 'start_frame' }, { address: '3.image', role: 'reference' }]);
    expect(proposal.inputs.referenceImages).toBe('optional');
    expect(proposal.maxReferenceImages).toBe(1);
    expect(proposal.kind).toBe('api');
    expect(proposal.spends_credits).toBe(true);
    expect(proposal.params.prompt.address).toBe('9.text');
    expect(proposal.params.negative_prompt.address).toBe('10.text');
    expect(proposal.params.seed.address).toBe('20.seed');
    expect(proposal.params.steps.address).toBe('20.steps');
    expect(proposal.params.cfg.address).toBe('20.cfg');
    expect(proposal.params.width.address).toBe('30.width');
    expect(proposal.params.height.address).toBe('30.height');
    expect(proposal.params.duration_seconds).toBeUndefined();
    expect(proposal.output).toEqual({ filenamePrefix: '12.filename_prefix', format: '12.format' });
    expect(warnings.join(' ')).toMatch(/no duration slot/);
    expect(validateRegistryEntry(proposal, slotAddressesFromListing({ slots })).errors).toEqual(['a duration_seconds param is required']);
  });

  it('maps a first-last-frame template\'s start and end images by their sample names and requires both', () => {
    const img = (id, value) => ({ address: `${id}.image`, name: 'image', type: 'COMBO', node_type: 'LoadImage', instance_id: String(id), current_value: value });
    const slots = [
      img(62, 'flf_start_image.png'), // the bypassed Lightning copy, listed first
      img(68, 'flf_end_image.png'),
      { address: '90.text', name: 'text', type: 'STRING', node_type: 'CLIPTextEncode', instance_id: '90', current_value: 'a cat' },
      { address: '81.length', name: 'length', type: 'INT', node_type: 'WanFirstLastFrameToVideo', instance_id: '81', current_value: 81 },
      { address: '83.filename_prefix', name: 'filename_prefix', type: 'STRING', node_type: 'SaveVideo', instance_id: '83', current_value: 'video/ComfyUI' },
    ];
    const { proposal, warnings } = autoMapTemplate({ name: 'video_wan2_2_14B_flf2v', info: { tags: ['FLF2V', 'Video'] }, slots: [...slots, img(89, 'flf_end_image.png'), img(80, 'flf_start_image.png')] });
    expect(proposal.imageSlots).toEqual([
      { address: '62.image', role: 'start_frame' },
      { address: '68.image', role: 'end_frame' },
    ]);
    expect(proposal.inputs).toMatchObject({ startFrame: 'required', endFrame: 'required', referenceImages: 'unused' });
    expect(warnings.join(' ')).toMatch(/2 further LoadImage node\(s\) left unmapped/);
    // The registry accepts the role and requires the slot when the input is set.
    const known = new Set([...slots.map((s) => s.address), '89.image', '80.image']);
    const entry = { ...proposal, id: 'my-flf', params: { ...proposal.params, duration_seconds: { address: '81.length', type: 'float' } } };
    expect(validateRegistryEntry(entry, known).entry.inputs.endFrame).toBe('required');
    expect(validateRegistryEntry({ ...entry, imageSlots: [{ address: '62.image', role: 'start_frame' }] }, known).errors.join(' ')).toMatch(/inputs.endFrame is set but no end_frame image slot/);
  });

  it('takes a Wan frame-count length as the duration and renders seconds × fps as 4n+1 frames', () => {
    const { info, slots } = FLF['wan2.1_flf2v_720_f16'];
    const { proposal, warnings } = autoMapTemplate({ name: 'wan2.1_flf2v_720_f16', info, slots });
    expect(warnings).toEqual([]);
    expect(proposal.imageSlots).toEqual([{ address: '52.image', role: 'start_frame' }, { address: '72.image', role: 'end_frame' }]);
    expect(proposal.params.fps).toMatchObject({ address: '91.fps', default: 16 });
    // 33 frames at 16 fps → 2 s.
    expect(proposal.params.duration_seconds).toMatchObject({ address: '83.length', unit: 'frames', frame_rule: '4n+1', fps: 16, default: 2 });
    const { ok, errors, entry } = validateRegistryEntry({ ...proposal, id: 'wan21-flf' }, slotAddressesFromListing({ slots }));
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
    const { params } = validateComfyParams(entry, { duration_seconds: 5, prompt: 'p' });
    const length = (ov) => ov.find((o) => o.address === '83.length')?.value;
    expect(length(buildSlotOverrides(entry, { params }).overrides)).toBe(81);
  });

  it('skips nodes the workflow bypasses, so a two-pipeline template maps its live copy', () => {
    const { info, slots, inactive } = FLF.video_wan2_2_14B_flf2v;
    const builtin = getComfyVideoModel('wan-2.2-14b-flf2v');
    const live = autoMapTemplate({ name: 'video_wan2_2_14B_flf2v', info, slots, inactiveNodes: new Set(inactive) });
    expect(live.warnings).toEqual([]);
    expect(live.proposal.imageSlots).toEqual(builtin.imageSlots);
    for (const key of ['prompt', 'negative_prompt', 'duration_seconds', 'width', 'height', 'fps', 'seed']) {
      expect(live.proposal.params[key]?.address, key).toBe(builtin.params[key].address);
    }
    // Without the bypass list the mapper lands on the switched-off Lightning copy.
    const blind = autoMapTemplate({ name: 'video_wan2_2_14B_flf2v', info, slots });
    expect(blind.proposal.imageSlots[0].address).toBe('62.image');
  });

  it('inactiveNodeIds reads muted and bypassed nodes; secondsToFrames honours the frame rules', () => {
    expect([...inactiveNodeIds({ nodes: [{ id: 1, mode: 0 }, { id: 2, mode: 4 }, { id: 3, mode: 2 }, { id: 4 }] })]).toEqual(['2', '3']);
    expect(inactiveNodeIds(null).size).toBe(0);
    expect(secondsToFrames(5, 16, '4n+1')).toBe(81);
    expect(secondsToFrames(3, 16, '4n+1')).toBe(49);
    expect(secondsToFrames(4, 24, '8n+1')).toBe(97);
    expect(secondsToFrames(2, 24, null)).toBe(48);
    expect(secondsToFrames(0, 16, '4n+1')).toBe(5);
  });

  it('summarizeGalleryRow normalizes the search rows', () => {
    expect(summarizeGalleryRow({ name: 'video_wan2_2_14B_i2v', title: 'Wan 2.2', tags: ['Video'], local_check: { checked: true, runnable: true } }))
      .toMatchObject({ name: 'video_wan2_2_14B_i2v', title: 'Wan 2.2', api: false, runnable: true });
    expect(summarizeGalleryRow({ name: 'api_seedance_2_5', tags: ['API'] })).toMatchObject({ api: true, runnable: null, title: 'api_seedance_2_5' });
  });
});

describe('validateRegistryEntry + registerComfyVideoModels', () => {
  const known = new Set(SLOTS.video_ltx2_5_i2v);
  const good = () => {
    const b = getComfyVideoModel('ltx-2.5-i2v');
    return { ...b, id: 'my-ltx', label: 'My LTX', params: { prompt: b.params.prompt, duration_seconds: b.params.duration_seconds } };
  };

  it('rejects built-in id collisions, bad ids, unknown addresses, missing prompt/duration and inconsistent credit flags', () => {
    expect(validateRegistryEntry({ ...good(), id: 'ltx-2.5-i2v' }, known).errors.join(' ')).toMatch(/collides with a built-in/);
    expect(validateRegistryEntry({ ...good(), id: 'Bad Id' }, known).errors.join(' ')).toMatch(/id must be/);
    expect(validateRegistryEntry({ ...good(), params: { prompt: { address: '999.nope', type: 'string' }, duration_seconds: good().params.duration_seconds } }, known).errors.join(' ')).toMatch(/999\.nope is not a slot/);
    expect(validateRegistryEntry({ ...good(), params: { prompt: good().params.prompt } }, known).errors).toContain('a duration_seconds param is required');
    expect(validateRegistryEntry({ ...good(), kind: 'api', spends_credits: false }, known).errors.join(' ')).toMatch(/spends_credits must be true/);
    expect(validateRegistryEntry({ ...good(), params: { ...good().params, bogus: { address: '398.value' } } }, known).errors.join(' ')).toMatch(/not a canonical/);
    const ok = validateRegistryEntry(good(), known);
    expect(ok.ok).toBe(true);
    expect(ok.entry.inputs.startFrame).toBe('required');
    expect(ok.entry.audioSlots).toEqual([]);
  });

  it('registered models merge after the built-ins, are addressable by id and carry registered:true; static ids win', () => {
    const { entry } = validateRegistryEntry(good(), known);
    expect(registerComfyVideoModels([entry, { ...entry, id: 'ltx-2.5-i2v' }])).toBe(1);
    expect(getComfyVideoModel('my-ltx')).toMatchObject({ id: 'my-ltx', registered: true });
    expect(getComfyVideoModel('ltx-2.5-i2v').registered).toBeUndefined();
    expect(listComfyVideoModels().at(-1).id).toBe('my-ltx');
    expect(listRegisteredComfyVideoModels()).toHaveLength(1);
    registerComfyVideoModels([]);
    expect(getComfyVideoModel('my-ltx')).toBeNull();
  });
});
