import { describe, it, expect } from 'vitest';
import { isRealUserMessage, floorStartIndex } from '../src/util/turns.js';

const userText = (t) => ({ role: 'user', content: t });
const assistantText = (t) => ({ role: 'assistant', content: t });
const toolUse = (id) => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 'x', input: {} }],
});
const toolResult = (id) => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: 'r' }],
});

// A full exchange = user turn, agent tool round-trip, agent reply.
function exchange(n) {
  return [userText(`u${n}`), toolUse(`t${n}`), toolResult(`t${n}`), assistantText(`a${n}`)];
}

describe('isRealUserMessage', () => {
  it('treats a string-content user message as a real turn', () => {
    expect(isRealUserMessage(userText('hi'))).toBe(true);
  });

  it('treats a user message with a text block as a real turn', () => {
    expect(isRealUserMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }] })).toBe(true);
  });

  it('treats a user message of only tool_result blocks as NOT a real turn', () => {
    expect(isRealUserMessage(toolResult('t1'))).toBe(false);
  });

  it('treats assistant messages as NOT a real user turn', () => {
    expect(isRealUserMessage(assistantText('ok'))).toBe(false);
    expect(isRealUserMessage(toolUse('t1'))).toBe(false);
  });
});

describe('floorStartIndex', () => {
  it('returns 0 when there are fewer than minUserTurns user messages', () => {
    const msgs = [...exchange(1), ...exchange(2)]; // 2 user turns
    expect(floorStartIndex(msgs, 6)).toBe(0);
  });

  it('returns 0 for an empty array', () => {
    expect(floorStartIndex([], 6)).toBe(0);
  });

  it('returns the index of the Nth-most-recent user message', () => {
    // 8 exchanges, keep last 6 user turns → floor at the user msg of exchange 3.
    const msgs = [];
    for (let n = 1; n <= 8; n++) msgs.push(...exchange(n));
    const start = floorStartIndex(msgs, 6);
    // exchange 3's user message: each exchange is 4 messages, so index (3-1)*4 = 8.
    expect(start).toBe(8);
    expect(msgs[start]).toEqual(userText('u3'));
    // The kept suffix contains exactly 6 real user turns.
    const kept = msgs.slice(start).filter(isRealUserMessage).length;
    expect(kept).toBe(6);
  });

  it('does not count tool-result-only user messages toward the floor', () => {
    // Only the 2 real user turns count; tool_result messages are skipped.
    const msgs = [...exchange(1), ...exchange(2)];
    expect(floorStartIndex(msgs, 1)).toBe(msgs.length - 4); // last exchange's user msg
    expect(msgs[floorStartIndex(msgs, 1)]).toEqual(userText('u2'));
  });

  it('returns messages.length (no floor) when there are no real user turns', () => {
    // A window of pure agent plumbing has no turns to protect — the floor must
    // not resurrect it, so it returns the length (keep nothing extra).
    const msgs = [toolUse('t1'), toolResult('t1'), assistantText('a1')];
    expect(floorStartIndex(msgs, 6)).toBe(msgs.length);
  });

  it('keeps from the oldest user turn (not leading plumbing) when fewer than the floor', () => {
    // Leading assistant plumbing before the first user message must be excluded.
    const msgs = [assistantText('lead'), ...exchange(1)];
    const start = floorStartIndex(msgs, 6);
    expect(msgs[start]).toEqual(userText('u1'));
    expect(start).toBe(1);
  });
});
