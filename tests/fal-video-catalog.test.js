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

  it('refuses to auto-wire endpoints outside the allowlist', async () => {
    const { getVideoModelOrCatalog } = await import('../src/fal/videoModels.js');
    // Kling 1 is in the catalog but NOT in the allowlist; should resolve to
    // null (preview) unless it happens to also be in VIDEO_MODELS.
    const m = await getVideoModelOrCatalog('fal-ai/kling-video/v1/standard/image-to-video');
    expect(m).toBeNull();
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

  it('validateStoryboardInputs flags missing reference images', async () => {
    const { validateStoryboardInputs } = await import('../src/fal/videoModels.js');
    const model = {
      inputs: {
        startFrame: 'unused',
        endFrame: 'unused',
        characterSheet: 'unused',
        characterElements: 'unused',
        referenceImages: 'required',
        audio: 'unused',
      },
    };
    expect(validateStoryboardInputs(model, { reference_image_ids: [] })).toEqual(['reference images']);
    expect(validateStoryboardInputs(model, { reference_image_ids: ['abc'] })).toEqual([]);
  });
});
