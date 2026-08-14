// The image-model catalog: the same fal.ai model database the playground uses,
// narrowed to endpoints that can generate an image from a prompt plus optional
// reference images, and annotated with price for the SPA picker.

import { describe, it, expect } from 'vitest';

const {
  buildImageModelList,
  formatImagePrice,
  isPromptSatisfiable,
  loadImageModelCatalog,
} = await import('../src/fal/imageModelCatalog.js');

// Minimal shape of a data/fal-playground-models.json row.
function row(overrides = {}) {
  return {
    endpoint_id: 'fal-ai/example',
    display_name: 'Example',
    category: 'text-to-image',
    model_lab: 'Example Lab',
    description: 'An example model.',
    output: { kind: 'image', path: 'images[0].url' },
    inputs: {
      prompt: 'required',
      prompt_param: 'prompt',
      image: { need: 'unused', params: [], required_count: 0, max: 0 },
      audio: { need: 'unused', param: null, list: false },
      video: { need: 'unused', param: null, list: false },
    },
    inputs_required: ['prompt'],
    inputs_optional: [],
    pricing: { kind: 'per_image', perImageUsd: 0.04, exact: true },
    ...overrides,
  };
}

describe('isPromptSatisfiable', () => {
  it('accepts a text-to-image model that only needs a prompt', () => {
    expect(isPromptSatisfiable(row())).toBe(true);
  });

  it('accepts an image-to-image model whose required inputs are prompt + image', () => {
    // The live catalog spells image params as {name, list, required} objects.
    expect(isPromptSatisfiable(row({
      category: 'image-to-image',
      inputs: {
        prompt: 'required',
        prompt_param: 'prompt',
        image: {
          need: 'required',
          params: [{ name: 'image_urls', list: true, required: true }],
          required_count: 1,
          max: null,
        },
        audio: { need: 'unused', param: null, list: false },
        video: { need: 'unused', param: null, list: false },
      },
      inputs_required: ['prompt', 'image_urls'],
    }))).toBe(true);
  });

  it('also reads the older bare-string image param shape', () => {
    expect(isPromptSatisfiable(row({
      category: 'image-to-image',
      inputs: {
        ...row().inputs,
        image: { need: 'required', params: ['image_url'], required_count: 1, max: 1 },
      },
      inputs_required: ['prompt', 'image_url'],
    }))).toBe(true);
  });

  it('rejects a model that requires an input we cannot supply', () => {
    expect(isPromptSatisfiable(row({
      inputs_required: ['prompt', 'mask_url'],
    }))).toBe(false);
  });

  it('rejects models that do not output an image', () => {
    expect(isPromptSatisfiable(row({ output: { kind: 'video', path: 'video.url' } }))).toBe(false);
  });

  it('rejects models that require audio or video input', () => {
    expect(isPromptSatisfiable(row({
      inputs: {
        ...row().inputs,
        audio: { need: 'required', param: 'audio_url', list: false },
      },
    }))).toBe(false);
  });

  it('rejects models that consume neither a prompt nor an image', () => {
    // e.g. endpoints driven entirely by their own structured params.
    expect(isPromptSatisfiable(row({
      inputs: {
        prompt: 'unused',
        prompt_param: null,
        image: { need: 'unused', params: [], required_count: 0, max: 0 },
        audio: { need: 'unused', param: null, list: false },
        video: { need: 'unused', param: null, list: false },
      },
      inputs_required: [],
    }))).toBe(false);
  });

  it('rejects non-generation categories such as vision', () => {
    expect(isPromptSatisfiable(row({ category: 'vision' }))).toBe(false);
  });
});

describe('formatImagePrice', () => {
  it('formats a per-image price', () => {
    expect(formatImagePrice({ kind: 'per_image', perImageUsd: 0.04 })).toBe('$0.04 / image');
  });

  it('formats a per-megapixel price', () => {
    expect(formatImagePrice({ kind: 'per_megapixel', perMpUsd: 0.025 })).toBe('$0.025 / MP');
  });

  it('keeps small prices readable rather than rounding them to zero', () => {
    expect(formatImagePrice({ kind: 'per_image', perImageUsd: 0.0015 })).toBe('$0.0015 / image');
  });

  it('returns null when there is no usable price', () => {
    expect(formatImagePrice(null)).toBeNull();
    expect(formatImagePrice({ kind: 'per_image' })).toBeNull();
  });
});

describe('price sort values', () => {
  it('sorts on the number the row displays, whatever the unit', () => {
    // $0.011/MP and $0.04/image are not strictly comparable; sorting on the
    // displayed figure keeps the visible order matching the visible numbers.
    const [perImage] = buildImageModelList([row({
      pricing: { kind: 'per_image', perImageUsd: 0.04, exact: true },
    })]);
    const [perMp] = buildImageModelList([row({
      pricing: { kind: 'per_megapixel', perMpUsd: 0.011, exact: true },
    })]);
    expect(perImage.price.sort_usd).toBe(0.04);
    expect(perMp.price.sort_usd).toBe(0.011);
  });

  it('leaves sort_usd null when there is no price', () => {
    const [m] = buildImageModelList([row({ pricing: null })]);
    expect(m.price.display).toBeNull();
    expect(m.price.sort_usd).toBeNull();
  });

  it('gives every priced model a sort key, and unpriced models none', async () => {
    // The display string and the sort key are derived together, so a row that
    // shows a figure must always be sortable by it, and vice versa — otherwise
    // priced models would silently fall into the unpriced bucket at the bottom.
    const { models } = await loadImageModelCatalog();
    for (const m of models) {
      expect(m.price.display === null).toBe(m.price.sort_usd === null);
      if (m.price.sort_usd !== null) {
        expect(Number.isFinite(m.price.sort_usd)).toBe(true);
        expect(m.price.sort_usd).toBeGreaterThan(0);
      }
    }
    expect(models.filter((m) => m.price.sort_usd !== null).length).toBeGreaterThan(100);
  });
});

describe('buildImageModelList', () => {
  it('drops rows that are not prompt-satisfiable', () => {
    const models = buildImageModelList([
      row({ endpoint_id: 'fal-ai/keep' }),
      row({ endpoint_id: 'fal-ai/drop', inputs_required: ['prompt', 'mask_url'] }),
    ]);
    expect(models.map((m) => m.endpoint_id)).toEqual(['fal-ai/keep']);
  });

  it('exposes lab, category, description and a formatted price', () => {
    const [m] = buildImageModelList([row()]);
    expect(m).toMatchObject({
      id: 'fal-ai/example',
      endpoint_id: 'fal-ai/example',
      display_name: 'Example',
      lab: 'Example Lab',
      category: 'text-to-image',
      description: 'An example model.',
      is_wired: false,
      accepts_references: false,
    });
    expect(m.price.display).toBe('$0.04 / image');
    expect(m.price.per_image_usd).toBe(0.04);
  });

  it('flags models that can consume reference images', () => {
    const [m] = buildImageModelList([row({
      category: 'image-to-image',
      inputs: {
        ...row().inputs,
        image: {
          need: 'optional',
          params: [{ name: 'image_urls', list: true, required: false }],
          required_count: 0,
          max: 4,
        },
      },
    })]);
    expect(m.accepts_references).toBe(true);
    expect(m.max_references).toBe(4);
  });

  it('reports an undocumented reference cap as null rather than zero', () => {
    const [m] = buildImageModelList([row({
      category: 'image-to-image',
      inputs: {
        ...row().inputs,
        image: {
          need: 'required',
          params: [{ name: 'image_urls', list: true, required: true }],
          required_count: 1,
          max: null,
        },
      },
      inputs_required: ['prompt', 'image_urls'],
    })]);
    expect(m.max_references).toBeNull();
  });

  it('submits a wired model under its shortcut id, not its fal endpoint', () => {
    const [m] = buildImageModelList([row({ endpoint_id: 'fal-ai/nano-banana-pro' })], {
      wiredMap: new Map([['fal-ai/nano-banana-pro', 'nano-banana-pro']]),
    });
    expect(m.id).toBe('nano-banana-pro');
    expect(m.endpoint_id).toBe('fal-ai/nano-banana-pro');
    expect(m.is_wired).toBe(true);
  });

  it('collapses a wired model generate/edit pair into one entry', () => {
    const models = buildImageModelList(
      [
        row({ endpoint_id: 'fal-ai/nano-banana-pro' }),
        row({ endpoint_id: 'fal-ai/nano-banana-pro/edit', category: 'image-to-image' }),
      ],
      {
        wiredMap: new Map([
          ['fal-ai/nano-banana-pro', 'nano-banana-pro'],
          ['fal-ai/nano-banana-pro/edit', 'nano-banana-pro'],
        ]),
      },
    );
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('nano-banana-pro');
  });

  it('marks the collapsed wired entry reference-capable from its edit endpoint', () => {
    // The shortcut auto-routes to /edit when references are passed, so the
    // entry must not inherit the text-to-image generate endpoint's "no images".
    // The cap itself comes from the curated pipeline numbers, not the catalog.
    const [m] = buildImageModelList(
      [
        row({ endpoint_id: 'fal-ai/nano-banana-pro' }),
        row({
          endpoint_id: 'fal-ai/nano-banana-pro/edit',
          category: 'image-to-image',
          inputs: {
            ...row().inputs,
            image: { need: 'required', params: ['image_urls'], required_count: 1, max: 6 },
          },
          inputs_required: ['prompt', 'image_urls'],
        }),
      ],
      {
        wiredMap: new Map([
          ['fal-ai/nano-banana-pro', 'nano-banana-pro'],
          ['fal-ai/nano-banana-pro/edit', 'nano-banana-pro'],
        ]),
      },
    );
    expect(m.accepts_references).toBe(true);
    // maxReferenceImagesFor('nano-banana-pro') — the pipeline's own cap.
    expect(m.max_references).toBeGreaterThan(0);
    // …and references stay optional: the generate endpoint needs none.
    expect(m.requires_references).toBe(false);
  });

  it('sorts wired models ahead of the rest of the catalog', () => {
    const models = buildImageModelList(
      [
        row({ endpoint_id: 'fal-ai/aaa-first-alphabetically' }),
        row({ endpoint_id: 'fal-ai/nano-banana-pro' }),
      ],
      { wiredMap: new Map([['fal-ai/nano-banana-pro', 'nano-banana-pro']]) },
    );
    expect(models[0].id).toBe('nano-banana-pro');
  });
});

describe('loadImageModelCatalog (real catalog file)', () => {
  it('returns a non-empty, well-formed model list', async () => {
    const { models, generated_at, catalog_error } = await loadImageModelCatalog();
    expect(catalog_error).toBeFalsy();
    expect(models.length).toBeGreaterThan(50);
    expect(typeof generated_at === 'string' || generated_at === null).toBe(true);
    for (const m of models) {
      expect(typeof m.id).toBe('string');
      expect(m.id.length).toBeGreaterThan(0);
      expect(['text-to-image', 'image-to-image']).toContain(m.category);
      // Catalog-backed rows must know where their image lands in the fal
      // result; the wired fallbacks below don't run through that path.
      if (!m.is_wired) expect(m.output_path).toBeTruthy();
    }
    // Ids must be unique — the SPA keys its list on them and submits them raw.
    expect(new Set(models.map((m) => m.id)).size).toBe(models.length);
  });

  it('includes the hand-wired shortcuts, flagged and submittable by shortcut id', async () => {
    const { models } = await loadImageModelCatalog();
    const wired = models.filter((m) => m.is_wired);
    expect(wired.length).toBeGreaterThan(0);
    expect(wired.map((m) => m.id)).toContain('nano-banana-pro');
  });

  it('keeps every wired shortcut selectable, including ones with no fal row', async () => {
    // OpenAI's gpt-image-2 is not a fal endpoint, so it has no catalog row —
    // it must still appear, or the picker silently drops a working model.
    const { models } = await loadImageModelCatalog();
    const ids = models.map((m) => m.id);
    for (const id of [
      'nano-banana-pro', 'flux-2-pro', 'flux-pro-kontext', 'openai',
      'gemini-25-flash', 'nano-banana-2', 'flux-2-klein',
    ]) {
      expect(ids).toContain(id);
    }
    const openai = models.find((m) => m.id === 'openai');
    expect(openai.is_wired).toBe(true);
    expect(openai.accepts_references).toBe(true);
  });
});
