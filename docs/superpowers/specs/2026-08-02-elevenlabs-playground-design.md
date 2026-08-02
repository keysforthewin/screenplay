# ElevenLabs playground tab — design

Date: 2026-08-02
Status: approved pending user review

## Goal

A new **ElevenLabs** tab on `/playground` (between Create and History) exposing ElevenLabs' audio toolset against the account behind `ELEVEN_LABS_KEY`: Text to Speech with Eleven v3 audio tags, Voice Changer (speech-to-speech), Voice Isolator, and Speech to Text — plus a voice library browser with full facet search, a per-project voice collection, Instant Voice Cloning, and Voice Design. Audio inputs can be uploaded, dragged in, or **recorded directly in the browser**. Outputs persist to the same per-project playground history as fal generations.

## Decisions (confirmed with user)

- **Tool scope**: TTS, Voice Changer, Voice Isolator, Speech to Text only. No Sound Effects, no Music, no dubbing.
- **Voice cloning & design**: in scope (added after initial scoping). Instant Voice Cloning and Voice Design, surfaced as sub-tabs of the voice section.
- **Collection storage**: app-local, per-project in Mongo (`eleven_voices` collection). Voices added from the shared library are lazily registered with the ElevenLabs account only when first used for generation (API constraint — see below).
- **History**: shared with the fal playground — outputs are GridFS files with `owner_type: 'playground'`, so the existing History tab shows them. A `generated_by` value of `elevenlabs/<tool>` distinguishes them.
- **Enhance model**: Anthropic Claude via the existing `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` env config (same account the bot uses). No new key.
- **No SDK dependency**: raw `fetch` against the REST API, keeping deploys rsync-only (the bot image is deps-only; adding a package would force an image rebuild).
- **Synchronous endpoints**: ElevenLabs calls are direct HTTP (seconds, no queue), so the fal SSE job registry pattern is not cloned. Each generate endpoint blocks, persists the output, and returns file ids. The SPA shows a spinner.
- **Account-level voice deletion is out of scope**: removing a voice from a project's collection never deletes it from the ElevenLabs account (another project may reference it).

## API constraint that shapes the design

ElevenLabs does not allow using a shared-library voice for TTS/speech-to-speech until it has been added to the account's My Voices (`POST /v1/voices/add/:public_owner_id/:voice_id`). Premade voices and voices created by cloning/design are natively usable. Therefore each collection doc tracks `added_to_account`; generation endpoints try the call, and on a "voice not found/unavailable" error perform the add and retry once, then persist `added_to_account: true`. If the account's voice slots are full, ElevenLabs' error is surfaced verbatim.

## Architecture

### Backend

**`src/eleven/client.js`** — thin fetch wrapper, optional-integration pattern (like `src/gemini/client.js`): `isConfigured()` checks `ELEVEN_LABS_KEY`; every call sends `xi-api-key`. Handlers return friendly error strings / `configured: false` rather than throwing when the key is missing. Non-2xx responses raise an error carrying ElevenLabs' `detail` message so users see real explanations. Functions:

- `searchSharedVoices(params)` → `GET /v1/shared-voices` (page_size, page, category, gender, age, accent, language, search, use_cases, descriptives, featured)
- `addSharedVoice(publicOwnerId, voiceId, newName)` → `POST /v1/voices/add/:public_owner_id/:voice_id`
- `textToSpeech(voiceId, { text, modelId })` → `POST /v1/text-to-speech/:voice_id` (returns audio bytes; `model_id` default `eleven_v3`)
- `speechToSpeech(voiceId, { buffer, contentType, modelId })` → `POST /v1/speech-to-speech/:voice_id` (multipart; `model_id` default `eleven_multilingual_sts_v2`)
- `isolateAudio({ buffer, contentType })` → `POST /v1/audio-isolation` (multipart)
- `speechToText({ buffer, contentType })` → `POST /v1/speech-to-text` (multipart, `model_id: 'scribe_v1'`)
- `createIvcVoice({ name, description, removeNoise, files })` → `POST /v1/voices/ivc/create` (multipart, multiple samples)
- `designVoice({ voiceDescription, text })` → `POST /v1/text-to-voice/design` (returns previews: `generated_voice_id` + base64 mp3)
- `createVoiceFromPreview({ voiceName, voiceDescription, generatedVoiceId })` → `POST /v1/text-to-voice`

**`src/mongo/elevenVoices.js`** — helpers over a new `eleven_voices` collection, following the repo convention: every helper takes `projectId` first and throws `projectId required` on falsy. Docs:

```
{ _id, project_id, voice_id, public_owner_id|null, name, description,
  preview_url, labels: {gender, age, accent, language, ...}, category,
  source: 'library'|'clone'|'design', added_to_account: bool, created_at }
```

Unique compound index `(project_id, voice_id)`. Helpers: `listCollectionVoices`, `addVoiceToCollection` (upsert), `removeVoiceFromCollection`, `markVoiceAddedToAccount`. Cascade: `deleteProjectCascade` gains `eleven_voices` deletion by `project_id`.

**`src/web/elevenRoutes.js`** — new Express router mounted at `/api/eleven` (entityRoutes.js is 6k lines; this stays separate). All routes are project-scoped via the existing `resolveProject` middleware. Routes:

- `GET /info` → `{ configured: bool }`
- `GET /library` → proxy to `searchSharedVoices`, passing through the facet query params; returns voices with the fields the cards need (name, ids, preview_url, labels, description, use cases, descriptives, category, free-tier flags)
- `GET /collection` / `POST /collection` (body: voice metadata from a library card) / `DELETE /collection/:voiceId`
- `POST /enhance` `{ text }` → Claude rewrite with audio tags → `{ text }`
- `POST /tts` `{ voice_id, text, model_id? }` → ensure-usable dance → audio → GridFS → `{ outputs: [{kind:'audio', file_id}] }`
- `POST /voice-changer` `{ voice_id, ref: {file_id} }` → same shape
- `POST /isolate` `{ ref: {file_id} }` → same shape
- `POST /stt` `{ ref: {file_id} }` → `{ transcript, language, outputs: [{kind:'attachment', file_id}] }` (transcript also saved as a `.txt` attachment, `owner_type: 'playground'`)

Audio refs reuse the existing `POST /api/playground/upload` endpoint and its GridFS `owner_type: 'playground'` + project verification (`loadRef` semantics: cross-project or non-playground ids behave as not-found). Voice previews play directly from ElevenLabs' CDN `preview_url` (no proxy). Design previews are returned to the client as base64 data URLs (never persisted).

**Enhance prompt** (server-side constant): instructs Claude to insert Eleven v3 audio tags — emotions, delivery, reactions — sparingly and only where the text supports them, returning the tagged text verbatim-otherwise. Uses `config.anthropic.model`. Returns a friendly error string if the Anthropic call fails.

### Frontend

**`web/src/routes/Playground.jsx`** — gains the third tab (`elevenlabs`, labeled "ElevenLabs") rendering `<ElevenLabsPanel />`. Existing Create/History tabs untouched.

**`web/src/widgets/ElevenLabsPanel.jsx`** — top-level panel:

- Fetches `/api/eleven/info` once; unconfigured → banner, controls disabled.
- **Tool switcher** (segmented control): Text to Speech · Voice Changer · Voice Isolator · Speech to Text.
- **Voice section** (visible for TTS and Voice Changer) with sub-tabs **Collection | Browse library | Clone | Design**:
  - *Collection*: chips/cards from `/api/eleven/collection` — preview play (CDN url), radio select for the active voice, remove button. Active voice id persisted in localStorage (`screenplay.playground.eleven_voice`).
  - *Browse library* (`VoiceLibraryBrowser`): search text input (debounced) + facet dropdowns for gender, age, accent, language, category, use case, descriptive, plus a featured checkbox — mapped 1:1 to `GET /v1/shared-voices` params. Facet option lists are curated constants from ElevenLabs docs (no facets endpoint exists). Paginated cards: name, label badges, description, preview play, **Add to collection**.
  - *Clone* (`VoiceClonePanel`): multi-sample audio input (upload and/or record, list of takes), name, optional description, remove-background-noise checkbox → Create → auto-added to account + collection (`source:'clone'`, `added_to_account:true`).
  - *Design* (`VoiceDesignPanel`): voice description textarea, optional custom preview text → Generate previews → preview cards with play (base64 audio) → name + Save on the chosen one → auto-added (`source:'design'`).
- **TTS pane**: large textarea; model select (default `eleven_v3`); **✨ Enhance** button (calls `/api/eleven/enhance`, replaces textarea content, keeps the pre-enhance text for one-click undo); **tag palette** (`AudioTagPalette`) — chips grouped Emotions / Delivery / Reactions, inserting `[tag]` at the cursor position. Tag list is a curated constant from the v3 prompting guide.
- **Audio-input panes** (Voice Changer / Isolator / STT): one audio ref via the existing upload flow (drop/choose) **or** `AudioRecorder` — MediaRecorder-based record button with live timer, stop, playback preview, and "use this recording" which uploads the blob through `/api/playground/upload`. Voice Changer additionally requires the active collection voice.
- **Generate row**: primary button with spinner (sync request), disabled until the pane's inputs are satisfied, with a tooltip naming what's missing (mirrors `modelReadiness` UX).
- **Results list**: same card layout as the fal playground (audio players, download links); STT results additionally show the transcript inline with a Copy button.

**`web/src/widgets/AudioRecorder.jsx`** — reusable recorder (also used by the Clone panel). `navigator.mediaDevices.getUserMedia({audio:true})` → MediaRecorder (`audio/webm;codecs=opus` with fallback to browser default) → blob preview → upload callback. Graceful error states for denied permission / no device / insecure context.

CSS: extend `web/src/` styles following existing `playground-*` class conventions (`eleven-*` prefix for new pieces).

## Error handling

- Missing `ELEVEN_LABS_KEY`: `/info` reports `configured:false`; SPA shows the same style of banner as the fal key warning; generate endpoints return 503 with a friendly message.
- ElevenLabs API errors: `detail` extracted and surfaced verbatim (mirrors the fal `extractFalDetail` lesson — no bare "Unprocessable Entity").
- Voice-not-in-account during TTS/STS: one add-and-retry cycle; add failure (e.g. voice slots full) surfaces ElevenLabs' message.
- Recording unavailable (permission denied, no mic, non-HTTPS): inline message in the recorder widget; upload path remains usable.
- Enhance failure: error banner; textarea content untouched.

## Testing

Vitest, no live API calls:

- `tests/eleven-voices.test.js` — Mongo helpers against `tests/_fakeMongo.js` (projectId threading, upsert semantics, cross-project isolation, `markVoiceAddedToAccount`).
- `tests/eleven-client.test.js` — client wrapper with mocked `fetch`: query-param mapping for library search, multipart construction, error-detail extraction, unconfigured short-circuit.
- `tests/eleven-routes.test.js` — router with mocked eleven client + fake Mongo: input validation, ensure-usable retry flow, STT transcript persistence, project scoping of refs.
- Enhance prompt builder unit test (prompt contains the tag vocabulary; response unwrapping).

## Out of scope (v1)

Sound Effects, Music, dubbing, Professional Voice Cloning (requires verification), voice remixing, account-level voice deletion, voice settings sliders (stability/similarity), streaming TTS playback, agent-loop tools for the Discord bot (web-only, like the rest of the playground).
