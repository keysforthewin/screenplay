// Splits speakable text into synthesis-sized segments. We own this instead of
// kokoro-js's TextSplitterStream because that splitter tracks quote/bracket
// nesting and refuses to end a sentence while anything is "open" — so a single
// unbalanced mark (the apostrophe in "the writers' room", a stray `"` or `(`)
// swallows the entire rest of the text into ONE sentence. That monster is then
// phonemized in hundreds of serialized espeak runs with no output (tripping the
// client's watchdog) and finally truncated to the model's 510-token window,
// silently dropping everything after the first ~30s.
//
// Rules: paragraphs never merge; sentences pack greedily up to MAX_CHARS; a
// sentence longer than MAX_CHARS breaks at clause punctuation, else at a
// space. The very first segment stays a single sentence so audio starts soon.
// MAX_CHARS keeps the phoneme count (roughly 1.1–1.3× the characters) well
// inside the 510-token window, so nothing is ever truncated.

export const MAX_CHARS = 250;

const SENTENCE_END = /[.!?…]+["'”’)\]]*\s+/g;

function splitSentences(paragraph) {
  const out = [];
  let last = 0;
  for (const m of paragraph.matchAll(SENTENCE_END)) {
    const end = m.index + m[0].length;
    out.push(paragraph.slice(last, end).trim());
    last = end;
  }
  if (last < paragraph.length) out.push(paragraph.slice(last).trim());
  return out.filter(Boolean);
}

// Break one over-long sentence: prefer the last clause mark inside the window,
// then the last space, then a hard cut (a single 250+ char "word").
function splitLong(sentence, max) {
  const out = [];
  let rest = sentence;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = -1;
    for (const m of window.matchAll(/[,;:—–]\s/g)) cut = m.index + 1;
    if (cut < max * 0.4) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function segmentText(text, { maxChars = MAX_CHARS } = {}) {
  const segments = [];
  const paragraphs = String(text || '').split(/\n+/).map((p) => p.replace(/\s+/g, ' ').trim());
  for (const paragraph of paragraphs) {
    if (!paragraph) continue;
    let current = '';
    for (const sentence of splitSentences(paragraph)) {
      for (const piece of splitLong(sentence, maxChars)) {
        const firstEver = segments.length === 0 && current;
        if (current && (firstEver || current.length + 1 + piece.length > maxChars)) {
          segments.push(current);
          current = piece;
        } else {
          current = current ? `${current} ${piece}` : piece;
        }
      }
    }
    if (current) segments.push(current);
  }
  // Pure punctuation/symbol runs phonemize to nothing — skip them.
  return segments.filter((s) => /[\p{L}\p{N}]/u.test(s));
}
