import { describe, it, expect } from 'vitest';
import { docToLlmMessage } from '../src/mongo/messages.js';

describe('docToLlmMessage', () => {
  it('renders an assistant doc as a string-content message', () => {
    const out = docToLlmMessage({ role: 'assistant', content: 'hello there' });
    expect(out).toEqual({ role: 'assistant', content: 'hello there' });
  });

  it('falls back to "(no reply)" when assistant content is empty', () => {
    const out = docToLlmMessage({ role: 'assistant', content: '' });
    expect(out).toEqual({ role: 'assistant', content: '(no reply)' });
  });

  it('renders a user doc with no attachments as a single text block', () => {
    const out = docToLlmMessage({ role: 'user', content: 'hi', attachments: [] });
    expect(out).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    });
  });

  it('renders one [user attached image] placeholder per attachment', () => {
    const out = docToLlmMessage({
      role: 'user',
      content: 'look at these',
      attachments: [
        { url: 'a', filename: 'a.png', content_type: 'image/png', size: 1 },
        { url: 'b', filename: 'b.png', content_type: 'image/png', size: 2 },
      ],
    });
    expect(out).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '[user attached image]' },
        { type: 'text', text: '[user attached image]' },
        { type: 'text', text: 'look at these' },
      ],
    });
  });

  it('handles missing attachments field', () => {
    const out = docToLlmMessage({ role: 'user', content: 'hi' });
    expect(out).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    });
  });

  it('passes through assistant docs whose content is already an array of blocks', () => {
    const blocks = [
      { type: 'text', text: 'Calling tool…' },
      { type: 'tool_use', id: 'tu_1', name: 'list_beats', input: {} },
    ];
    const out = docToLlmMessage({ role: 'assistant', content: blocks });
    expect(out).toEqual({ role: 'assistant', content: blocks });
  });

  it('passes through user docs that hold tool_result blocks', () => {
    const blocks = [{ type: 'tool_result', tool_use_id: 'tu_1', content: '[]' }];
    const out = docToLlmMessage({ role: 'user', content: blocks, attachments: [] });
    expect(out).toEqual({ role: 'user', content: blocks });
  });
});
