// Pure text-windowing utilities for letting the agent navigate large bodies
// without loading the full text into the prompt. All functions operate on a
// markdown (or plain) string and return JSON-friendly structures.

function splitLines(text) {
  // Preserve trailing-newline-less files: split on \n only, then strip a single
  // \r at the end of each line so CRLF input behaves the same as LF.
  if (typeof text !== 'string') return [];
  if (text.length === 0) return [''];
  return text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

// Slice `lineCount` lines from `text` starting at 1-indexed `lineStart`.
// Out-of-range starts and counts are clamped. Returns enough metadata for the
// caller to know whether more is available.
export function sliceLines(text, lineStart = 1, lineCount = 200) {
  const all = splitLines(text);
  const totalLines = all.length;
  const startIdx = Math.max(1, Math.floor(Number(lineStart) || 1)) - 1;
  const count = Math.max(0, Math.floor(Number(lineCount) || 0));
  const endIdx = Math.min(totalLines, startIdx + count);
  const lines = [];
  for (let i = startIdx; i < endIdx; i++) {
    lines.push({ n: i + 1, text: all[i] });
  }
  return {
    lines,
    totalLines,
    totalChars: text.length,
    rangeStart: startIdx + 1,
    rangeEnd: endIdx,
    hasMore: endIdx < totalLines,
  };
}

function escapeRegexLiteral(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Find every occurrence of `pattern` in `text`, returning each match with
// surrounding context lines. Substring matching by default; `regex:true` opts
// in. Sequential matches whose contexts overlap are merged into a single block
// so the agent doesn't pay for the same line twice.
export function searchLines(text, pattern, opts = {}) {
  const {
    regex = false,
    caseInsensitive = !regex, // sensible default: substring search is case-insensitive
    contextLines = 3,
    maxMatches = 20,
  } = opts;
  if (typeof text !== 'string' || typeof pattern !== 'string' || !pattern) {
    return { matches: [], totalMatches: 0, truncated: false };
  }
  const all = splitLines(text);
  let re;
  try {
    const flags = caseInsensitive ? 'gi' : 'g';
    re = new RegExp(regex ? pattern : escapeRegexLiteral(pattern), flags);
  } catch (e) {
    throw new Error(`searchLines: invalid regex: ${e.message}`);
  }
  const matchLines = [];
  for (let i = 0; i < all.length; i++) {
    re.lastIndex = 0;
    if (re.test(all[i])) matchLines.push(i);
    if (matchLines.length >= maxMatches + 1) break; // +1 so we know if truncated
  }
  const totalMatches = matchLines.length;
  const truncated = totalMatches > maxMatches;
  const kept = matchLines.slice(0, maxMatches);

  // Merge overlapping context windows into blocks.
  const blocks = [];
  for (const lineIdx of kept) {
    const ctxStart = Math.max(0, lineIdx - contextLines);
    const ctxEnd = Math.min(all.length - 1, lineIdx + contextLines);
    const last = blocks[blocks.length - 1];
    if (last && ctxStart <= last.ctxEnd + 1) {
      last.ctxEnd = Math.max(last.ctxEnd, ctxEnd);
      last.matchLines.push(lineIdx + 1);
    } else {
      blocks.push({ ctxStart, ctxEnd, matchLines: [lineIdx + 1] });
    }
  }

  const matches = blocks.map((b) => {
    const lines = [];
    for (let i = b.ctxStart; i <= b.ctxEnd; i++) {
      lines.push({ n: i + 1, text: all[i] });
    }
    return {
      match_lines: b.matchLines,
      context_start: b.ctxStart + 1,
      context_end: b.ctxEnd + 1,
      lines,
    };
  });

  return { matches, totalMatches: truncated ? maxMatches : totalMatches, truncated };
}

// Extract markdown ATX headings (#, ##, …) with their 1-indexed line number.
// Setext headings (underline === or ---) are also detected. Returns an empty
// array if the text has no headings.
export function extractOutline(text) {
  if (typeof text !== 'string' || !text) return [];
  const lines = splitLines(text);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const atx = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (atx) {
      out.push({ level: atx[1].length, line: i + 1, text: atx[2].trim() });
      continue;
    }
    const next = lines[i + 1];
    if (next && line.trim() && /^=+\s*$/.test(next)) {
      out.push({ level: 1, line: i + 1, text: line.trim() });
      i++;
      continue;
    }
    if (next && line.trim() && /^-+\s*$/.test(next)) {
      out.push({ level: 2, line: i + 1, text: line.trim() });
      i++;
    }
  }
  return out;
}

// Truncate `text` to roughly `maxChars`, preferring to break at the next
// newline boundary so we don't slice mid-sentence. Returns the preview plus
// metadata so callers can build a "use the slice tool" hint.
export function truncateForPreview(text, maxChars = 8000) {
  if (typeof text !== 'string') return { preview: '', totalChars: 0, totalLines: 0, truncated: false };
  const totalChars = text.length;
  if (totalChars <= maxChars) {
    return { preview: text, totalChars, totalLines: splitLines(text).length, truncated: false };
  }
  let cut = text.indexOf('\n', maxChars);
  if (cut === -1 || cut > maxChars + 200) cut = maxChars;
  const preview = text.slice(0, cut);
  return { preview, totalChars, totalLines: splitLines(text).length, truncated: true };
}

// Apply a list of {find, replace} edits to a string sequentially, with the
// same uniqueness check used by `editFragmentMarkdown` and `editBeatBody`.
// Throws on missing or ambiguous `find`. Returns the updated text plus
// per-edit stats.
export function applyMarkdownEdits(text, edits, label = 'edit') {
  if (typeof text !== 'string') {
    throw new Error(`${label}: target text is not a string.`);
  }
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error(`${label}: \`edits\` must be a non-empty array of {find, replace} pairs.`);
  }
  let body = text;
  const beforeLen = body.length;
  const applied = [];
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      throw new Error(
        `${label}: edit ${i} must be an object {find, replace}, got ${
          Array.isArray(e) ? 'array' : typeof e
        }.`,
      );
    }
    if (typeof e.find !== 'string' || typeof e.replace !== 'string') {
      throw new Error(
        `${label}: edit ${i} must have string \`find\` and \`replace\`. Got find=${typeof e.find}, replace=${typeof e.replace}.`,
      );
    }
    if (!e.find) {
      throw new Error(`${label}: edit ${i} has empty \`find\`. Use the dedicated append/set tool to add or replace whole content.`);
    }
    const first = body.indexOf(e.find);
    if (first < 0) {
      throw new Error(
        `${label}: edit ${i} \`find\` text not found. Use verbatim text from the current value. Snippet: "${snippet(e.find)}".`,
      );
    }
    let count = 1;
    let scan = first + e.find.length;
    while (scan < body.length) {
      const next = body.indexOf(e.find, scan);
      if (next < 0) break;
      count += 1;
      scan = next + e.find.length;
    }
    if (count > 1) {
      throw new Error(
        `${label}: edit ${i} \`find\` matched ${count} places — must be unique. Add surrounding context to disambiguate. Snippet: "${snippet(e.find)}".`,
      );
    }
    body = body.slice(0, first) + e.replace + body.slice(first + e.find.length);
    applied.push({
      find_chars: e.find.length,
      replace_chars: e.replace.length,
      delta: e.replace.length - e.find.length,
    });
  }
  return { body, applied, beforeLen, afterLen: body.length };
}

function snippet(s, max = 80) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
