// Strip Markdown syntax for case-insensitive lookups and display where formatting
// would be inappropriate (e.g. when computing `name_lower` on a character whose
// stored `name` is now markdown-formatted).
//
// Intentionally a small, regex-based utility — we do not need a full CommonMark
// parser here. The output is for sorting/lookup, not display.
export function stripMarkdown(input) {
  if (input === null || input === undefined) return '';
  let s = String(input);
  // fenced code blocks
  s = s.replace(/```[\s\S]*?```/g, ' ');
  // inline code
  s = s.replace(/`([^`]*)`/g, '$1');
  // images: ![alt](url) → alt
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // links: [text](url) → text
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // headings, blockquotes, list bullets at line start
  s = s.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '');
  // bold/italic/strikethrough markers
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
  s = s.replace(/(\*|_)([^*_\n]+?)\1/g, '$2');
  s = s.replace(/~~(.*?)~~/g, '$1');
  // residual escapes
  s = s.replace(/\\([\\`*_{}\[\]()#+\-.!>])/g, '$1');
  return s.replace(/\s+/g, ' ').trim();
}

// ── Screenplay lines ──
// A screenplay is read by the line: a slugline, a character cue, a
// parenthetical and the speech under it each sit on their own line. Markdown
// only keeps a line break INSIDE a paragraph when it is a hard break (a
// trailing backslash, or two trailing spaces); a bare newline is a space, so
// "KEYS\n(flat)\nCompliance." is stored and shown as "KEYS (flat) Compliance."
// These three helpers move between the two forms.

const HARD_BREAK_RE = /(?:\\|[ \t]{2,})\n/g;
// Lines that are markdown structure, where a trailing backslash would be
// literal text or break the block: headings, list items, tables, fences, quotes.
const STRUCTURAL_LINE_RE = /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|\||```|>)/;

// Stored markdown → the page as a writer types it: hard breaks become plain
// newlines. Everything else (emphasis, quotes) is left as it is.
export function hardBreaksToLines(markdown) {
  return String(markdown ?? '').replace(/\r\n?/g, '\n').replace(HARD_BREAK_RE, '\n');
}

// A writer's page → markdown that keeps its lines: every newline between two
// lines of the same paragraph becomes a hard break. Idempotent. `trim: false`
// leaves the start and end of the string as given (for a fragment of a page —
// the find / replace text of an edit — rather than a whole one).
export function linesToHardBreaks(text, { trim = true } = {}) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  const out = lines.map((line, i) => {
    const next = lines[i + 1];
    if (!line.trim() || next === undefined || !next.trim()) return line;
    if (line.endsWith('\\') || STRUCTURAL_LINE_RE.test(line) || STRUCTURAL_LINE_RE.test(next)) return line;
    return `${line}\\`;
  }).join('\n');
  return trim ? out.trim() : out;
}

// stripMarkdown that keeps the line structure: stripped line by line, hard
// break marks dropped, runs of blank lines collapsed to one. What a reader
// of the PAGE sees — use it wherever the layout of the text is being judged.
export function stripMarkdownLines(markdown) {
  return hardBreaksToLines(markdown)
    .split('\n')
    .map((line) => stripMarkdown(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
