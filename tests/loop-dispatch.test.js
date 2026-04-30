import { describe, it, expect, vi } from 'vitest';
import { dispatchToolUses } from '../src/agent/loop.js';

// Suppress noisy expected-warning output.
vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

describe('dispatchToolUses error isolation', () => {
  it('emits a tool_result for every tool_use_id even when one dispatch throws', async () => {
    const dispatchFn = async (name) => {
      if (name === 'will_throw') throw new Error('boom');
      return `ok:${name}`;
    };
    const toolUses = [
      { id: 'use_a', name: 'first_ok', input: {} },
      { id: 'use_b', name: 'will_throw', input: {} },
      { id: 'use_c', name: 'third_ok', input: {} },
    ];

    const results = await dispatchToolUses(toolUses, [], null, dispatchFn);

    expect(results).toHaveLength(3);
    const byId = Object.fromEntries(results.map((r) => [r.tool_use_id, r]));
    expect(byId.use_a.content).toBe('ok:first_ok');
    expect(byId.use_a.is_error).toBeUndefined();
    expect(byId.use_b.content).toMatch(/Tool error \(will_throw\): boom/);
    expect(byId.use_b.is_error).toBe(true);
    expect(byId.use_c.content).toBe('ok:third_ok');
  });

  it('passes attachment-sentinel results through to attachmentPaths', async () => {
    const dispatchFn = async (name) => {
      if (name === 'pdf') return '__PDF_PATH__:/tmp/foo.pdf';
      if (name === 'img') return '__IMAGE_PATH__:/tmp/bar.png|here it is';
      return 'plain';
    };
    const attachmentPaths = [];
    const results = await dispatchToolUses(
      [
        { id: 'a', name: 'pdf', input: {} },
        { id: 'b', name: 'img', input: {} },
        { id: 'c', name: 'plain', input: {} },
      ],
      attachmentPaths,
      null,
      dispatchFn,
    );

    expect(attachmentPaths).toEqual(['/tmp/foo.pdf', '/tmp/bar.png']);
    expect(results[0].content).toBe('PDF generated and queued for upload.');
    expect(results[1].content).toBe('here it is');
    expect(results[2].content).toBe('plain');
  });

  it('returns an empty array when given no tool_uses', async () => {
    const results = await dispatchToolUses([], []);
    expect(results).toEqual([]);
  });
});
