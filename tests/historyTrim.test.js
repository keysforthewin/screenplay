import { describe, it, expect } from 'vitest';
import {
  trimHistoryForLlm,
  summarizeStaleToolResults,
  applyTokenBudget,
  estimateMessageTokens,
} from '../src/agent/historyTrim.js';

// A "Discord turn" in this test fixture is:
//   user (string)
//   assistant (with tool_use)
//   user (with tool_result)
//   assistant (with text reply)
function makeTurn({ userText, toolName, toolUseId, toolResultContent, replyText, toolInput = {} }) {
  return [
    { role: 'user', content: userText },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: toolUseId, name: toolName, input: toolInput },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: toolResultContent },
      ],
    },
    { role: 'assistant', content: replyText || 'ok' },
  ];
}

function bigJson(approxChars) {
  return JSON.stringify({ blob: 'x'.repeat(Math.max(0, approxChars - 16)) });
}

function findToolResult(messages, toolUseId) {
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b && b.type === 'tool_result' && b.tool_use_id === toolUseId) return b;
    }
  }
  return null;
}

function unmatchedToolUseIds(messages) {
  const uses = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b && b.type === 'tool_use' && b.id) uses.push({ id: b.id, idx: i });
    }
  }
  const unmatched = [];
  for (const u of uses) {
    const next = messages[u.idx + 1];
    const ok =
      next &&
      next.role === 'user' &&
      Array.isArray(next.content) &&
      next.content.some((b) => b && b.type === 'tool_result' && b.tool_use_id === u.id);
    if (!ok) unmatched.push(u.id);
  }
  return unmatched;
}

describe('summarizeStaleToolResults', () => {
  it('preserves tool_use ↔ tool_result pairing (no blocks deleted)', () => {
    const history = [
      ...makeTurn({ userText: 't1', toolName: 'tavily_search', toolUseId: 'a', toolResultContent: bigJson(8000), replyText: 'r1' }),
      ...makeTurn({ userText: 't2', toolName: 'tavily_search', toolUseId: 'b', toolResultContent: bigJson(8000), replyText: 'r2' }),
      ...makeTurn({ userText: 't3', toolName: 'tavily_search', toolUseId: 'c', toolResultContent: bigJson(8000), replyText: 'r3' }),
      ...makeTurn({ userText: 't4', toolName: 'tavily_search', toolUseId: 'd', toolResultContent: bigJson(8000), replyText: 'r4' }),
    ];
    const { messages: out } = summarizeStaleToolResults(history);
    expect(unmatchedToolUseIds(out)).toEqual([]);
    // Every tool_use_id still has a matching tool_result
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(findToolResult(out, id)).not.toBeNull();
    }
  });

  it('is idempotent', () => {
    const history = [
      ...makeTurn({ userText: 't1', toolName: 'tavily_search', toolUseId: 'a', toolResultContent: bigJson(5000), replyText: 'r1' }),
      ...makeTurn({ userText: 't2', toolName: 'tavily_search', toolUseId: 'b', toolResultContent: bigJson(5000), replyText: 'r2' }),
      ...makeTurn({ userText: 't3', toolName: 'noop_user_msg_to_advance_age', toolUseId: 'c', toolResultContent: 'ok', replyText: 'r3' }),
    ];
    const once = trimHistoryForLlm(history);
    const twice = trimHistoryForLlm(once.messages);
    expect(twice.messages).toEqual(once.messages);
  });

  it('produces stub format for stale always-large tools', () => {
    const history = [
      ...makeTurn({ userText: 't1', toolName: 'tavily_search', toolUseId: 'a', toolResultContent: bigJson(5000), replyText: 'r1' }),
      ...makeTurn({ userText: 't2', toolName: 'noop', toolUseId: 'b', toolResultContent: 'ok', replyText: 'r2' }),
      ...makeTurn({ userText: 't3', toolName: 'noop', toolUseId: 'c', toolResultContent: 'ok', replyText: 'r3' }),
    ];
    const { messages: out } = summarizeStaleToolResults(history);
    const tr = findToolResult(out, 'a');
    expect(typeof tr.content).toBe('string');
    expect(tr.content).toMatch(/^\[Truncated tool_result for tavily_search: \d+ chars/);
  });

  it('leaves always-small tools (calculator) unchanged regardless of age', () => {
    const history = [];
    for (let i = 0; i < 6; i++) {
      history.push(
        ...makeTurn({
          userText: `t${i}`,
          toolName: 'calculator',
          toolUseId: `c${i}`,
          toolResultContent: '{"result":"42"}',
          replyText: `r${i}`,
        }),
      );
    }
    const { messages: out, stats } = summarizeStaleToolResults(history);
    expect(stats.summarized).toBe(0);
    for (let i = 0; i < 6; i++) {
      expect(findToolResult(out, `c${i}`).content).toBe('{"result":"42"}');
    }
  });

  it('keeps the most recent turn (age 0) intact even for huge tool_results', () => {
    const history = [
      ...makeTurn({ userText: 'old', toolName: 'tavily_search', toolUseId: 'a', toolResultContent: bigJson(2000), replyText: 'r1' }),
      ...makeTurn({ userText: 'newest', toolName: 'get_overview', toolUseId: 'b', toolResultContent: bigJson(50000), replyText: 'r2' }),
    ];
    const { messages: out } = summarizeStaleToolResults(history);
    // 'b' is in the most-recent turn → must stay verbatim.
    expect(findToolResult(out, 'b').content).toMatch(/^\{/);
  });

  it('respects ID-yielding age policy: list_beats kept at age 3, stubbed at age 5', () => {
    const turnAtAge = (label, n) =>
      makeTurn({
        userText: label,
        toolName: 'list_beats',
        toolUseId: label,
        toolResultContent: bigJson(3000),
        replyText: 'ok',
      });

    // Build 6 turns. Most recent (age 0) is turn5, oldest is turn0 (age 5).
    const history = [
      ...turnAtAge('turn0_age5'),
      ...turnAtAge('turn1_age4'),
      ...turnAtAge('turn2_age3'),
      ...turnAtAge('turn3_age2'),
      ...turnAtAge('turn4_age1'),
      ...turnAtAge('turn5_age0'),
    ];

    const { messages: out } = summarizeStaleToolResults(history);
    // list_beats stubAtAge = 4 → age 4 and 5 stubbed, age 3 and below intact.
    expect(findToolResult(out, 'turn0_age5').content).toMatch(/^\[Truncated/);
    expect(findToolResult(out, 'turn1_age4').content).toMatch(/^\[Truncated/);
    expect(findToolResult(out, 'turn2_age3').content).not.toMatch(/^\[Truncated/);
    expect(findToolResult(out, 'turn3_age2').content).not.toMatch(/^\[Truncated/);
    expect(findToolResult(out, 'turn4_age1').content).not.toMatch(/^\[Truncated/);
    expect(findToolResult(out, 'turn5_age0').content).not.toMatch(/^\[Truncated/);
  });

  it('preserves is_error: true tool_results verbatim', () => {
    const errorMsg = 'Tool error (tavily_search): rate limited';
    const history = [
      // Age 1: should be eligible by tavily age >= 2 (no), so even without
      // is_error this would be intact. Push it deeper.
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'e1', content: errorMsg, is_error: true },
        ],
      },
      // Synthetic assistant + user with tool_use to keep pairing valid
    ];
    // Build a real history where 'e1' is at age 3 (well past stubAtAge=2 for tavily).
    const built = [
      ...makeTurn({ userText: 't0', toolName: 'tavily_search', toolUseId: 'e1', toolResultContent: errorMsg, replyText: 'r0' }),
      ...makeTurn({ userText: 't1', toolName: 'noop', toolUseId: 'n1', toolResultContent: 'ok', replyText: 'r1' }),
      ...makeTurn({ userText: 't2', toolName: 'noop', toolUseId: 'n2', toolResultContent: 'ok', replyText: 'r2' }),
      ...makeTurn({ userText: 't3', toolName: 'noop', toolUseId: 'n3', toolResultContent: 'ok', replyText: 'r3' }),
    ];
    // Mark 'e1' as is_error
    for (const m of built) {
      if (m.role !== 'user' || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b.tool_use_id === 'e1') b.is_error = true;
      }
    }
    const { messages: out } = summarizeStaleToolResults(built);
    expect(findToolResult(out, 'e1').content).toBe(errorMsg);
    expect(findToolResult(out, 'e1').is_error).toBe(true);
  });

  it('does not double-stub already-stubbed content', () => {
    const history = [
      ...makeTurn({
        userText: 't0',
        toolName: 'tavily_search',
        toolUseId: 'a',
        toolResultContent: '[Truncated tool_result for tavily_search: 8000 chars in original. Re-call tavily_search with the same arguments to retrieve fresh data.]',
        replyText: 'r0',
      }),
      ...makeTurn({ userText: 't1', toolName: 'noop', toolUseId: 'n1', toolResultContent: 'ok', replyText: 'r1' }),
      ...makeTurn({ userText: 't2', toolName: 'noop', toolUseId: 'n2', toolResultContent: 'ok', replyText: 'r2' }),
      ...makeTurn({ userText: 't3', toolName: 'noop', toolUseId: 'n3', toolResultContent: 'ok', replyText: 'r3' }),
    ];
    const { messages: out, stats } = summarizeStaleToolResults(history);
    expect(stats.summarized).toBe(0);
    expect(findToolResult(out, 'a').content).toMatch(/^\[Truncated tool_result for tavily_search: 8000 chars/);
  });

  it('respects sometimes-large size threshold (small get_beat at age 4 kept verbatim)', () => {
    const small = JSON.stringify({ name: 'X', desc: 'short' }); // ~25 chars
    const history = [
      ...makeTurn({ userText: 't0', toolName: 'get_beat', toolUseId: 'a', toolResultContent: small, replyText: 'r0' }),
    ];
    for (let i = 0; i < 5; i++) {
      history.push(
        ...makeTurn({ userText: `t${i + 1}`, toolName: 'noop', toolUseId: `n${i}`, toolResultContent: 'ok', replyText: 'ok' }),
      );
    }
    const { messages: out } = summarizeStaleToolResults(history);
    expect(findToolResult(out, 'a').content).toBe(small);
  });

  it('summarizes sometimes-large get_beat when both old AND fat', () => {
    const fat = bigJson(8000);
    const history = [
      ...makeTurn({ userText: 't0', toolName: 'get_beat', toolUseId: 'a', toolResultContent: fat, replyText: 'r0' }),
    ];
    for (let i = 0; i < 5; i++) {
      history.push(
        ...makeTurn({ userText: `t${i + 1}`, toolName: 'noop', toolUseId: `n${i}`, toolResultContent: 'ok', replyText: 'ok' }),
      );
    }
    const { messages: out } = summarizeStaleToolResults(history);
    expect(findToolResult(out, 'a').content).toMatch(/^\[Truncated tool_result for get_beat/);
  });
});

describe('applyTokenBudget', () => {
  it('cuts oldest messages when over budget and keeps tool pairing valid', () => {
    const history = [];
    for (let i = 0; i < 8; i++) {
      history.push(
        ...makeTurn({
          userText: `t${i}`,
          toolName: 'tavily_search',
          toolUseId: `u${i}`,
          toolResultContent: bigJson(2000),
          replyText: `r${i}`,
        }),
      );
    }
    const before = estimateMessageTokens; // sanity: function exists
    expect(typeof before).toBe('function');

    const { messages: kept, stats } = applyTokenBudget(history, { tokenBudget: 1500 });
    expect(stats.budgetCut).toBeGreaterThan(0);
    // kept should fit roughly under the budget (estimate is approximate, allow slack)
    let total = 0;
    for (const m of kept) total += estimateMessageTokens(m);
    expect(total).toBeLessThanOrEqual(2000); // budget 1500 + at most one full turn balanced in
    // Pairing intact: every tool_use has a matching tool_result.
    expect(unmatchedToolUseIds(kept)).toEqual([]);
  });

  it('returns input unchanged when total tokens are below the budget', () => {
    const history = makeTurn({
      userText: 'small',
      toolName: 'noop',
      toolUseId: 'a',
      toolResultContent: 'ok',
      replyText: 'tiny',
    });
    const { messages: kept, stats } = applyTokenBudget(history, { tokenBudget: 30000 });
    expect(stats.budgetCut).toBe(0);
    expect(kept).toEqual(history);
  });
});

describe('trimHistoryForLlm', () => {
  it('summarize-then-cap keeps strictly more turns than cap-only for big-tool-result histories', () => {
    const history = [];
    for (let i = 0; i < 10; i++) {
      history.push(
        ...makeTurn({
          userText: `t${i}`,
          toolName: 'tavily_search',
          toolUseId: `u${i}`,
          toolResultContent: bigJson(4000),
          replyText: `r${i}`,
        }),
      );
    }
    // Budget fits ~3 intact turns. After summarization, 8 of 10 turns shrink
    // to ~30 tokens each, so the same budget should now fit all 10.
    const capOnly = applyTokenBudget(history, { tokenBudget: 3500 }).messages;
    const trimmed = trimHistoryForLlm(history, { tokenBudget: 3500 }).messages;
    expect(trimmed.length).toBeGreaterThan(capOnly.length);
    expect(unmatchedToolUseIds(trimmed)).toEqual([]);
  });

  it('returns stats with tokensBefore/tokensAfter/summarized/budgetCut', () => {
    const history = [
      ...makeTurn({ userText: 't0', toolName: 'tavily_search', toolUseId: 'a', toolResultContent: bigJson(8000), replyText: 'r0' }),
      ...makeTurn({ userText: 't1', toolName: 'noop', toolUseId: 'n1', toolResultContent: 'ok', replyText: 'r1' }),
      ...makeTurn({ userText: 't2', toolName: 'noop', toolUseId: 'n2', toolResultContent: 'ok', replyText: 'r2' }),
      ...makeTurn({ userText: 't3', toolName: 'noop', toolUseId: 'n3', toolResultContent: 'ok', replyText: 'r3' }),
    ];
    const r = trimHistoryForLlm(history, { tokenBudget: 30000 });
    expect(r.stats.tokensBefore).toBeGreaterThan(0);
    expect(r.stats.tokensAfter).toBeLessThan(r.stats.tokensBefore);
    expect(r.stats.summarized).toBe(1);
    expect(r.stats.budgetCut).toBe(0);
  });

  it('passes through unchanged when summarizeStale: false and history fits the budget', () => {
    const history = [
      ...makeTurn({ userText: 't0', toolName: 'tavily_search', toolUseId: 'a', toolResultContent: bigJson(1000), replyText: 'r0' }),
      ...makeTurn({ userText: 't1', toolName: 'noop', toolUseId: 'n1', toolResultContent: 'ok', replyText: 'r1' }),
      ...makeTurn({ userText: 't2', toolName: 'noop', toolUseId: 'n2', toolResultContent: 'ok', replyText: 'r2' }),
      ...makeTurn({ userText: 't3', toolName: 'noop', toolUseId: 'n3', toolResultContent: 'ok', replyText: 'r3' }),
    ];
    const r = trimHistoryForLlm(history, { tokenBudget: 30000, summarizeStale: false });
    expect(r.messages).toEqual(history);
    expect(r.stats.summarized).toBe(0);
    expect(r.stats.budgetCut).toBe(0);
  });
});
