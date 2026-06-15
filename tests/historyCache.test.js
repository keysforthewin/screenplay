import { describe, it, expect } from 'vitest';
import { withMessageCacheBreakpoint } from '../src/agent/historyCache.js';

// Count how many content blocks across the whole history carry a cache_control
// marker, and return the [messageIndex, blockIndex] of each.
function markers(history) {
  const out = [];
  history.forEach((m, mi) => {
    if (!Array.isArray(m.content)) return;
    m.content.forEach((b, bi) => {
      if (b && b.cache_control) out.push([mi, bi]);
    });
  });
  return out;
}

const block = (n) => Array.from({ length: n }, (_, i) => ({ type: 'text', text: `b${i}` }));
const userMsg = (n) => ({ role: 'user', content: block(n) });

describe('withMessageCacheBreakpoint', () => {
  it('returns the history untouched when empty or non-array', () => {
    expect(withMessageCacheBreakpoint([])).toEqual([]);
    expect(withMessageCacheBreakpoint(null)).toBeNull();
  });

  it('places no marker when no message has array content', () => {
    const history = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    expect(markers(withMessageCacheBreakpoint(history))).toEqual([]);
  });

  it('marks only the tail when history is short (single breakpoint)', () => {
    const history = [userMsg(1), { role: 'assistant', content: 'ok' }, userMsg(2)];
    const out = withMessageCacheBreakpoint(history);
    const m = markers(out);
    // Only the last array-content message (index 2), on its last block.
    expect(m).toEqual([[2, 1]]);
  });

  it('does not mutate the input history', () => {
    const history = [userMsg(2)];
    withMessageCacheBreakpoint(history);
    expect(history[0].content[1].cache_control).toBeUndefined();
  });

  it('adds a second breakpoint ~15 blocks back for long turns (20-block lookback safety)', () => {
    // Five messages of 8 blocks each = 40 flattened blocks. The tail is marked,
    // and a second breakpoint lands once ~15 blocks have accumulated walking back.
    const history = [userMsg(8), userMsg(8), userMsg(8), userMsg(8), userMsg(8)];
    const m = markers(withMessageCacheBreakpoint(history));
    expect(m).toHaveLength(2);
    // Tail breakpoint on the last message.
    expect(m).toContainEqual([4, 7]);
    // Second breakpoint is an earlier message boundary, and the gap to the tail
    // is >= 15 blocks (so the next iteration can still find a prior entry).
    const earlier = m.find(([mi]) => mi !== 4);
    expect(earlier).toBeDefined();
    const [emi] = earlier;
    const gap = history.slice(emi + 1).reduce((s, msg) => s + msg.content.length, 0);
    expect(gap).toBeGreaterThanOrEqual(15);
  });

  it('never exceeds maxBreakpoints', () => {
    const history = Array.from({ length: 10 }, () => userMsg(8));
    expect(markers(withMessageCacheBreakpoint(history, 2))).toHaveLength(2);
    expect(markers(withMessageCacheBreakpoint(history, 1))).toHaveLength(1);
  });
});
