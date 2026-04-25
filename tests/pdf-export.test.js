import { describe, it, expect } from 'vitest';
import { renderScreenplayPdf } from '../src/pdf/export.js';

describe('renderScreenplayPdf', () => {
  it('produces a non-empty PDF buffer', async () => {
    const buf = await renderScreenplayPdf({
      title: 'Test',
      characters: [{
        name: 'Alice', plays_self: true, hollywood_actor: null, own_voice: true,
        fields: { background_story: 'Once upon a time.' },
      }],
      plot: { synopsis: 'A test.', beats: [{ order: 1, title: 'Open', description: 'It begins.' }], notes: '' },
    });
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });
});
