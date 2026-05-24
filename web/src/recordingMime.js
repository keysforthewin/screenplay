// Reduce a MediaRecorder mime string to its bare `type/subtype`, dropping any
// `;codecs=...` parameters.
//
// Why this exists: a recorder reports types like `video/webm;codecs=vp9,opus`.
// When that string is used as the uploaded File's type, the browser writes it
// verbatim as the multipart part's Content-Type. The server's parser (busboy)
// treats the unquoted comma in `vp9,opus` as malformed, fails to parse the
// whole Content-Type, and falls back to `text/plain` — which the upload routes
// reject ("file must be video/*"). The container type alone (`video/webm`) is
// enough for storage and playback, and it always parses cleanly.
export function baseContentType(raw, fallback) {
  const base = String(raw || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return base || fallback;
}
