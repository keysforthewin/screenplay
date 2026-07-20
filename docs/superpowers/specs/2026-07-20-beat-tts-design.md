# Beat text-to-speech playback — design

Date: 2026-07-20
Status: approved pending user review

## Goal

A Play button on the beat editing page (`/p/:projectTitle/beat/:order`) that reads the beat's **body text** aloud using fully client-side TTS. Playback must start near-instantly even for wall-of-text beats (streaming synthesis), run in Chrome with WebGPU acceleration, cost $0, and send nothing off the machine.

## Decisions (confirmed with user)

- **Engine**: `kokoro-js` (Kokoro-82M, `onnx-community/Kokoro-82M-v1.0-ONNX`) via Transformers.js.
- **Precision**: `fp32` on WebGPU when `navigator.gpu` is available (~310 MB one-time, browser-cached); automatic fallback to `q8` on WASM otherwise (~90 MB).
- **Streaming**: yes — `TextSplitterStream` + `tts.stream()`; audio plays sentence-by-sentence as it is synthesized.
- **Voice**: dropdown listing all English voices, grouped US/UK with top-graded voices first; default `af_heart`; persisted in localStorage key `screenplay_tts_voice_v1`.
- **Read scope**: beat `body` field only (not name/desc).
- **Placement**: page header action row in `web/src/routes/Beat.jsx`, next to `DownloadAllButton`.

## Architecture

Three new client-side units; no server or schema changes.

### 1. `web/src/tts/kokoroWorker.js` — synthesis worker

A module Web Worker (`new Worker(new URL('./kokoroWorker.js', import.meta.url), { type: 'module' })` — Vite handles bundling; no config changes). Keeps heavy phonemize/inference work off the main thread so the collaborative editor never janks.

Message protocol (in → out):

- `{type:'speak', text, voice, speed}` → lazily initializes the model on first use (detect `navigator.gpu` in the worker: webgpu/fp32 else wasm/q8; `from_pretrained` `progress_callback` forwarded as `{type:'progress', loaded, total, status}`), then runs `tts.stream(splitter)` over the text. Emits one `{type:'chunk', samples: Float32Array, sampleRate, text}` per sentence (samples posted as a transferable), then `{type:'done'}`.
- `{type:'stop'}` → aborts the current stream (generation-id guard: chunks from a stale run are dropped).
- Errors → `{type:'error', message}`; the model instance is cached in the worker for subsequent plays.

### 2. `web/src/tts/useTts.js` — playback hook

Owns the worker and an `AudioContext`. Exposes `{ status, progress, play(text, voice), stop() }` where `status ∈ idle | loading-model | generating | playing | error`.

- Gapless playback: each incoming chunk becomes an `AudioBuffer` scheduled with `AudioBufferSourceNode.start(cumulativeTime)`; cumulative time advances by chunk duration, clamped to `ctx.currentTime` if generation falls behind (brief silence rather than overlap).
- `stop()` stops/disconnects all scheduled sources, sends `{type:'stop'}` to the worker.
- Unmount cleanup: stop audio, close the AudioContext; the worker persists for the tab lifetime so the loaded model is reused across beats.
- `status` transitions: `loading-model` (first ever use, shows download %), `generating` (before first chunk), `playing` (first chunk scheduled), back to `idle` on done/stop.

### 3. `web/src/widgets/PlayBeatButton.jsx` — UI

Rendered in the Beat page header row (inside `CollabSurface` so `useCollabRoom()` is available).

- On Play: extract live plain text from the y-doc with a new `readFragmentText(ydoc, field)` helper added beside `readFragmentMarkdown` in `web/src/editor/fragmentRead.js` (same transient headless-Tiptap pattern, but returning `editor.getText()` instead of markdown — no 2 s staleness, no markdown syntax read aloud) → `play(text, voice)`. Empty body → button disabled.
- Button label reflects status: `▶ Play` / `Downloading model… 42%` / `Generating…` / `■ Stop`.
- Voice `<select>` beside the button; changing voice mid-playback takes effect on the next Play.
- kokoro-js is only referenced inside the worker, and the worker is only constructed on first Play — the main SPA bundle does not grow.

## Error handling

- No WebGPU → silent q8/WASM fallback (slower but works).
- Worker/model init failure (old browser, blocked download) → `status:'error'`, button shows "TTS unavailable" tooltip; the rest of the page is unaffected.
- Navigation/unmount mid-playback → audio stops immediately.

## Testing

- Vitest: markdown→plain-text stripping; useTts reducer/state transitions with a mocked worker + mocked AudioContext (chunk scheduling math, stop behavior, stale-generation guard).
- Manual in Chrome (DevTools MCP): first-use download progress, playback starts <~2 s on a long beat, voice switch, stop, WASM fallback via `--disable-features` if desired.
- The existing suite must stay green; no server code is touched.

## Out of scope (YAGNI)

- Pause/seek, sentence highlighting in the editor, reading name/desc/dialog, per-character voices, saving audio to GridFS, Safari/Firefox tuning.
