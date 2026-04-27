import { describe, it, expect, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';
import { runJsInVm } from '../src/agent/codeRunner.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { HANDLERS } = await import('../src/agent/handlers.js');

describe('runJsInVm (direct)', () => {
  it('captures stdout from console.log', () => {
    const r = runJsInVm('console.log(1 + 1)');
    expect(r.stdout).toBe('2\n');
    expect(r.stderr).toBe('');
    expect(r.timed_out).toBe(false);
    expect(r.error).toBeNull();
  });

  it('returns the value of the final expression', () => {
    const r = runJsInVm('40 + 2');
    expect(r.return_value).toBe('42');
  });

  it('serializes object return values as JSON', () => {
    const r = runJsInVm('({ ok: true, n: 7 })');
    expect(r.return_value).toBe('{"ok":true,"n":7}');
  });

  it('preserves order across multiple console.log calls', () => {
    const r = runJsInVm("console.log('a'); console.log('b'); console.log('c')");
    expect(r.stdout).toBe('a\nb\nc\n');
  });

  it('routes console.error to stderr', () => {
    const r = runJsInVm("console.error('boom')");
    expect(r.stderr).toBe('boom\n');
    expect(r.stdout).toBe('');
  });

  it('reports a SyntaxError for invalid code', () => {
    const r = runJsInVm('1 +');
    expect(r.error).toMatch(/SyntaxError/);
    expect(r.timed_out).toBe(false);
  });

  it('captures thrown errors', () => {
    const r = runJsInVm('throw new Error("nope")');
    expect(r.error).toBe('Error: nope');
  });

  it('times out a synchronous infinite loop', () => {
    const start = Date.now();
    const r = runJsInVm('while(true){}', { timeoutMs: 200 });
    const elapsed = Date.now() - start;
    expect(r.timed_out).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });

  it('truncates large stdout at maxOutputBytes', () => {
    const code = 'for (let i = 0; i < 10000; i++) console.log("x".repeat(100))';
    const r = runJsInVm(code, { maxOutputBytes: 8192 });
    expect(r.stdout_truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(8192);
  });

  it('truncates large stderr at maxOutputBytes', () => {
    const code = 'for (let i = 0; i < 10000; i++) console.error("y".repeat(100))';
    const r = runJsInVm(code, { maxOutputBytes: 4096 });
    expect(r.stderr_truncated).toBe(true);
    expect(r.stderr.length).toBeLessThanOrEqual(4096);
  });

  describe('sandbox isolation', () => {
    it('does not expose process', () => {
      const r = runJsInVm('typeof process');
      expect(r.return_value).toBe('"undefined"');
    });
    it('does not expose require', () => {
      const r = runJsInVm('typeof require');
      expect(r.return_value).toBe('"undefined"');
    });
    it('does not expose setTimeout', () => {
      const r = runJsInVm('typeof setTimeout');
      expect(r.return_value).toBe('"undefined"');
    });
    it('does not expose setInterval', () => {
      const r = runJsInVm('typeof setInterval');
      expect(r.return_value).toBe('"undefined"');
    });
    it('does not expose Buffer (errors on direct use)', () => {
      const r = runJsInVm('Buffer.from("hi")');
      expect(r.error).toMatch(/Buffer is not defined/);
    });
    it('does not expose fetch', () => {
      const r = runJsInVm('typeof fetch');
      expect(r.return_value).toBe('"undefined"');
    });
    it('language built-ins still work', () => {
      const r = runJsInVm(
        'JSON.stringify({ pi: Math.PI.toFixed(4), arr: [3,1,2].sort() })',
      );
      expect(r.return_value).toBe('"{\\"pi\\":\\"3.1416\\",\\"arr\\":[1,2,3]}"');
    });
  });

  it('reports duration_ms', () => {
    const r = runJsInVm('1');
    expect(typeof r.duration_ms).toBe('number');
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

describe('run_code handler', () => {
  it('executes code and returns a JSON-stringified result', async () => {
    const out = JSON.parse(await HANDLERS.run_code({ code: 'console.log("hi")' }));
    expect(out.stdout).toBe('hi\n');
    expect(out.error).toBeNull();
    expect(out.timed_out).toBe(false);
  });

  it('honors timeout_ms passed through', async () => {
    const out = JSON.parse(
      await HANDLERS.run_code({ code: 'while(true){}', timeout_ms: 150 }),
    );
    expect(out.timed_out).toBe(true);
  });

  it('returns an error string when code is missing', async () => {
    const out = await HANDLERS.run_code({});
    expect(out).toBe('run_code error: `code` is required.');
  });

  it('returns an error string when code is empty', async () => {
    const out = await HANDLERS.run_code({ code: '   ' });
    expect(out).toBe('run_code error: `code` is required.');
  });

  it('solves a sample algorithmic problem', async () => {
    const code = `
      const xs = [17, 3, 92, 8, 41];
      console.log(xs.toSorted((a, b) => b - a).join(','));
    `;
    const out = JSON.parse(await HANDLERS.run_code({ code }));
    expect(out.stdout).toBe('92,41,17,8,3\n');
  });
});
