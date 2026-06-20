import { describe, it, expect } from 'vitest';
import { webChannelId, reconstructDisplayTranscript } from '../src/web/chatHistory.js';

describe('webChannelId', () => {
  it('builds a per-project, per-username channel id', () => {
    expect(webChannelId('abc123', 'Steve')).toBe('web:abc123:Steve');
  });
  it('falls back to "web visitor" and trims', () => {
    expect(webChannelId('abc123', '  ')).toBe('web:abc123:web visitor');
    expect(webChannelId('abc123', undefined)).toBe('web:abc123:web visitor');
    expect(webChannelId('abc123', '  Ann ')).toBe('web:abc123:Ann');
  });
  it('isolates different usernames and different projects', () => {
    expect(webChannelId('p1', 'a')).not.toBe(webChannelId('p1', 'b'));
    expect(webChannelId('p1', 'a')).not.toBe(webChannelId('p2', 'a'));
  });
});

describe('reconstructDisplayTranscript', () => {
  it('keeps plain user + assistant text, drops tool plumbing and empties', () => {
    const docs = [
      { role: 'user', content: 'add a beat' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'On it.' },
          { type: 'tool_use', id: 't1', name: 'create_beat', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done — added beat 3.' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'x', input: {} }] },
    ];
    expect(reconstructDisplayTranscript(docs)).toEqual([
      { role: 'user', text: 'add a beat' },
      { role: 'assistant', text: 'On it.' },
      { role: 'assistant', text: 'Done — added beat 3.' },
    ]);
  });
});
