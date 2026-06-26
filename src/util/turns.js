// Shared definition of a conversational "turn" across the history pruning
// layers (the Mongo loader in src/mongo/messages.js and the agent-side trimmer
// in src/agent/historyTrim.js). Pure — no imports — so either layer can use it
// without an import cycle.

// A "real" user message is a Discord turn: a string-content user message, or a
// user message with at least one non-tool_result block (text, image, etc.). A
// user message that's all tool_result blocks is agent-loop dispatch plumbing,
// not a conversational turn.
export function isRealUserMessage(m) {
  if (!m || m.role !== 'user') return false;
  if (typeof m.content === 'string') return true;
  if (!Array.isArray(m.content)) return true;
  return m.content.some((b) => !b || b.type !== 'tool_result');
}

// Index of the first message to KEEP so the suffix holds at least minUserTurns
// real user messages (and everything after the oldest of them). The returned
// index always points at a real user message, so slicing there starts on a
// clean turn boundary. Special cases:
//   - minUserTurns <= 0 or no array → returns length (no floor).
//   - fewer than minUserTurns user messages → the OLDEST real user message
//     (keep all the turns there are, but not leading non-user plumbing).
//   - no real user messages at all → returns length (no floor; nothing to
//     protect, so callers fall back to their own age/budget cut).
export function floorStartIndex(messages, minUserTurns = 6) {
  if (!Array.isArray(messages)) return 0;
  if (minUserTurns <= 0) return messages.length;
  let count = 0;
  let oldestUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isRealUserMessage(messages[i])) {
      count += 1;
      oldestUserIdx = i;
      if (count === minUserTurns) return i;
    }
  }
  return oldestUserIdx === -1 ? messages.length : oldestUserIdx;
}
