/**
 * withMessageCacheBreakpoint(history)
 *
 * Returns a shallow-clone of `history` where the LAST content block of the
 * latest message that has array-form content carries a `cache_control:
 * {type:'ephemeral'}` marker. This lets Anthropic cache the entire history
 * prefix, so subsequent agent-loop iterations only re-pay for the new
 * tail (assistant + tool_result blocks added since the previous call).
 *
 * If no message has array content (e.g. brand-new channel with only string
 * assistant replies), the marker is dropped — we still benefit from the
 * tools/system breakpoints upstream.
 */
export function withMessageCacheBreakpoint(history) {
  if (!Array.isArray(history) || !history.length) return history;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m || !Array.isArray(m.content) || m.content.length === 0) continue;
    const lastIdx = m.content.length - 1;
    const newContent = m.content.map((b, idx) =>
      idx === lastIdx ? { ...b, cache_control: { type: 'ephemeral' } } : b,
    );
    return [
      ...history.slice(0, i),
      { ...m, content: newContent },
      ...history.slice(i + 1),
    ];
  }
  return history;
}
