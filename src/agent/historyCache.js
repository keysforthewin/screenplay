/**
 * withMessageCacheBreakpoint(history, maxBreakpoints = 2)
 *
 * Returns a shallow-clone of `history` with `cache_control: {type:'ephemeral'}`
 * placed on the last content block of up to `maxBreakpoints` messages, so
 * Anthropic can cache the conversation prefix and each agent-loop iteration only
 * re-pays for the new tail (assistant + tool_result blocks added since the
 * previous call).
 *
 * Why two breakpoints: a cache breakpoint can only reuse a prior cache entry
 * found within Anthropic's 20-content-block lookback window. A single
 * tool-heavy iteration (many parallel tool_use blocks + their tool_result
 * blocks) can append >20 blocks at once, pushing the previous turn's single
 * end-breakpoint out of the lookback window and silently missing the ENTIRE
 * cached prefix (history + system + tools). Placing a second breakpoint ~15
 * flattened blocks back from the tail keeps a recent, reachable boundary so a
 * big append still finds a prior cache entry. This is the breakpoint freed up by
 * dropping the (near-worthless ~190-token) volatile system-block breakpoint.
 *
 * If no message has array-form content (e.g. a brand-new channel with only
 * string assistant replies), no marker is placed — we still benefit from the
 * tools/system breakpoints upstream.
 */
const SECOND_BREAKPOINT_GAP_BLOCKS = 15;

export function withMessageCacheBreakpoint(history, maxBreakpoints = 2) {
  if (!Array.isArray(history) || !history.length) return history;

  // Indices of messages whose content is array-form (the only markable shape).
  const markable = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m && Array.isArray(m.content) && m.content.length) markable.push(i);
  }
  if (!markable.length) return history;

  const chosen = new Set();
  // Always mark the tail — this is the breakpoint the NEXT iteration reads.
  chosen.add(markable[markable.length - 1]);

  // Walk backward from the message before the tail, accumulating flattened block
  // counts, and place additional breakpoints once the accumulated gap reaches
  // the threshold — until the breakpoint budget is spent or we run out of
  // markable messages.
  let acc = 0;
  for (let k = markable.length - 2; k >= 0 && chosen.size < maxBreakpoints; k--) {
    acc += history[markable[k]].content.length;
    if (acc >= SECOND_BREAKPOINT_GAP_BLOCKS) {
      chosen.add(markable[k]);
      acc = 0;
    }
  }

  return history.map((m, i) => {
    if (!chosen.has(i)) return m;
    const lastIdx = m.content.length - 1;
    return {
      ...m,
      content: m.content.map((b, idx) =>
        idx === lastIdx ? { ...b, cache_control: { type: 'ephemeral' } } : b,
      ),
    };
  });
}
