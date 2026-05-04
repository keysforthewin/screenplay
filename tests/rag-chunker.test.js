import { describe, it, expect } from 'vitest';
import { chunkMarkdown } from '../src/rag/chunker.js';

function len(s) { return s ? s.length : 0; }

describe('chunkMarkdown', () => {
  it('returns [] on empty / whitespace input', () => {
    expect(chunkMarkdown('')).toEqual([]);
    expect(chunkMarkdown('   \n\n\t')).toEqual([]);
    expect(chunkMarkdown(null)).toEqual([]);
    expect(chunkMarkdown(undefined)).toEqual([]);
  });

  it('produces a single chunk for short input', () => {
    const md = 'Alice and Bob argue at the diner.';
    const chunks = chunkMarkdown(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text_md).toBe(md);
  });

  it('packs multiple paragraphs up to target token budget', () => {
    const para = 'Sentence. '.repeat(40); // ~400 chars ≈ 100 tokens
    const md = Array.from({ length: 10 }, (_, i) => `Para ${i}\n\n${para}`).join('\n\n');
    const chunks = chunkMarkdown(md, { targetTokens: 200, maxTokens: 400, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(len(c.text_md) / 4).toBeLessThanOrEqual(500);
    }
  });

  it('does not split a fenced code block, even when oversize', () => {
    const huge = 'x'.repeat(4000);
    const md = `Hello\n\n\`\`\`\n${huge}\n\`\`\`\n\nWorld`;
    const chunks = chunkMarkdown(md, { targetTokens: 100, maxTokens: 200 });
    const codeChunks = chunks.filter((c) => c.text_md.includes(huge));
    expect(codeChunks).toHaveLength(1);
    expect(codeChunks[0].text_md).toContain('```');
  });

  it('keeps a heading travelling with the next block (heading affinity)', () => {
    const para = 'Sentence. '.repeat(60);
    const md = `Filler.\n\n${para}\n\n# Section Two\n\nFollowing paragraph.`;
    const chunks = chunkMarkdown(md, { targetTokens: 80, maxTokens: 200, overlapTokens: 0 });
    // Heading should not be the lonely tail of a chunk; it should head a chunk.
    for (const c of chunks) {
      const lines = c.text_md.split('\n').filter((l) => l.trim());
      const last = lines[lines.length - 1] || '';
      expect(/^#/.test(last)).toBe(false);
    }
    const withHeading = chunks.find((c) => c.text_md.includes('# Section Two'));
    expect(withHeading).toBeTruthy();
    expect(withHeading.text_md.includes('Following paragraph.')).toBe(true);
  });

  it('handles CRLF input the same as LF', () => {
    const lf = 'Para one.\n\nPara two.';
    const crlf = 'Para one.\r\n\r\nPara two.';
    expect(chunkMarkdown(lf)).toEqual(chunkMarkdown(crlf));
  });

  it('overlap=0 produces no extra carryover, overlap>0 enlarges total content', () => {
    const a = 'Paragraph A. '.repeat(80);
    const b = 'Paragraph B. '.repeat(80);
    const md = `${a}\n\n${b}`;
    const noOverlap = chunkMarkdown(md, { targetTokens: 200, maxTokens: 400, overlapTokens: 0 });
    const withOverlap = chunkMarkdown(md, { targetTokens: 200, maxTokens: 400, overlapTokens: 32 });
    const sumLen = (xs) => xs.reduce((n, c) => n + c.text_md.length, 0);
    expect(noOverlap.length).toBeGreaterThanOrEqual(2);
    expect(withOverlap.length).toBeGreaterThanOrEqual(2);
    expect(sumLen(withOverlap)).toBeGreaterThanOrEqual(sumLen(noOverlap));
  });
});
