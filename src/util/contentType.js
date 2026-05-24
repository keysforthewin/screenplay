// Infer a media content type from a filename extension. Used as a server-side
// safety net on upload routes: if the multipart parser failed to read the
// part's Content-Type (e.g. a browser sent an unparseable `;codecs=vp9,opus`
// type, which busboy turns into `text/plain`), we can still recover the
// intended type from the filename the client supplied. Returns null when the
// extension is unknown or absent.
const EXT_TO_TYPE = {
  webm: 'video/webm',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
};

export function contentTypeFromFilename(name) {
  const ext = String(name || '')
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/)?.[1];
  return (ext && EXT_TO_TYPE[ext]) || null;
}
