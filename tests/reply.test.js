import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from '../src/config.js';
import { partitionAttachableFiles, sendReply } from '../src/discord/reply.js';
import { logger } from '../src/log.js';

let tmpDir;

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'screenplay-reply-test-'));
});

afterAll(async () => {
  if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true });
});

async function writeFixture(name, bytes) {
  const p = path.join(tmpDir, name);
  await fsp.writeFile(p, Buffer.alloc(bytes, 'x'));
  return p;
}

describe('partitionAttachableFiles', () => {
  it('keeps a file that fits under the limit', async () => {
    const small = await writeFixture('small.pdf', 100);
    const { attachable, oversized } = partitionAttachableFiles([small], 1000);
    expect(attachable).toEqual([small]);
    expect(oversized).toEqual([]);
  });

  it('moves a file that exceeds the limit into oversized', async () => {
    const big = await writeFixture('big.pdf', 2000);
    const { attachable, oversized } = partitionAttachableFiles([big], 1000);
    expect(attachable).toEqual([]);
    expect(oversized).toHaveLength(1);
    expect(oversized[0].path).toBe(big);
    expect(oversized[0].size).toBe(2000);
  });

  it('greedily attaches a small tail file even after an oversized middle file', async () => {
    const a = await writeFixture('a.pdf', 600);
    const b = await writeFixture('b.pdf', 800);
    const c = await writeFixture('c.pdf', 200);
    const { attachable, oversized } = partitionAttachableFiles([a, b, c], 1000);
    expect(attachable).toEqual([a, c]);
    expect(oversized).toHaveLength(1);
    expect(oversized[0].path).toBe(b);
  });

  it('skips files that cannot be stat-ed and logs a warning', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { attachable, oversized } = partitionAttachableFiles(
      [path.join(tmpDir, 'does-not-exist.pdf')],
      1000,
    );
    expect(attachable).toEqual([]);
    expect(oversized).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reads the limit from DISCORD_ATTACHMENT_LIMIT_BYTES when no limit is passed', async () => {
    const big = await writeFixture('env-big.pdf', 2000);
    const prev = process.env.DISCORD_ATTACHMENT_LIMIT_BYTES;
    process.env.DISCORD_ATTACHMENT_LIMIT_BYTES = '1500';
    try {
      const { attachable, oversized } = partitionAttachableFiles([big]);
      expect(attachable).toEqual([]);
      expect(oversized).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.DISCORD_ATTACHMENT_LIMIT_BYTES;
      else process.env.DISCORD_ATTACHMENT_LIMIT_BYTES = prev;
    }
  });
});

describe('sendReply', () => {
  let prevPublicBaseUrl;
  let prevLimit;

  beforeEach(() => {
    prevPublicBaseUrl = config.web.publicBaseUrl;
    prevLimit = process.env.DISCORD_ATTACHMENT_LIMIT_BYTES;
    config.web.publicBaseUrl = 'https://example.com';
  });

  afterEach(() => {
    config.web.publicBaseUrl = prevPublicBaseUrl;
    if (prevLimit === undefined) delete process.env.DISCORD_ATTACHMENT_LIMIT_BYTES;
    else process.env.DISCORD_ATTACHMENT_LIMIT_BYTES = prevLimit;
  });

  it('drops oversized PDFs from attachments but still posts the link footer', async () => {
    const big = await writeFixture('screenplay-1700000000000.pdf', 2000);
    process.env.DISCORD_ATTACHMENT_LIMIT_BYTES = '1000';
    const channel = { send: vi.fn().mockResolvedValue({}) };
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await sendReply(channel, 'here is your screenplay', [big], []);

    expect(channel.send).toHaveBeenCalledTimes(2);
    const firstCall = channel.send.mock.calls[0][0];
    expect(firstCall.content).toBe('here is your screenplay');
    expect(firstCall.files).toEqual([]);

    const footerCall = channel.send.mock.calls[1][0];
    expect(footerCall.content).toContain('File link:');
    expect(footerCall.content).toContain(
      'https://example.com/pdf/screenplay-1700000000000.pdf',
    );

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('attaches a small PDF normally and still posts the footer', async () => {
    const small = await writeFixture('screenplay-1700000000001.pdf', 100);
    const channel = { send: vi.fn().mockResolvedValue({}) };

    await sendReply(channel, 'small reply', [small], []);

    expect(channel.send).toHaveBeenCalledTimes(2);
    const firstCall = channel.send.mock.calls[0][0];
    expect(firstCall.content).toBe('small reply');
    expect(firstCall.files).toHaveLength(1);

    const footerCall = channel.send.mock.calls[1][0];
    expect(footerCall.content).toContain(
      'https://example.com/pdf/screenplay-1700000000001.pdf',
    );
  });

  it('sends only the link footer when the only file is oversized and there is no text', async () => {
    const big = await writeFixture('screenplay-1700000000002.pdf', 2000);
    process.env.DISCORD_ATTACHMENT_LIMIT_BYTES = '1000';
    const channel = { send: vi.fn().mockResolvedValue({}) };
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await sendReply(channel, '', [big], []);

    expect(channel.send).toHaveBeenCalledTimes(1);
    const only = channel.send.mock.calls[0][0];
    expect(only.content).toContain(
      'https://example.com/pdf/screenplay-1700000000002.pdf',
    );

    warn.mockRestore();
  });
});
