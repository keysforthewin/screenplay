import { balanceToolUses } from '../mongo/messages.js';

const STUB_PREFIX = '[Truncated tool_result for ';

// Per-tool stub-age policy. `stubAtAge` is the minimum turn-distance from the
// most recent real-user turn (most recent = 0) at which a tool_result for this
// tool is replaced with a stub. `sizeThreshold` (optional) requires the
// original content to exceed this many chars before stubbing kicks in.
//
// Tools NOT in this table are never summarized — covers all mutators,
// status-style results, and tiny payloads (`calculator`, image sentinels, etc.).
const TOOL_POLICY = {
  // Always-large, ID-yielding — kept longer because the IDs/names are referenced later.
  list_characters: { stubAtAge: 4 },
  list_beats: { stubAtAge: 4 },
  search_beats: { stubAtAge: 4 },
  search_characters: { stubAtAge: 4 },
  tmdb_search_movie: { stubAtAge: 4 },
  tmdb_search_person: { stubAtAge: 4 },
  list_library_images: { stubAtAge: 4 },
  list_beat_images: { stubAtAge: 4 },
  list_character_images: { stubAtAge: 4 },
  list_beat_attachments: { stubAtAge: 4 },
  list_character_attachments: { stubAtAge: 4 },
  search_message_history: { stubAtAge: 4 },
  // Always-large, content-only — research/analysis output, stales fast.
  get_overview: { stubAtAge: 2 },
  tavily_search: { stubAtAge: 2 },
  tmdb_get_movie: { stubAtAge: 2 },
  tmdb_get_movie_credits: { stubAtAge: 2 },
  find_repeated_phrases: { stubAtAge: 2 },
  similar_character: { stubAtAge: 2 },
  similar_works: { stubAtAge: 2 },
  analyze_dramatic_arc: { stubAtAge: 2 },
  token_usage_report: { stubAtAge: 2 },
  find_character_phrases: { stubAtAge: 2 },
  check_similarity: { stubAtAge: 2 },
  // Sometimes-large — only stub when both old AND fat.
  get_beat: { stubAtAge: 3, sizeThreshold: 2000 },
  get_character: { stubAtAge: 3, sizeThreshold: 2000 },
  get_plot: { stubAtAge: 3, sizeThreshold: 2000 },
  list_director_notes: { stubAtAge: 3, sizeThreshold: 2000 },
  get_current_beat: { stubAtAge: 3, sizeThreshold: 2000 },
};

function isRealUserMessage(m) {
  if (!m || m.role !== 'user') return false;
  if (typeof m.content === 'string') return true;
  if (!Array.isArray(m.content)) return true;
  // A "real" user message has at least one non-tool_result block (text, image,
  // etc.). A user message that's all tool_result blocks is an agent-loop
  // dispatch, not a Discord turn.
  return m.content.some((b) => !b || b.type !== 'tool_result');
}

// Age = how many real-user messages come AFTER this one in the array.
// Most recent turn (the one currently being responded to or just answered) is age 0.
function computeTurnAges(messages) {
  const ages = new Array(messages.length).fill(0);
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    ages[i] = count;
    if (isRealUserMessage(messages[i])) count += 1;
  }
  return ages;
}

function buildToolUseIdToName(messages) {
  const map = new Map();
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b && b.type === 'tool_use' && b.id && typeof b.name === 'string') {
        map.set(b.id, b.name);
      }
    }
  }
  return map;
}

function contentLengthChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const sub of content) {
    if (sub && sub.type === 'text' && typeof sub.text === 'string') n += sub.text.length;
  }
  return n;
}

function isAlreadyStubbed(content) {
  if (typeof content === 'string') return content.startsWith(STUB_PREFIX);
  if (!Array.isArray(content) || !content.length) return false;
  const first = content[0];
  return !!(first && first.type === 'text' && typeof first.text === 'string' && first.text.startsWith(STUB_PREFIX));
}

function buildStub(toolName, originalChars) {
  return `${STUB_PREFIX}${toolName}: ${originalChars} chars in original. Re-call ${toolName} with the same arguments to retrieve fresh data.]`;
}

export function summarizeStaleToolResults(messages, opts = {}) {
  const policy = opts.policy || TOOL_POLICY;
  const toolUseIdToName = buildToolUseIdToName(messages);
  const ages = computeTurnAges(messages);
  let summarized = 0;

  const out = messages.map((m, i) => {
    if (m.role !== 'user' || !Array.isArray(m.content) || !m.content.length) return m;
    const age = ages[i];
    if (age <= 0) return m; // most recent turn always intact

    let mutated = false;
    const newContent = m.content.map((b) => {
      if (!b || b.type !== 'tool_result') return b;
      if (b.is_error) return b;
      if (isAlreadyStubbed(b.content)) return b;
      const toolName = toolUseIdToName.get(b.tool_use_id);
      if (!toolName) return b;
      const rule = policy[toolName];
      if (!rule) return b;
      if (age < rule.stubAtAge) return b;
      const originalChars = contentLengthChars(b.content);
      if (rule.sizeThreshold && originalChars <= rule.sizeThreshold) return b;
      mutated = true;
      summarized += 1;
      return {
        type: 'tool_result',
        tool_use_id: b.tool_use_id,
        content: buildStub(toolName, originalChars),
      };
    });

    return mutated ? { ...m, content: newContent } : m;
  });

  return { messages: out, stats: { summarized } };
}

export function estimateMessageTokens(msg) {
  if (!msg) return 0;
  if (typeof msg.content === 'string') return Math.ceil(msg.content.length / 4);
  if (!Array.isArray(msg.content)) return 0;
  let chars = 0;
  for (const b of msg.content) {
    if (!b) continue;
    if (b.type === 'text') chars += (b.text || '').length;
    else if (b.type === 'tool_use') {
      chars += (b.name || '').length;
      try {
        chars += JSON.stringify(b.input || {}).length;
      } catch {
        // ignore
      }
    } else if (b.type === 'tool_result') {
      const c = b.content;
      if (typeof c === 'string') chars += c.length;
      else if (Array.isArray(c)) {
        for (const sub of c) {
          if (sub && sub.type === 'text') chars += (sub.text || '').length;
        }
      }
    }
    // Image blocks: not expected in stored history (per messageHandler), so 0.
  }
  return Math.ceil(chars / 4);
}

function totalTokens(messages) {
  let n = 0;
  for (const m of messages) n += estimateMessageTokens(m);
  return n;
}

function isOrphanToolResultMsg(m) {
  return (
    m &&
    m.role === 'user' &&
    Array.isArray(m.content) &&
    m.content.length > 0 &&
    m.content.every((b) => b && b.type === 'tool_result')
  );
}

export function applyTokenBudget(messages, opts = {}) {
  const budget = Number.isFinite(opts.tokenBudget) ? opts.tokenBudget : 30000;
  if (budget <= 0 || !messages.length) return { messages, stats: { budgetCut: 0 } };

  const total = totalTokens(messages);
  if (total <= budget) return { messages, stats: { budgetCut: 0 } };

  // Walk newest → oldest; keep adding until the next message would push us over.
  const tokens = messages.map(estimateMessageTokens);
  let acc = 0;
  let firstKeptIdx = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (acc + tokens[i] > budget) break;
    acc += tokens[i];
    firstKeptIdx = i;
  }

  // Snap forward to the first real-user message in the kept range so we never
  // start mid-toolresult chain. If none, fall back to whatever firstKeptIdx is
  // (balanceToolUses will heal any orphan tool_uses).
  let snap = firstKeptIdx;
  while (snap < messages.length && isOrphanToolResultMsg(messages[snap])) {
    snap += 1;
  }

  const cut = snap;
  const kept = messages.slice(cut);
  // Heal orphan tool_uses at the new head if any prior assistant tool_use was sliced off.
  const balanced = balanceToolUses(kept);
  return {
    messages: balanced,
    stats: { budgetCut: messages.length - balanced.length },
  };
}

export function trimHistoryForLlm(messages, opts = {}) {
  const tokensBefore = totalTokens(messages);
  const summarizeStale = opts.summarizeStale !== false;

  let working = messages;
  let summarizedCount = 0;
  if (summarizeStale) {
    const r = summarizeStaleToolResults(working, opts);
    working = r.messages;
    summarizedCount = r.stats.summarized;
  }

  const budget = applyTokenBudget(working, opts);
  working = budget.messages;

  return {
    messages: working,
    stats: {
      tokensBefore,
      tokensAfter: totalTokens(working),
      summarized: summarizedCount,
      budgetCut: budget.stats.budgetCut,
    },
  };
}
