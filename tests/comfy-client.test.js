// The comfy-mcp client wrapper: tool-result parsing, error mapping, the
// unconfigured guard and the test seam. No child process is ever spawned.

process.env.COMFYUI_URL = '';

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const C = await import('../src/comfy/client.js');

beforeEach(() => {
  C._setComfyClientForTests(null);
});

describe('parseToolResult', () => {
  it('parses the JSON text block', () => {
    const out = C.parseToolResult('server_info', {
      content: [{ type: 'text', text: JSON.stringify({ server: { running: true } }) }],
    });
    expect(out).toEqual({ server: { running: true } });
  });

  it('returns the raw string when the text is not JSON', () => {
    expect(C.parseToolResult('x', { content: [{ type: 'text', text: 'plain words' }] })).toBe('plain words');
  });

  it('falls back to structuredContent when there is no text', () => {
    expect(C.parseToolResult('x', { content: [], structuredContent: { a: 1 } })).toEqual({ a: 1 });
  });

  it('throws ComfyToolError carrying the tool name on isError results', () => {
    let err;
    try {
      C.parseToolResult('run_workflow', {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ message: 'spend_consent_required: paid workflow' }) }],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(C.ComfyToolError);
    expect(err.tool).toBe('run_workflow');
    expect(err.message).toContain('spend_consent_required');
  });
});

describe('configuration + seam', () => {
  it('is unconfigured without COMFYUI_URL and refuses to spawn', async () => {
    expect(C.isComfyConfigured()).toBe(false);
    await expect(C.getComfyClient()).rejects.toBeInstanceOf(C.ComfyNotConfiguredError);
    await expect(C.comfy.serverInfo()).rejects.toMatchObject({ status: 503 });
  });

  it('routes every wrapper through the fake client with the documented arguments', async () => {
    const calls = [];
    C._setComfyClientForTests({
      async callTool(name, args) {
        calls.push({ name, args });
        return { ok: true, name };
      },
    });
    expect(C.isComfyConfigured()).toBe(true);
    await C.comfy.serverInfo();
    await C.comfy.fetchTemplate('video_ltx2_5_i2v', '/tmp/x.json');
    await C.comfy.setWorkflowSlot('/tmp/x.json', [{ address: '398.value', value: 'hi' }]);
    await C.comfy.uploadFile(['/tmp/a.png']);
    await C.comfy.runWorkflow('/tmp/x.json', { confirmSpend: true });
    await C.comfy.job('status', 'p1');
    await C.comfy.job('wait', 'p1', 30);
    await C.comfy.fetchOutputs('p1', '/tmp/out');
    expect(calls.map((c) => c.name)).toEqual([
      'server_info',
      'fetch_template',
      'set_workflow_slot',
      'upload_file',
      'run_workflow',
      'job',
      'job',
      'fetch_outputs',
    ]);
    expect(calls[1].args).toEqual({ name: 'video_ltx2_5_i2v', out_path: '/tmp/x.json', check_local: true });
    expect(calls[2].args).toEqual({ workflow_path: '/tmp/x.json', overrides: [{ address: '398.value', value: 'hi' }], stdout: false });
    expect(calls[3].args).toEqual({ paths: ['/tmp/a.png'], overwrite: true });
    expect(calls[4].args).toMatchObject({ workflow_path: '/tmp/x.json', wait: false, confirm_spend: true });
    expect(calls[5].args).toEqual({ action: 'status', prompt_id: 'p1' });
    expect(calls[6].args).toEqual({ action: 'wait', prompt_id: 'p1', timeout_seconds: 30 });
    expect(calls[7].args).toEqual({ prompt_id: 'p1', out_dir: '/tmp/out' });
  });
});
