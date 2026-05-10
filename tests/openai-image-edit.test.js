import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 1×1 transparent PNG.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

vi.mock('../src/config.js', async () => {
  const real = await vi.importActual('../src/config.js');
  return {
    ...real,
    config: {
      ...real.config,
      openai: { apiKey: 'test-openai-key' },
    },
  };
});

const { generateCharacterSheetImageEdit } = await import('../src/openai/imageClient.js');

const realFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
});
afterEach(() => {
  global.fetch = realFetch;
});

function okResponse(b64, usage = null) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ b64_json: b64 }], usage }),
  };
}

describe('generateCharacterSheetImageEdit', () => {
  it('POSTs multipart to /v1/images/edits with the input image and prompt', async () => {
    global.fetch.mockResolvedValueOnce(
      okResponse(TINY_PNG.toString('base64'), {
        input_tokens: 42,
        output_tokens: 100,
        total_tokens: 142,
      }),
    );

    const result = await generateCharacterSheetImageEdit({
      prompt: 'A heroic robot character sheet.',
      inputImage: { buffer: TINY_PNG, contentType: 'image/png' },
      size: '1536x1024',
      quality: 'high',
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];

    expect(url).toBe('https://api.openai.com/v1/images/edits');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-openai-key');
    expect(init.body).toBeInstanceOf(FormData);

    const fd = init.body;
    expect(fd.get('model')).toBe('gpt-image-2');
    expect(fd.get('prompt')).toBe('A heroic robot character sheet.');
    expect(fd.get('size')).toBe('1536x1024');
    expect(fd.get('quality')).toBe('high');

    const imagePart = fd.get('image[]');
    // Native Blob in Node 18+ — has size/type and arrayBuffer().
    expect(imagePart).toBeTruthy();
    expect(imagePart.type).toBe('image/png');
    const partBytes = Buffer.from(await imagePart.arrayBuffer());
    expect(partBytes.equals(TINY_PNG)).toBe(true);

    expect(result.buffer.equals(TINY_PNG)).toBe(true);
    expect(result.contentType).toBe('image/png');
    expect(result.model).toBe('gpt-image-2');
    expect(typeof result.latencyMs).toBe('number');
    expect(result.usage).toEqual({
      input_tokens: 42,
      output_tokens: 100,
      total_tokens: 142,
    });
  });

  it('rejects when prompt is empty', async () => {
    await expect(
      generateCharacterSheetImageEdit({
        prompt: '   ',
        inputImage: { buffer: TINY_PNG, contentType: 'image/png' },
      }),
    ).rejects.toThrow(/prompt/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects when no input images are supplied', async () => {
    await expect(
      generateCharacterSheetImageEdit({ prompt: 'hi' }),
    ).rejects.toThrow(/at least one input image/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('surfaces the OpenAI error message on non-2xx responses', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ error: { message: 'safety system rejected request' } }),
    });

    await expect(
      generateCharacterSheetImageEdit({
        prompt: 'edgy prompt',
        inputImage: { buffer: TINY_PNG, contentType: 'image/png' },
      }),
    ).rejects.toThrow(/HTTP 400.*safety system rejected request/);
  });
});
