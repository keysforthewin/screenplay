// Smoke tests for the generic catalog-derived model dispatcher in
// src/fal/videoModels.js. We don't mock the catalog file — these run
// against the real data/fal-models.json so they also catch the case where
// the manifest format drifts.

import { describe, it, expect } from 'vitest';

const FAMILIES = [
  { label: 'LTX', match: /\/ltx[-/]/, want: { startFrame: 'required' } },
  { label: 'Grok Imagine', match: /\/grok-imagine-video\//, want: { startFrame: 'required' } },
  { label: 'Seedance', match: /seedance/, want: {} },
  { label: 'Wan', match: /(\/wan[-/]|^wan\/)/, want: {} },
  { label: 'Vidu', match: /\/vidu\//, want: {} },
  { label: 'Veo 3.1 Fast', match: /\/veo3\.1\/fast\//, want: {} },
  { label: 'Kling', match: /\/kling-video\//, want: {} },
  { label: 'Happy Horse', match: /\/happy-horse\//, want: {} },
  { label: 'PixVerse', match: /\/pixverse\//, want: {} },
  { label: 'Pika', match: /\/pika\//, want: {} },
  { label: 'LongCat', match: /\/longcat-video\//, want: {} },
  { label: 'MiniMax', match: /\/minimax\//, want: {} },
];

describe('fal video catalog: generic auto-wiring', () => {
  it('exposes auto-wired families as Ready in loadCatalog()', async () => {
    const { loadCatalog } = await import('../src/fal/videoModels.js');
    const catalog = await loadCatalog();
    expect(catalog.models.length).toBeGreaterThan(50);

    for (const fam of FAMILIES) {
      const hits = catalog.models.filter((m) => fam.match.test(m.endpoint_id));
      expect(hits.length, `family ${fam.label} present in manifest`).toBeGreaterThan(0);
      const ready = hits.filter((m) => m.is_registered);
      expect(ready.length, `family ${fam.label} has at least one Ready row`).toBeGreaterThan(0);
    }
  });

  it('resolves auto-wired endpoint ids to a synthesized model', async () => {
    const { loadCatalog, getVideoModelOrCatalog } = await import('../src/fal/videoModels.js');
    const catalog = await loadCatalog();

    for (const fam of FAMILIES) {
      const row = catalog.models.find((m) => fam.match.test(m.endpoint_id) && m.is_registered);
      if (!row) continue;
      const model = await getVideoModelOrCatalog(row.endpoint_id);
      expect(model, `${fam.label}: ${row.endpoint_id} resolves`).toBeTruthy();
      expect(model.id).toBe(row.endpoint_id);
      expect(model.falModel).toBe(row.endpoint_id);
      expect(typeof model.buildInput).toBe('function');
      expect(typeof model.extractVideoUrl).toBe('function');
    }
  });

  it('buildInput emits a prompt and the right start-frame param', async () => {
    const { getVideoModelOrCatalog } = await import('../src/fal/videoModels.js');
    // LTX image-to-video uses `image_url` per the catalog snapshot.
    const model = await getVideoModelOrCatalog('fal-ai/ltx-2/image-to-video');
    if (!model) {
      // If the manifest has drifted, skip — covered by the broader test above.
      return;
    }
    const input = model.buildInput({
      prompt: 'A cat walks across a beam of moonlight.',
      startFrameUrl: 'https://fal.example/start.png',
      durationSeconds: 5,
      generateAudio: false,
    });
    expect(input.prompt).toContain('cat walks');
    // Whichever start-frame param this endpoint exposes, the URL must land
    // in exactly one of the known start-frame param names.
    const startParams = [
      'image_url', 'first_frame_url', 'start_image_url', 'first_image_url',
      'first_frame_image_url', 'start_frame', 'source_image_url', 'input_image_url',
    ];
    const populated = startParams.filter((p) => input[p] === 'https://fal.example/start.png');
    expect(populated.length).toBe(1);
  });

  it('LTX video_size: emits an object, never a "WxH" string', async () => {
    // fal-ai rejects `video_size: "1280x720"` with a 422 — the schema is a
    // union of { width, height } object OR a small enum of preset names.
    // Regression test: lock the dict form so nobody reverts it for cosmetics.
    const { getVideoModelOrCatalog } = await import('../src/fal/videoModels.js');
    const model = await getVideoModelOrCatalog('fal-ai/ltx-2.3-22b/image-to-video');
    if (!model) return; // manifest drift — covered by broader auto-wire test
    const input = model.buildInput({
      prompt: 'A test shot.',
      startFrameUrl: 'https://fal.example/start.png',
      resolution: '720p',
      durationSeconds: 5,
    });
    expect(typeof input.video_size).toBe('object');
    expect(Array.isArray(input.video_size)).toBe(false);
    expect(input.video_size).toEqual({ width: 1280, height: 720 });
  });

  it('Veo 3.1 lite FLF: catalog declares the 8s-only duration enum', async () => {
    // fal currently enforces `duration: '8s'` as the only legal value for
    // fal-ai/veo3.1/lite/first-last-frame-to-video. The catalog must
    // declare this so the dialog renders a constrained dropdown instead
    // of a free-form input that lets users type values fal rejects.
    const { loadCatalog } = await import('../src/fal/videoModels.js');
    const catalog = await loadCatalog();
    const row = catalog.models.find(
      (m) => m.endpoint_id === 'fal-ai/veo3.1/lite/first-last-frame-to-video',
    );
    expect(row).toBeTruthy();
    expect(row.durations_enum).toEqual(['8s']);
  });

  it("Suffix-'s' duration enums: built duration matches the catalog format", async () => {
    // Regression for the bug where catalog enums like ['4s','6s','8s']
    // hit `Number('4s')` (NaN) in the snap path and rendered as "4ss"
    // in the dialog. The built input must be a string with the 's' suffix
    // matching what fal expects.
    const { getVideoModelOrCatalog } = await import('../src/fal/videoModels.js');
    const model = await getVideoModelOrCatalog('fal-ai/veo3.1/fast/first-last-frame-to-video');
    if (!model) return; // manifest drift
    expect(model.durations).toEqual(['4s', '6s', '8s']);
    const input = model.buildInput({
      prompt: 'x',
      startFrameUrl: 'https://fal.example/start.png',
      endFrameUrl: 'https://fal.example/end.png',
      durationSeconds: 6,
      generateAudio: false,
      resolution: '720p',
    });
    expect(input.duration).toBe('6s');
    expect(typeof input.duration).toBe('string');
  });

  it('Integer/empty duration enums: built duration is a string, never a JSON number', async () => {
    // Regression: fal's Kling o3 endpoints type `duration` as a STRING literal
    // enum ('3'..'15'). The catalog row for this endpoint lists `duration` as an
    // optional input but carries an EMPTY durations_enum, so the synthetic
    // builder had no format hint, defaulted to 'int', and emitted a bare JS
    // number — fal rejected it with a 422 literal_error (input 7 not in '3'..'15').
    // Every registered model stringifies duration; the synth builder must too.
    const { getVideoModelOrCatalog } = await import('../src/fal/videoModels.js');
    const model = await getVideoModelOrCatalog(
      'fal-ai/kling-video/o3/pro/video-to-video/reference',
    );
    if (!model) return; // manifest drift — endpoint not auto-wireable
    const input = model.buildInput({
      prompt: 'Restyle the clip.',
      videoUrl: 'https://fal.example/clip.mp4',
      durationSeconds: 7,
    });
    expect(typeof input.duration).toBe('string');
    expect(input.duration).toBe('7');
  });

  it('Plural param names (audio_urls): single source URL ships as a one-element array', async () => {
    // Regression: fal types plural-named params (audio_urls, video_urls,
    // image_urls) as lists. The synth builder wrapped reference images in an
    // array but always assigned audio/video as a bare string, so a model
    // exposing `audio_urls` (bytedance/seedance-2.0/reference-to-video) failed
    // with a 422 list_type error ("Input should be a valid list").
    const { getVideoModelOrCatalog } = await import('../src/fal/videoModels.js');
    const model = await getVideoModelOrCatalog('bytedance/seedance-2.0/reference-to-video');
    if (!model) return; // manifest drift — endpoint not auto-wireable
    const input = model.buildInput({
      prompt: 'A test shot.',
      audioUrl: 'https://fal.example/audio.bin',
      referenceImageUrls: ['https://fal.example/ref.png'],
    });
    expect(Array.isArray(input.audio_urls)).toBe(true);
    expect(input.audio_urls).toEqual(['https://fal.example/audio.bin']);
    // Reference images stay an array too (unchanged behavior).
    expect(Array.isArray(input.image_urls)).toBe(true);
  });

  it('refuses to auto-wire endpoints outside the allowlist', async () => {
    const { getVideoModelOrCatalog } = await import('../src/fal/videoModels.js');
    // Hunyuan Portrait is in the catalog but NOT in the allowlist; should
    // resolve to null (preview) unless it happens to also be in VIDEO_MODELS.
    const m = await getVideoModelOrCatalog('fal-ai/hunyuan-portrait');
    expect(m).toBeNull();
  });

  it('flashhead resolves to the bespoke registered entry (not a synth)', async () => {
    const { getVideoModelOrCatalog, getVideoModel } = await import('../src/fal/videoModels.js');
    const direct = getVideoModel('flashhead');
    expect(direct).toBeTruthy();
    expect(direct._synthetic).toBeUndefined();
    const input = direct.buildInput({
      prompt: 'A neon street at night.',
      startFrameUrl: 'https://fal.example/anchor.png',
    });
    // Flashhead uses `text`, not `prompt`.
    expect(input.text).toContain('neon street');
    expect(input.prompt).toBeUndefined();
    expect(input.image_url).toBe('https://fal.example/anchor.png');

    // The SPA submits with `chosenModel.id`, which is the registered id for
    // bespoke entries — getVideoModelOrCatalog('flashhead') routes through
    // the registry, not the catalog auto-wire path.
    const byId = await getVideoModelOrCatalog('flashhead');
    expect(byId).toBe(direct);
  });

  it('exposes flashhead as Ready in loadCatalog()', async () => {
    const { loadCatalog } = await import('../src/fal/videoModels.js');
    const catalog = await loadCatalog();
    const row = catalog.models.find((m) => m.endpoint_id === 'fal-ai/flashhead');
    expect(row).toBeTruthy();
    expect(row.is_registered).toBe(true);
    expect(row.id).toBe('flashhead');
  });

  it('attaches structured pricing to registered rows', async () => {
    const { loadCatalog } = await import('../src/fal/videoModels.js');
    const catalog = await loadCatalog();
    const expected = [
      { endpoint_id: 'fal-ai/kling-video/v3/pro/image-to-video', kind: 'per_second' },
      { endpoint_id: 'fal-ai/veo3.1/first-last-frame-to-video', kind: 'per_second_tiered' },
      { endpoint_id: 'fal-ai/kling-video/ai-avatar/v2/pro', kind: 'per_audio_second' },
      { endpoint_id: 'fal-ai/flashhead', kind: 'unknown' },
      { endpoint_id: 'fal-ai/sora-2/image-to-video', kind: 'per_second' },
      { endpoint_id: 'fal-ai/sora-2/image-to-video/pro', kind: 'per_second_tiered' },
    ];
    for (const want of expected) {
      const row = catalog.models.find((m) => m.endpoint_id === want.endpoint_id);
      expect(row, `${want.endpoint_id} present`).toBeTruthy();
      expect(row.pricing, `${want.endpoint_id} has structured pricing`).toBeTruthy();
      expect(row.pricing.kind).toBe(want.kind);
    }
  });

  it('parses pricing from catalog-only rows with parseable price_text', async () => {
    const { loadCatalog } = await import('../src/fal/videoModels.js');
    const catalog = await loadCatalog();
    // LTX-2 19B Distilled has per-megapixel price text.
    const ltx = catalog.models.find(
      (m) => m.endpoint_id === 'fal-ai/ltx-2-19b/distilled/image-to-video',
    );
    if (ltx) {
      expect(ltx.pricing?.kind).toBe('per_megapixel');
      expect(ltx.pricing?.exact).toBe(false);
    }
  });

  it('Sora 2: buildInput emits image_url + duration + raw prompt; never adds character_ids', async () => {
    const { getVideoModel } = await import('../src/fal/videoModels.js');
    const model = getVideoModel('sora-2');
    expect(model).toBeTruthy();
    const input = model.buildInput({
      prompt: 'Hero walks toward the camera.',
      startFrameUrl: 'https://fal.example/start.png',
      durationSeconds: 12,
    });
    expect(input.image_url).toBe('https://fal.example/start.png');
    expect(input.duration).toBe('12');
    expect(input.aspect_ratio).toBe('auto');
    expect(input.resolution).toBe('auto');
    expect(input.character_ids).toBeUndefined();
    expect(input.prompt).toBe('Hero walks toward the camera.');
  });

  it('Sora 2 Pro is registered and shares the same input shape as Sora 2', async () => {
    const { getVideoModel } = await import('../src/fal/videoModels.js');
    const model = getVideoModel('sora-2-pro');
    expect(model).toBeTruthy();
    expect(model.falModel).toBe('fal-ai/sora-2/image-to-video/pro');
    const input = model.buildInput({
      prompt: 'A wide cinematic shot.',
      startFrameUrl: 'https://fal.example/start.png',
      durationSeconds: 16,
    });
    expect(input.image_url).toBe('https://fal.example/start.png');
    expect(input.duration).toBe('16');
  });

  it('exposes the Wan 2.6 Flash variant as Ready via the wan prefix', async () => {
    const { loadCatalog } = await import('../src/fal/videoModels.js');
    const catalog = await loadCatalog();
    const row = catalog.models.find((m) => m.endpoint_id === 'wan/v2.6/image-to-video/flash');
    if (!row) return; // manifest may drift
    expect(row.is_registered).toBe(true);
  });

  it('extractVideoUrl handles common fal response shapes', async () => {
    const { getVideoModelOrCatalog, loadCatalog } = await import('../src/fal/videoModels.js');
    const catalog = await loadCatalog();
    const wanRow = catalog.models.find((m) => /\/wan[-/]/.test(m.endpoint_id) && m.is_registered);
    if (!wanRow) return;
    const model = await getVideoModelOrCatalog(wanRow.endpoint_id);
    expect(model.extractVideoUrl({ video: { url: 'https://a' } })).toBe('https://a');
    expect(model.extractVideoUrl({ output: { url: 'https://b' } })).toBe('https://b');
    expect(model.extractVideoUrl({ output: 'https://c' })).toBe('https://c');
    expect(model.extractVideoUrl({ video_url: 'https://d' })).toBe('https://d');
    expect(model.extractVideoUrl({})).toBeNull();
  });

  it('validateAssignment flags missing reference images', async () => {
    const { resolveFrameAssignment, validateAssignment } = await import(
      '../src/fal/videoModels.js'
    );
    const model = {
      inputs: {
        startFrame: 'unused',
        endFrame: 'unused',
        characterSheet: 'unused',
        referenceImages: 'required',
        audio: 'unused',
      },
    };
    const sbEmpty = { frames: [] };
    const sbOne = { frames: [{ image_id: 'abc' }] };
    expect(
      validateAssignment(model, resolveFrameAssignment(model, sbEmpty), sbEmpty),
    ).toEqual(['reference images']);
    expect(
      validateAssignment(model, resolveFrameAssignment(model, sbOne), sbOne),
    ).toEqual([]);
  });

  it('a slot-less reference model uses every frame, so one frame satisfies it', async () => {
    const { resolveFrameAssignment, validateAssignment } = await import(
      '../src/fal/videoModels.js'
    );
    const slotless = {
      inputs: {
        startFrame: 'unused',
        endFrame: 'unused',
        characterSheet: 'unused',
        referenceImages: 'required',
        audio: 'unused',
      },
    };
    const sbOne = { frames: [{ image_id: 'aaaaaaaaaaaaaaaaaaaaaaaa' }] };
    expect(
      validateAssignment(slotless, resolveFrameAssignment(slotless, sbOne), sbOne),
    ).toEqual([]);
    const sbNone = { frames: [] };
    expect(
      validateAssignment(slotless, resolveFrameAssignment(slotless, sbNone), sbNone),
    ).toEqual(['reference images']);

    // A model that DOES expose a start-frame slot consumes the single frame as
    // the start frame, leaving required references unsatisfied.
    const withStartSlot = {
      inputs: {
        startFrame: 'optional',
        endFrame: 'unused',
        characterSheet: 'unused',
        referenceImages: 'required',
        audio: 'unused',
      },
    };
    expect(
      validateAssignment(
        withStartSlot,
        resolveFrameAssignment(withStartSlot, sbOne),
        sbOne,
      ),
    ).toEqual(['reference images']);
  });
});

describe('resolveFrameAssignment', () => {
  const sb = (...ids) => ({ frames: ids.map((image_id) => ({ image_id })) });
  const slotless = (referenceImages = 'optional') => ({
    inputs: { startFrame: 'unused', endFrame: 'unused', referenceImages, audio: 'unused', videoInput: 'unused' },
  });

  it('returns no reference images when the model does not accept them', async () => {
    const { resolveFrameAssignment } = await import('../src/fal/videoModels.js');
    const model = { inputs: { startFrame: 'required', endFrame: 'unused', referenceImages: 'unused' } };
    const out = resolveFrameAssignment(model, sb('a', 'b', 'c'));
    expect(out.referenceImageIds).toEqual([]);
    expect(out.startFrameId).toBe('a');
  });

  it('a slot-less model folds every frame into the reference list, in order', async () => {
    const { resolveFrameAssignment } = await import('../src/fal/videoModels.js');
    const out = resolveFrameAssignment(slotless(), sb('start', 'end', 'ref1', 'ref2'));
    expect(out.referenceImageIds).toEqual(['start', 'end', 'ref1', 'ref2']);
    expect(out.startFrameId).toBe(null);
    expect(out.endFrameId).toBe(null);
  });

  it('uses the first frame as start, leaving the rest as references', async () => {
    const { resolveFrameAssignment } = await import('../src/fal/videoModels.js');
    const model = {
      inputs: { startFrame: 'optional', endFrame: 'unused', referenceImages: 'optional' },
    };
    const out = resolveFrameAssignment(model, sb('start', 'end', 'ref1'));
    expect(out.startFrameId).toBe('start');
    expect(out.referenceImageIds).toEqual(['end', 'ref1']);
  });

  it('defaults start→frame 1, end→frame 2, rest→references', async () => {
    const { resolveFrameAssignment } = await import('../src/fal/videoModels.js');
    const model = {
      inputs: { startFrame: 'required', endFrame: 'optional', referenceImages: 'optional' },
    };
    const out = resolveFrameAssignment(model, sb('f0', 'f1', 'f2'));
    expect(out.startFrameId).toBe('f0');
    expect(out.endFrameId).toBe('f1');
    expect(out.referenceImageIds).toEqual(['f2']);
  });

  it('honors an explicit requested assignment and drops unknown ids', async () => {
    const { resolveFrameAssignment } = await import('../src/fal/videoModels.js');
    const model = {
      inputs: { startFrame: 'required', endFrame: 'optional', referenceImages: 'optional' },
    };
    const out = resolveFrameAssignment(model, sb('f0', 'f1', 'f2'), {
      start_frame: 'f2',
      end_frame: 'f0',
      ref: ['f1', 'nope', 'f1'],
    });
    expect(out.startFrameId).toBe('f2');
    expect(out.endFrameId).toBe('f0');
    expect(out.referenceImageIds).toEqual(['f1']); // unknown dropped, deduped
  });

  it('handles empty/missing frames gracefully', async () => {
    const { resolveFrameAssignment } = await import('../src/fal/videoModels.js');
    expect(resolveFrameAssignment(slotless(), {}).referenceImageIds).toEqual([]);
    expect(
      resolveFrameAssignment(slotless(), sb('start')).referenceImageIds,
    ).toEqual(['start']);
  });
});
