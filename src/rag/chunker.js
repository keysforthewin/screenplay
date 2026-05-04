// Markdown-aware paragraph chunker for RAG indexing. Pure module, no deps.
//
// Splits markdown into chunks of ~targetTokens, never splitting inside fenced
// code blocks. Headings travel with the content beneath them. Adjacent chunks
// share a small sentence-boundary overlap (suppressed across heading changes).
//
// Token estimate matches src/agent/historyTrim.js: ceil(chars/4).
//
// Output shape: [{ text_md, text_plain }] where text_md is the original
// markdown (returned to the agent) and text_plain is the markdown-stripped
// form (used for embedding). The chunker returns text_md only; callers strip
// markdown themselves to keep this module dependency-free.

const DEFAULTS = {
  targetTokens: 512,
  overlapTokens: 64,
  maxTokens: 800,
};

function tokenLen(s) {
  return Math.ceil((s ? s.length : 0) / 4);
}

// Walk lines into atomic blocks. Block kinds:
//   - 'fence'   : everything between two fences (inclusive). Never split.
//   - 'heading' : a single line starting with #, ##, etc. Stays with the next block.
//   - 'list'    : a run of consecutive list/blockquote lines. Atomic if under maxTokens.
//   - 'para'    : a paragraph (lines until a blank line). Splittable on sentence
//                 boundaries when oversize.
function parseBlocks(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block
    const fenceMatch = line.match(/^\s{0,3}(```|~~~)/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const start = i;
      i++;
      while (i < lines.length && !lines[i].match(new RegExp(`^\\s{0,3}${fence}\\s*$`))) {
        i++;
      }
      if (i < lines.length) i++; // include closing fence
      const text = lines.slice(start, i).join('\n');
      blocks.push({ kind: 'fence', text });
      continue;
    }
    // Blank line
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    // Heading
    if (/^\s{0,3}#{1,6}\s+/.test(line)) {
      blocks.push({ kind: 'heading', text: line });
      i++;
      continue;
    }
    // List / blockquote run
    if (/^\s{0,3}([-*+]\s+|\d+\.\s+|>\s?)/.test(line)) {
      const start = i;
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        /^\s{0,3}([-*+]\s+|\d+\.\s+|>\s?|\s+)/.test(lines[i])
      ) {
        i++;
      }
      blocks.push({ kind: 'list', text: lines.slice(start, i).join('\n') });
      continue;
    }
    // Paragraph: until blank or special-block start
    const start = i;
    while (i < lines.length && !/^\s*$/.test(lines[i])) {
      const next = lines[i];
      if (i > start) {
        if (next.match(/^\s{0,3}(```|~~~)/)) break;
        if (/^\s{0,3}#{1,6}\s+/.test(next)) break;
        if (/^\s{0,3}([-*+]\s+|\d+\.\s+|>\s?)/.test(next)) break;
      }
      i++;
    }
    blocks.push({ kind: 'para', text: lines.slice(start, i).join('\n') });
  }
  return blocks;
}

// Split a paragraph on sentence boundaries when it's too big. Last resort:
// hard split on whitespace.
function splitOversizeBlock(text, maxTokens) {
  const out = [];
  const sentences = text.split(/(?<=[.?!])\s+/);
  let buf = '';
  for (const s of sentences) {
    const candidate = buf ? `${buf} ${s}` : s;
    if (tokenLen(candidate) <= maxTokens) {
      buf = candidate;
      continue;
    }
    if (buf) out.push(buf);
    if (tokenLen(s) <= maxTokens) {
      buf = s;
    } else {
      // Hard split on whitespace.
      const words = s.split(/\s+/);
      let wb = '';
      for (const w of words) {
        const cand = wb ? `${wb} ${w}` : w;
        if (tokenLen(cand) > maxTokens) {
          if (wb) out.push(wb);
          wb = w;
        } else {
          wb = cand;
        }
      }
      buf = wb;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// Trailing-token overlap snapped to a sentence boundary if possible.
function tailOverlap(text, overlapTokens) {
  if (!text || overlapTokens <= 0) return '';
  const targetChars = overlapTokens * 4;
  if (text.length <= targetChars) return text;
  const slice = text.slice(text.length - targetChars);
  const m = slice.match(/[.?!]\s+(.*)$/s);
  if (m && m[1] && m[1].length > 0) return m[1];
  return slice;
}

export function chunkMarkdown(md, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const text = typeof md === 'string' ? md : '';
  if (!text.trim()) return [];

  const rawBlocks = parseBlocks(text);
  // Pre-split oversize 'para' blocks. Fenced code is left intact even if oversize.
  const blocks = [];
  for (const b of rawBlocks) {
    if (b.kind === 'para' && tokenLen(b.text) > cfg.maxTokens) {
      const pieces = splitOversizeBlock(b.text, cfg.maxTokens);
      for (const p of pieces) blocks.push({ kind: 'para', text: p });
    } else {
      blocks.push(b);
    }
  }

  const chunks = [];
  let cur = []; // array of block.text strings making up the current chunk
  let curTokens = 0;
  let lastWasHeading = false;

  function flush() {
    if (!cur.length) return;
    chunks.push({ text_md: cur.join('\n\n') });
    cur = [];
    curTokens = 0;
  }

  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    const t = b.text;
    const tt = tokenLen(t);

    // Heading: starts a new chunk; affinity with the next block.
    if (b.kind === 'heading') {
      if (cur.length) flush();
      cur.push(t);
      curTokens += tt;
      lastWasHeading = true;
      continue;
    }

    // If adding this block would exceed target, flush first — unless the
    // current chunk is just a heading (heading affinity).
    if (curTokens + tt > cfg.targetTokens && cur.length && !lastWasHeading) {
      const overlap = tailOverlap(cur.join('\n\n'), cfg.overlapTokens);
      flush();
      if (overlap) {
        cur.push(overlap);
        curTokens += tokenLen(overlap);
      }
    }

    cur.push(t);
    curTokens += tt;
    lastWasHeading = false;

    // If this block alone is oversize (e.g. a giant fenced code block), flush.
    if (curTokens >= cfg.maxTokens) {
      flush();
    }
  }
  flush();
  return chunks;
}
