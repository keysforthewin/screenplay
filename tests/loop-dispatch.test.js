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

  it('parses 3-segment sentinels into attachmentLinks (image + attachment)', async () => {
    const imgId = 'a'.repeat(24);
    const attId = 'b'.repeat(24);
    const dispatchFn = async (name) => {
      if (name === 'img') return `__IMAGE_PATH__:/tmp/img.png|note here|${imgId}`;
      if (name === 'att') return `__ATTACHMENT_PATH__:/tmp/file.ogg|got the recording|${attId}`;
      return 'plain';
    };
    const attachmentPaths = [];
    const attachmentLinks = [];
    const results = await dispatchToolUses(
      [
        { id: 'a', name: 'img', input: {} },
        { id: 'b', name: 'att', input: {} },
      ],
      attachmentPaths,
      null,
      dispatchFn,
      null,
      attachmentLinks,
    );

    expect(attachmentPaths).toEqual(['/tmp/img.png', '/tmp/file.ogg']);
    expect(attachmentLinks).toHaveLength(2);
    expect(attachmentLinks[0]).toMatch(new RegExp(`/image/${imgId}$`));
    expect(attachmentLinks[1]).toMatch(new RegExp(`/attachment/${attId}$`));
    expect(results[0].content).toBe('note here');
    expect(results[1].content).toBe('got the recording');
  });

  it('treats trailing non-hex segment as part of the note (no link)', async () => {
    const dispatchFn = async () => '__IMAGE_PATH__:/tmp/x.png|some|long|note text';
    const attachmentPaths = [];
    const attachmentLinks = [];
    const results = await dispatchToolUses(
      [{ id: 'a', name: 'img', input: {} }],
      attachmentPaths,
      null,
      dispatchFn,
      null,
      attachmentLinks,
    );
    expect(attachmentPaths).toEqual(['/tmp/x.png']);
    expect(attachmentLinks).toEqual([]);
    expect(results[0].content).toBe('some|long|note text');
  });

  it('keeps backward compatibility with 2-segment image sentinels (no link)', async () => {
    const dispatchFn = async () => '__IMAGE_PATH__:/tmp/x.png|here it is';
    const attachmentPaths = [];
    const attachmentLinks = [];
    await dispatchToolUses(
      [{ id: 'a', name: 'img', input: {} }],
      attachmentPaths,
      null,
      dispatchFn,
      null,
      attachmentLinks,
    );
    expect(attachmentPaths).toEqual(['/tmp/x.png']);
    expect(attachmentLinks).toEqual([]);
  });

  it('parses __IMAGE_PATHS__ batch sentinel with parallel ids', async () => {
    const id1 = '0'.repeat(24);
    const id2 = '1'.repeat(24);
    const dispatchFn = async () =>
      `__IMAGE_PATHS__:/tmp/a.png\t/tmp/b.png|two images|${id1}\t${id2}`;
    const attachmentPaths = [];
    const attachmentLinks = [];
    const results = await dispatchToolUses(
      [{ id: 'a', name: 'imgs', input: {} }],
      attachmentPaths,
      null,
      dispatchFn,
      null,
      attachmentLinks,
    );
    expect(attachmentPaths).toEqual(['/tmp/a.png', '/tmp/b.png']);
    expect(attachmentLinks).toHaveLength(2);
    expect(attachmentLinks[0]).toMatch(new RegExp(`/image/${id1}$`));
    expect(attachmentLinks[1]).toMatch(new RegExp(`/image/${id2}$`));
    expect(results[0].content).toBe('two images');
  });

  it('handles __ATTACHMENT_PATH__ with no id (no link, just path + note)', async () => {
    const dispatchFn = async () => '__ATTACHMENT_PATH__:/tmp/t.bin|bytes';
    const attachmentPaths = [];
    const attachmentLinks = [];
    const results = await dispatchToolUses(
      [{ id: 'a', name: 'att', input: {} }],
      attachmentPaths,
      null,
      dispatchFn,
      null,
      attachmentLinks,
    );
    expect(attachmentPaths).toEqual(['/tmp/t.bin']);
    expect(attachmentLinks).toEqual([]);
    expect(results[0].content).toBe('bytes');
  });
});
