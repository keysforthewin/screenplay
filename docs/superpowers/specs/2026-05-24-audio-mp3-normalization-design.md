# Audio MP3 normalization + per-model audio cap

**Date:** 2026-05-24
**Status:** Approved (pending implementation)

## Problem

fal's `bytedance/seedance-2.0/reference-to-video` (and its `fast/` variant)
rejects non-MP3 audio:

> The parameter `content[2]` specified in the request is not valid: the
> parameter audio format specified in the request is not valid for model
> dreamina-seedance-2-0 in r2v. To fix this, you must convert your audio file
> to MP3 format (128-320 kbps, under 15 seconds, and under 10 MB) before
> submitting the request.

Browser mic recordings are captured as `audio/webm;codecs=opus` (or
`audio/mp4`) and stored verbatim in GridFS; at video-generation time
`loadAndUploadAttachment` ships those exact bytes to fal. The model needs
**MP3** and audio **≤ 15s**. Two distinct constraints:

1. **Format** — must be MP3. Applies to every audio input fal sees.
2. **Duration** — ≤ 15s, specific to the seedance reference-to-video model.

## Current flow (as built)

- Audio reaches a scene four ways: **Record** and **Upload** (both POST raw
  bytes), **From dialog** and **From reference** (both copy an existing GridFS
  attachment id — no new bytes).
- Upload routes: `POST /storyboard/:id/audio` (`entityRoutes.js:3556`) and
  `POST /dialog/:id/audio` (`entityRoutes.js:4432`). Each uses multer
  `upload.single('file')` → determines an `audio/*` content type (recovering
  from the filename when the multipart parser chokes on `;codecs=…`) →
  `uploadAttachmentBuffer(...)` → gateway sets `audio_file_id` and probes
  duration via `music-metadata` into `audio_duration_seconds`.
- `seedance-2.0/reference-to-video` is a **catalog-only** model
  (`bytedance/seedance-2.0/reference-to-video`), auto-wired by
  `synthesizeCatalogModel` in `src/fal/videoModels.js`. Its audio param is
  `audio_urls` (a list), so the bundle's single `audioUrl` becomes
  `audio_urls: [url]`. Catalog row declares `audio: "optional"`,
  `max_seconds: 15`, `supports_generate_audio: true`.
- ffmpeg is already a server dependency: `src/web/storyboardGrabFrame.js`
  spawns it for last-frame extraction, with `FfmpegMissingError`, a test seam
  (`__setExtractLastFrameImplForTests`), and tmp-file plumbing. This change
  reuses that pattern.

## Decisions

- **Where to normalize format:** server-side, at upload time, for all audio
  inputs (Record + Upload). Existing stored webm is **not** migrated;
  re-uploading produces MP3.
- **On ffmpeg-missing / transcode failure at upload:** **fail loudly** with a
  clear HTTP error (no silent webm storage).
- **Duration cap:** handled **at fal-submit, only for models that declare a
  cap** (seedance r2v = 15s) — not at upload, so the stored audio keeps its
  full length for other models. Plus a notice in the Generate Video dialog.

## Part A — Normalize uploaded audio to MP3 (upload time, global)

### New module `src/web/audioTranscode.js`

Mirrors the `storyboardGrabFrame.js` ffmpeg pattern: a private helper writes
the input buffer to a tmp file, spawns ffmpeg, reads the tmp output, and
cleans up both in `finally`. A swappable impl seam keeps tests off the real
binary.

```
convertToMp3(buffer) -> Promise<Buffer>
  ffmpeg -i <in> -vn -c:a libmp3lame -b:a 192k -y <out.mp3>

trimToSeconds(buffer, seconds) -> Promise<Buffer>   // used by Part B
  ffmpeg -i <in> -t <seconds> -c:a libmp3lame -b:a 192k -y <out.mp3>

__setAudioFfmpegImplForTests(fn)   // test seam; pass null to restore default
```

- 192 kbps sits inside seedance's 128–320 kbps window; a 15s clip is ~360 KB,
  far under the 10 MB cap.
- Errors: `FfmpegMissingError` (spawn ENOENT) and `AudioTranscodeError`
  (ffmpeg non-zero exit; carries the trailing stderr).

### Upload route changes (`src/web/entityRoutes.js`)

In **both** `POST /storyboard/:id/audio` and `POST /dialog/:id/audio`, after
the existing `audio/*` content-type determination and before
`uploadAttachmentBuffer`:

- If `baseContentType(ct) === 'audio/mpeg'` → store as-is (no needless
  re-encode).
- Otherwise → `convertToMp3(req.file.buffer)`; store the returned buffer with
  `contentType: 'audio/mpeg'` and a `.mp3` filename (derive from
  `safeFilename(...)` with the extension swapped).
- **Fail loudly:**
  - `FfmpegMissingError` → HTTP **503**, body
    `{ error: 'audio upload requires ffmpeg on the server' }`.
  - `AudioTranscodeError` → HTTP **422**, body
    `{ error: 'could not convert audio to MP3' }`.

The gateway's `music-metadata` duration probe then runs on clean MP3.

## Part B — Per-model audio cap: trim at submit + UI notice

### `src/fal/videoModels.js`

Explicit per-endpoint constraints table + accessor:

```js
const AUDIO_CONSTRAINTS = {
  'bytedance/seedance-2.0/reference-to-video':      { format: 'mp3', maxAudioSeconds: 15 },
  'bytedance/seedance-2.0/fast/reference-to-video': { format: 'mp3', maxAudioSeconds: 15 },
};
export function getAudioConstraints(endpointId) {
  return AUDIO_CONSTRAINTS[endpointId] || null;
}
```

Explicit (not derived from `max_seconds`) so we never trim audio for an
unrelated model whose *video* duration cap happens to be short.

Surface `audio_max_seconds` on:
- the dialog row shape (`mergeCatalogRow` base + `registryToDialogShape`), keyed
  by `endpoint_id` / `falModel`, so the SPA knows the cap on model select; and
- the preview payload's `model` object in `buildVideoPayloadPreview`.

### `src/web/falVideoGenerate.js`

When the resolved model has `getAudioConstraints(...).maxAudioSeconds` and the
audio slot is wanted:
- If `storyboard.audio_duration_seconds` exceeds the cap (or is unknown/null),
  read the stored MP3 from GridFS, `trimToSeconds(buffer, cap)`, and upload the
  trimmed bytes to fal (`name: 'audio.mp3'`, `contentType: 'audio/mpeg'`).
- Otherwise upload unchanged.

Preview path (`buildVideoPayloadPreview`): include `audio_max_seconds` in the
returned `model`, and push a warning when audio would be trimmed
(`audio_duration_seconds > cap`), e.g. "audio will be trimmed to 15s for this
model".

### `web/src/widgets/GenerateVideoDialog.jsx`

When the chosen model (or preview model) has `audio_max_seconds`, render a
notice near the audio/summary area:

> This model limits audio to 15s — longer clips are trimmed.

## Testing

- **`audioTranscode`:** passthrough for `audio/mpeg`; transcodes a webm sample
  via the mocked seam (asserts ffmpeg args + returned buffer); `trimToSeconds`
  passes `-t`; `FfmpegMissingError` / `AudioTranscodeError` propagate.
- **Upload routes:** posting `audio/webm` → stored attachment is `audio/mpeg`
  with a `.mp3` filename (seam mocked); already-MP3 upload is stored unchanged;
  ffmpeg-missing yields the 503 status, transcode failure the 422.
- **`getAudioConstraints`:** returns the cap for the two seedance r2v
  endpoints, null otherwise.
- **Submit trim:** with a mocked seam, trim is invoked only when
  `audio_duration_seconds > cap` (or unknown); not invoked for models without a
  cap.

## Out of scope

- No migration of existing stored webm (re-upload normalizes).
- "From dialog" / "From reference" copy paths inherit MP3 transitively (their
  source was normalized on its own upload); a pre-existing webm source would
  need re-upload.
- Format is enforced globally at upload, so the per-model `format` field is
  documentation / future-proofing — the submit-time step only trims duration.
- No auto-trim at upload time; the stored clip keeps its full length.
