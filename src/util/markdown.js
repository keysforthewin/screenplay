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
