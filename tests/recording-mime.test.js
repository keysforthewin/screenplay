// Regression tests for the webcam/mic recording content-type bug.
//
// The video recorder used to tag its uploaded File as
// `video/webm;codecs=vp9,opus`. The unquoted comma between the two codecs
// makes the server's multipart parser (busboy) fail to parse the part's
// Content-Type and fall back to `text/plain`, which the upload route rejects
// with "file must be video/*". `baseContentType` strips the codec params so a
// clean, parseable `video/webm` is sent; `contentTypeFromFilename` is the
// server-side safety net.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { baseContentType } from '../web/src/recordingMime.js';
import { contentTypeFromFilename } from '../src/util/contentType.js';

// Import busboy's actual content-type parser the same way multer does, to
// prove the cleaned type is one busboy will accept.
const require = createRequire(import.meta.url);
const { parseContentType } = require('busboy/lib/utils.js');

describe('baseContentType', () => {
  it('strips multi-codec params whose comma breaks multipart parsing', () => {
    expect(baseContentType('video/webm;codecs=vp9,opus', 'video/webm')).toBe(
      'video/webm',
    );
  });

  it('strips single-codec params', () => {
    expect(baseContentType('audio/webm;codecs=opus', 'audio/webm')).toBe(
      'audio/webm',
    );
  });

  it('passes through a bare type unchanged', () => {
    expect(baseContentType('video/mp4', 'video/webm')).toBe('video/mp4');
  });

  it('falls back when the raw type is empty or nullish', () => {
    expect(baseContentType('', 'video/webm')).toBe('video/webm');
    expect(baseContentType(undefined, 'audio/webm')).toBe('audio/webm');
    expect(baseContentType(null, 'video/webm')).toBe('video/webm');
  });

  it('trims and lowercases', () => {
    expect(baseContentType('  VIDEO/WEBM ;codecs=vp8 ', 'video/webm')).toBe(
      'video/webm',
    );
  });

  // The crux: the raw recorder type fails to parse (busboy -> text/plain),
  // but the cleaned type parses to a real video/* type.
  it('produces a content type busboy accepts (the raw one does not)', () => {
    expect(parseContentType('video/webm;codecs=vp9,opus')).toBeUndefined();
    const cleaned = baseContentType('video/webm;codecs=vp9,opus', 'video/webm');
    const parsed = parseContentType(cleaned);
    expect(parsed).toBeTruthy();
    expect(`${parsed.type}/${parsed.subtype}`).toBe('video/webm');
  });
});

describe('contentTypeFromFilename', () => {
  it('infers video types from the extension', () => {
    expect(contentTypeFromFilename('scene-abc123-1700000000000.webm')).toBe(
      'video/webm',
    );
    expect(contentTypeFromFilename('clip.MP4')).toBe('video/mp4');
    expect(contentTypeFromFilename('shot.mov')).toBe('video/quicktime');
  });

  it('infers audio types from the extension', () => {
    expect(contentTypeFromFilename('take.m4a')).toBe('audio/mp4');
    expect(contentTypeFromFilename('voice.mp3')).toBe('audio/mpeg');
    expect(contentTypeFromFilename('note.wav')).toBe('audio/wav');
  });

  it('returns null for unknown or missing extensions', () => {
    expect(contentTypeFromFilename('noextension')).toBeNull();
    expect(contentTypeFromFilename('archive.zip')).toBeNull();
    expect(contentTypeFromFilename('')).toBeNull();
    expect(contentTypeFromFilename(null)).toBeNull();
  });
});
