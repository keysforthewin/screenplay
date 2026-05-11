// Tests for the DashScope Wan 2.7 client wrapper. fetch() is mocked
// per-test so we can assert request shape (URL, headers, body) without
// actually hitting Alibaba.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const realFetch = global.fetch;

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock;
});
afterEach(() => {
  global.fetch = realFetch;
});

async function freshWan({ apiKey = 'sk-test', baseUrl } = {}) {
  process.env.DASHSCOPE_API_KEY = apiKey || '';
  if (baseUrl) process.env.WAN_BASE_URL = baseUrl;
  else delete process.env.WAN_BASE_URL;
  // Force a fresh module evaluation so the config snapshot it captures
  // reflects the env we just set.
  vi.resetModules();
  return await import('../src/wan/client.js');
}

function fetchResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k) => headers[k.toLowerCase()] || null,
    },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    arrayBuffer: async () => (body instanceof Uint8Array ? body.buffer : new ArrayBuffer(0)),
  };
}

describe('wan/client', () => {
  it('isConfigured() reflects the env var', async () => {
    const a = await freshWan({ apiKey: '' });
    expect(a.isConfigured()).toBe(false);
    const b = await freshWan({ apiKey: 'sk-real' });
    expect(b.isConfigured()).toBe(true);
  });

  it('submitImageToVideo posts the documented request shape', async () => {
    const wan = await freshWan({ apiKey: 'sk-1' });
    fetchMock.mockResolvedValueOnce(
      fetchResponse({
        output: { task_status: 'PENDING', task_id: 'task-123' },
        request_id: 'req-1',
      }),
    );

    const result = await wan.submitImageToVideo({
      prompt: 'Hero walks into the room.',
      firstFrameUrl: 'https://oss/start.png',
      lastFrameUrl: 'https://oss/end.png',
      refImageUrl: 'https://oss/sheet.png',
      audioUrl: 'https://oss/audio.mp3',
      durationSeconds: 6,
      resolution: '720P',
    });

    expect(result.task_id).toBe('task-123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis',
    );
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-1');
    expect(init.headers['X-DashScope-Async']).toBe('enable');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('wan2.7-i2v');
    expect(body.input).toMatchObject({
      prompt: 'Hero walks into the room.',
      first_frame_url: 'https://oss/start.png',
      last_frame_url: 'https://oss/end.png',
      ref_image_url: 'https://oss/sheet.png',
      audio_url: 'https://oss/audio.mp3',
    });
    expect(body.parameters).toMatchObject({
      resolution: '720P',
      duration: 6,
      prompt_extend: true,
    });
  });

  it('submitImageToVideo throws a clear error when the API returns a non-2xx', async () => {
    const wan = await freshWan({ apiKey: 'sk-1' });
    fetchMock.mockResolvedValueOnce(
      fetchResponse({ message: 'Invalid first_frame_url' }, { status: 400 }),
    );
    await expect(
      wan.submitImageToVideo({
        prompt: 'p',
        firstFrameUrl: 'https://oss/start.png',
      }),
    ).rejects.toThrow(/Invalid first_frame_url/);
  });

  it('submitImageToVideo throws MISSING_KEY message when the key is absent', async () => {
    const wan = await freshWan({ apiKey: '' });
    await expect(
      wan.submitImageToVideo({
        prompt: 'p',
        firstFrameUrl: 'https://oss/start.png',
      }),
    ).rejects.toThrow(/DashScope API key not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getTask returns normalized status + video_url on SUCCEEDED', async () => {
    const wan = await freshWan({ apiKey: 'sk-1' });
    fetchMock.mockResolvedValueOnce(
      fetchResponse({
        output: {
          task_status: 'SUCCEEDED',
          video_url: 'https://oss-result/abc.mp4?Expires=...',
        },
      }),
    );
    const r = await wan.getTask('task-123');
    expect(r.status).toBe('SUCCEEDED');
    expect(r.video_url).toBe('https://oss-result/abc.mp4?Expires=...');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://dashscope-intl.aliyuncs.com/api/v1/tasks/task-123');
    expect(init?.headers?.Authorization).toBe('Bearer sk-1');
  });

  it('getTask returns FAILED status with error_message', async () => {
    const wan = await freshWan({ apiKey: 'sk-1' });
    fetchMock.mockResolvedValueOnce(
      fetchResponse({
        output: { task_status: 'FAILED', message: 'invalid audio format' },
      }),
    );
    const r = await wan.getTask('task-bad');
    expect(r.status).toBe('FAILED');
    expect(r.error_message).toMatch(/invalid audio format/);
  });

  it('downloadVideo returns the response bytes', async () => {
    const wan = await freshWan({ apiKey: 'sk-1' });
    const payload = new Uint8Array([0, 1, 2, 3, 4, 5]);
    fetchMock.mockResolvedValueOnce(
      fetchResponse(payload, {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      }),
    );
    const r = await wan.downloadVideo('https://oss-result/abc.mp4');
    expect(r.contentType).toBe('video/mp4');
    expect(r.buffer).toBeInstanceOf(Buffer);
    expect(Array.from(r.buffer)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('respects WAN_BASE_URL override', async () => {
    const wan = await freshWan({
      apiKey: 'sk-1',
      baseUrl: 'https://dashscope.aliyuncs.com',
    });
    fetchMock.mockResolvedValueOnce(
      fetchResponse({ output: { task_status: 'PENDING', task_id: 't' } }),
    );
    await wan.submitImageToVideo({
      prompt: 'p',
      firstFrameUrl: 'https://oss/start.png',
    });
    const [url] = fetchMock.mock.calls[0];
    expect(url.startsWith('https://dashscope.aliyuncs.com')).toBe(true);
  });
});
