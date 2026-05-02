// Some models occasionally emit JSON-style escape sequences inside string
// content (e.g. `—` instead of `—`). The Anthropic SDK already decodes
// the wire JSON once, so any surviving escapes are double-escaped — they
// reach us as literal characters. Normalize them back to the intended chars
// at the tool-input boundary so they don't end up stored verbatim in Mongo
// and rendered as gibberish in the PDF.

const NAMED = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  '"': '"',
  "'": "'",
  '\\': '\\',
  '/': '/',
};

const ESCAPE_RE = /\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([nrtbf"'\\/]))/g;

export function decodeEscapesInString(s) {
  if (typeof s !== 'string' || s.indexOf('\\') === -1) return s;
  return s.replace(ESCAPE_RE, (_m, uBraced, u4, x2, named) => {
    if (uBraced) {
      const cp = parseInt(uBraced, 16);
      if (!Number.isFinite(cp) || cp > 0x10ffff) return _m;
      return String.fromCodePoint(cp);
    }
    if (u4) return String.fromCharCode(parseInt(u4, 16));
    if (x2) return String.fromCharCode(parseInt(x2, 16));
    if (named) return NAMED[named] ?? _m;
    return _m;
  });
}

export function decodeEscapes(value) {
  if (value == null) return value;
  if (typeof value === 'string') return decodeEscapesInString(value);
  if (Array.isArray(value)) return value.map(decodeEscapes);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decodeEscapes(v);
    return out;
  }
  return value;
}
