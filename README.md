# screenplay

screenplay is a collaborative writers'-room and pre-vis workspace that lives in two places at once: a Discord channel where you talk to an agent like a colleague, and a browser-based editor where you and your collaborators edit the same screenplay state in real time. Introduce characters, sketch plot beats, attach reference images, generate concept art across four image providers, blend references into composites, lay out a per-beat shot list with start/end frames, generate video clips (Kling, Veo, Sora 2, lip-sync), drop in audio, look up real movies and actors, scan your draft for repetition or pacing issues, and export the whole thing as a PDF when you're done.

## Features

### Writing
- **Mutable character template.** Say "every character should have a favourite colour" and that field is added to every existing and future character.
- **Bulk character updates.** When the schema changes — or when a value is missing for half the cast — ask the bot to fill it in once across everyone (*"give every character a default pronoun based on what we know"*) instead of going one by one.
- **Plot organised into ordered beats.** Each beat has a short name, a one-line summary, and a long-form body that grows over time. A "current beat" pointer means you don't have to re-name the beat on every follow-up.
- **Director notes.** Screenplay-wide rules and reminders the bot keeps in mind when writing or revising — tone, formatting conventions, content avoidances. A full top-level entity with its own images, attachments, and ordering.
- **Auto-portraits.** Give a character a real-world actor and the bot quietly attaches a headshot the next time you touch the character.
- **Reference images and file attachments.** Beats, characters, and director notes can each carry images (PNG/JPEG/WEBP, ≤100 MB) and non-image files — audio, video, PDF, scripts (≤100 MB). The bot pulls them back up by name when relevant.
- **PDF and CSV export.** Export the whole screenplay as a PDF, or slice characters and beats into spreadsheet reports — filter, group, aggregate, then open in Sheets or Excel.
- **Real-movie / real-actor grounding** via TheMovieDB — search films, look up casts, pull posters and headshots.
- **Live web search** via Tavily — ground real-world references, current events, or check whether your character or plot resembles existing fiction.
- **Writing analysis** — scan for overused phrases, detect near-duplicates, examine what a single character actually does in the script, and check whether the climax sits where it should.
- **Semantic recall (RAG)** across the whole screenplay — meaning-based search across every beat body, character custom field, director's note, and recent Discord message. Re-indexes live as you edit.
- **Searchable conversation memory.** Ask the bot to recall something said weeks ago and it can search the full channel history with regex.

### Collaborative web editor
- **Real-time multi-user editing.** Approved visitors edit the same fields the bot mutates — markdown-rich, with live cursors, presence indicators, and a save status badge. When the bot is writing, you see its caret in the field as a "collaborator". Powered by Yjs/Tiptap/Hocuspocus.
- **Discord-gated access.** Visitors type a name, the bot posts an Approve/Deny embed in your channel, one click approves them. Sessions never expire; revoke by removing the row.
- **Inline image generation and editing** from any beat/character/note — pick a provider (Nano Banana / Nano Banana Pro / Flux 2 Pro / Flux Pro Kontext / OpenAI gpt-image-2), pick reference images from the project (multi-image blending up to 14 refs), and the artwork is queued asynchronously with undo.
- **Per-beat storyboards.** Lay out a shot list with start and end frame images, per-shot reference images, audio slot, and a generated video clip. Drag to reorder. The bot can auto-generate a storyboard for a beat in two LLM passes (outline → per-shot prompts), and natural-language batch edits work across the whole sequence ("add a reaction shot between 3 and 4, drop the wide").
- **Video generation** via fal.ai — Kling 3 Pro (start/end frames + native audio), Veo 3.1 first-last-frame (motion interpolation between two frames), Kling AI Avatar v2 Pro (lip-sync from image + audio), Sora 2 / Sora 2 Pro, Flashhead, plus a dynamically-loaded catalog of ~190 i2v models. Cost preview before render; queue position streams in over SSE.
- **Audio.** Upload MP3/WAV/OGG to any storyboard frame, dialog line, beat, character, or note. Durations probed automatically. Dialog audio is reusable across storyboards.
- **Reference pickers everywhere.** Pull reference images from the current beat, character sheets, the artwork library, the global library, or upload/generate on the spot.
- **ZIP downloads** per beat, character, library, or all-notes — bundles every image and attachment for the entity into a single file.
- **Live activity feed in Discord.** When SPA users generate images, render video, or attach audio, the bot posts an embed in your channel so everyone can see what's happening — cross-surface visibility without leaving the writers'-room channel.

## Quick start

```sh
cp .env.example .env       # then fill in the keys (see Configuration below)
docker compose up --build -d
# talk to the bot in the channel whose ID you set as MOVIE_CHANNEL_ID
# open http://localhost:3000 in a browser to use the collaborative editor
```

The Express server (default port `WEB_PORT=3000`) serves the SPA, the read endpoints, and the REST API. The Hocuspocus WebSocket server runs alongside it on `HOCUSPOCUS_PORT` (default 3001; some WSL2 setups need 3010) for the real-time editor. To stop: `docker compose down`.

For local SPA development without docker: `npm run dev:web` runs Vite on port 5173 with `/api`, `/auth`, `/image`, `/attachment`, `/pdf` proxied to the Express server on 3000.

### Reverse proxy (production)

If you front the bot with nginx (or any other reverse proxy), you need to do two things: raise the body limit for large uploads, and proxy the Hocuspocus WebSocket so live collaboration works.

Body limit — the server-side cap is `MAX_IMAGE_BYTES` in `src/mongo/imageBytes.js` (currently 100 MB) and multer is also at 100 MB. The same cap applies to non-image attachments. nginx must allow at least the same. Add to your `server { ... }` block:

```nginx
client_max_body_size 100M;
```

WebSocket — Hocuspocus needs the standard upgrade headers. Add a location block pointed at `HOCUSPOCUS_PORT`:

```nginx
location /collab {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

Then `sudo nginx -t && sudo systemctl reload nginx`. Point `HOCUSPOCUS_PUBLIC_URL` at the public wss:// URL the browser should connect to.

## Configuration

The three keys at the top of the table are required. The rest are optional — leave them blank and the corresponding tools will return a friendly "not configured" message instead of breaking the bot.

| Env var | Required? | Where to get it | What it unlocks |
| --- | --- | --- | --- |
| `DISCORD_BOT_TOKEN` | yes | [Discord Developer Portal](https://discord.com/developers/applications) → New Application → Bot → Reset Token. Invite the bot to your server with the `bot` scope and the **Message Content Intent** enabled. | Talking to the bot. |
| `MOVIE_CHANNEL_ID` | yes | In Discord, enable Developer Mode (User Settings → Advanced), then right-click the channel → Copy Channel ID. | Picking which channel the bot listens in. |
| `ANTHROPIC_API_KEY` | yes | [console.anthropic.com](https://console.anthropic.com) → Settings → API Keys → Create Key. Add billing. | Everything the bot says and does. |
| `ANTHROPIC_MODEL` | optional | Defaults to `claude-opus-4-7`. Override to switch models. | Choosing a smarter or cheaper model. |
| `GEMINI_API_KEY` | optional | [aistudio.google.com](https://aistudio.google.com) → "Get API key". The free tier is plenty for development. | One of four image-generation backends (the free "Nano Banana" tier). The rest work via `FAL_KEY` and `OPENAI_API_KEY`. |
| `FAL_KEY` | optional | [fal.ai](https://fal.ai) → Dashboard → API Keys. Paid; you'll want a credit balance for video. | Higher-quality image generation (Nano Banana Pro, Flux 2 Pro, Flux Pro Kontext with multi-image blending) **and all video generation** (Kling 3 Pro, Veo 3.1 first-last-frame, Kling Avatar v2 lip-sync, Sora 2, Sora 2 Pro, Flashhead, ~190 catalog i2v models). |
| `OPENAI_API_KEY` | optional | [platform.openai.com](https://platform.openai.com) → API Keys. | The `gpt-image-2` provider on `generate_image` / `edit_image` and the SPA's "OpenAI" model option for character sheets, scene sheets, and storyboard frames. |
| `TMDB_READ_ACCESS_TOKEN` | optional | [themoviedb.org](https://www.themoviedb.org) → Settings → API → request a v4 key (free, instant for personal projects). Use the **v4 read access token** (the long JWT-style string), not the v3 API key. | Real-movie / real-actor lookup (`tmdb_*` tools) and auto-portraits. |
| `TAVILY_API_KEY` | optional | [tavily.com](https://tavily.com) → sign up → API Keys. Free tier is ~1000 searches/month. | Live web search and the "is my character/plot derivative?" tools. |
| `VOYAGE_API_KEY` | optional | Voyage key from [voyageai.com](https://www.voyageai.com). Chroma is brought up by docker-compose; no Chroma URL or key needed. | Semantic recall across the whole screenplay (`screenplay_search`). Without this the tool degrades to a friendly fallback. |
| `WEB_PORT` | optional | Defaults to `3000`. The Express server hosts the SPA, the REST API, and the read endpoints (`/image`, `/attachment`, `/pdf`). | Where the SPA lives. |
| `HOCUSPOCUS_PORT` | optional | Defaults to `3001` (or `3010` in WSL2 setups where Windows IP Helper claims 3001). | WebSocket port for real-time collaborative editing. |
| `HOCUSPOCUS_PUBLIC_URL` | optional | Browser-reachable `ws://` or `wss://` URL handed to the SPA via `/api/info`. Defaults to `ws://localhost:${HOCUSPOCUS_PORT}`. | What the browser connects to for live edits. Set this in production. |

A handful of additional knobs (PDF download URL, log level, etc.) live in `.env.example` with sensible defaults — touch them only if you need to.

> **Semantic search (RAG).** Set `VOYAGE_API_KEY` and you're done — the bot maintains a vector index of every beat body, character custom field, director's note, and recent Discord message. ChromaDB runs as a docker-compose service (`docker compose up -d chroma` for local dev, or it comes up automatically with `docker compose up`). Live edits in the SPA or via the agent re-index automatically (~1s debounce). For a one-shot backfill (or after a wipe) run `npm run reindex`. The agent reaches for `screenplay_search` whenever a question depends on screenplay content not in its immediate context — meaning-based recall instead of exact-name regex.

## Web UI

The browser editor lives at `http://${WEB_HOST}:${WEB_PORT}` (default `http://localhost:3000`). It and the Discord bot share the same MongoDB state and the same y-doc rooms — a change in either surface shows up live in the other.

### Getting in

There's no signup. A visitor types a name into the login screen; the bot posts an embed with **Approve** / **Deny** buttons in `MOVIE_CHANNEL_ID`. One click and the visitor is in — their `session_id` lands in `localStorage` and never expires. There's no revocation UI in v1; remove the row from `auth_sessions` if you need to kick someone.

### What you can do

- **Edit anything in real time.** Every text field on every entity is a markdown-rich collaborative editor (Yjs/Tiptap), with live cursors, presence indicators, and a save status badge. The bot appears as a "collaborator" in the field it's editing — when it's writing, you see its caret. Save state persists to Mongo on a ~2s debounce; the bot reads back from Mongo every iteration of its loop.
- **Navigate.** Routes:
  - `/` — Table of Contents. Tabbed view of Characters, Beats, Dialog, Storyboards, Director's Notes, Library, with full-text search across them.
  - `/beat/:order` — Single beat editor (Characters / Background / Attachments / References / Artwork tabs).
  - `/character/:name` — Single character sheet (Background / Attachments / References / Artwork tabs).
  - `/notes` — Director's notes.
  - `/library` — Unowned images and attachments staging area.
  - `/storyboard/:order` — Storyboard for a beat: ordered shots with start/end frames, audio, references, video clips. Drag to reorder. Auto-generate or batch-edit the whole sequence in natural language.
  - `/dialog/:order` — Dialog lines for a beat, each with its own audio slot.
- **Generate art inline.** Every entity has an Artwork tab with a generation dialog: pick a provider, pick reference images from the project (multi-select, up to 14 refs), and queue the job. Results are async with one-step undo and an explicit edit / regenerate / delete history.
- **Lay out shots.** The storyboard editor has start-frame and end-frame slots per shot, both editable with the same provider/reference-picker dialog. Set the shot type and duration, tag characters in the scene, attach audio, then click **Generate video**.
- **Render video.** The video dialog filters fal.ai's catalog by what inputs the shot has (start frame? end frame? audio? character sheet?), shows a payload preview with estimated cost, and streams queue position over SSE while the clip renders. Finished MP4s persist as beat-owned attachments and play inline.
- **Upload and reuse media.** Drop in images (PNG/JPEG/WEBP, ≤100 MB) or non-image attachments (audio, video, PDF, scripts, ≤100 MB) on any entity. Use the library as a staging area for assets not yet bound to a beat.
- **Download.** Every entity has a download-all button that zips its images and attachments into a single archive — handy for handoff or backup.

### Discord activity feed

When a SPA user does something interesting — generates an image, renders video, uploads audio, attaches a file — the bot posts an embed in your channel describing what happened, with a link back to the entity. Everyone gets cross-surface visibility without leaving Discord.

## How to talk to it

**What triggers the bot.** Anything you type in the configured channel. The bot remembers the last 60 messages so it follows the recent thread; for older context, ask it to search the full channel history.

**What the bot can see.** Text, plus any image you attach to a Discord message — and any image URL you paste.

**What the bot replies with.** A normal Discord message, optionally with a generated image, a movie poster, an actor headshot, or a PDF attached. Long replies are auto-split.

## Tool reference

Every entry below is something you can ask the bot to do. The bot picks the right tool for your request — these names are useful for reading; you don't type them.

### Overview

#### `get_overview`
A single snapshot of everything in the screenplay: synopsis and notes, every character (with casting and image counts), every beat (with name, description, body length, characters, image counts), and overall stats.
**API key:** none.
**Ask for it like:** *"What do we have so far?"* · *"Show me everything."* · *"What state is this in?"* · *"Which beats need bodies?"*
**Tips:** The bot won't fire-hose you with the entire payload — it'll pick the angle that answers your question. Lead with what you're trying to figure out.

### Universal edits

Two tools handle most text and structural edits across the project. They supersede a long tail of per-entity patch tools.

#### `edit`
Find/replace edits to any text field on any entity. The `find` must match the current value verbatim and uniquely — pass an empty `find` (with a single edit) to rewrite the whole field. Works on `beat.body` / `beat.name` / `beat.desc`, `character.name` / `character.hollywood_actor` / any custom field, `plot.title` / `plot.synopsis` / `plot.notes`, and `director_note.text`.
**API key:** none.
**Ask for it like:** *"In the diner scene, change 'Tuesday' to 'Wednesday'."* · *"Rewrite Bob's bio: he's now a retired surgeon, not an accountant."* · *"In beat 7, replace the closing paragraph with..."*
**Tips:** For beats too long to fit in context, narrow with `outline_beat_body` or `search_in_beat_body` first, then `read_beat_body` a window, then `edit` against the verbatim snippet you see. The edit applies server-side against the full value — your local window can be small.

#### `set_field`
Atomic value assignment for **non-text** fields — beat order, beat character roster, scene-sheet image id, or deleting custom-field keys from a character. For text fields use `edit` instead.
**API key:** none.
**Ask for it like:** *"Move beat 7 to position 3."* · *"Set the diner scene's characters to Alice and Bob only."* · *"Delete the 'archetype' field from Alice."*

### Characters

#### `list_characters`
List every character on file, names only.
**API key:** none.
**Ask for it like:** *"Who's in the script?"* · *"List the characters."*
**Tips:** Useful as a first step before introducing a new character — to avoid duplicates.

#### `get_character`
Fetch the full record for one character by name (case-insensitive) or id.
**API key:** none.
**Ask for it like:** *"Tell me about Alice."* · *"What do we know about Alice?"*

#### `create_character`
Create a new character. Only the name is required.
**API key:** none.
**Ask for it like:** *"Add a new character named Alice."* · *"There's a barista called Marcus."*
**Tips:** Defaults are *plays self: yes*, *own voice: yes*. The bot will create the character as soon as you name them, even if other details aren't known yet — extra fields can be filled in later via the universal `edit` tool, or in bulk with `revise_character`.

#### `read_character_field`
Read one specific field from a character — useful when the character record is huge and you only need one value.
**API key:** none.
**Ask for it like:** *"What's Alice's hometown?"* · *"Just give me Bob's hollywood actor."*

#### `revise_character`
Natural-language sweeping edits across a character's custom fields in a single pass — useful when the schema has shifted, references no longer fit, or you want to clean up subplots in one go.
**API key:** none.
**Ask for it like:** *"Revise Alice — strip out anything to do with the New York subplot."* · *"Update Bob's fields to reflect that he's now the antagonist, not the comic relief."*

#### `delete_character`
Delete a character and any images/attachments owned by it.
**API key:** none.
**Ask for it like:** *"Drop the character Carol."* · *"Delete Bob."*

#### `search_characters`
Find characters whose fields contain a substring (case-insensitive).
**API key:** none.
**Ask for it like:** *"Which character was the journalist?"* · *"Find the character with red hair."*

### Character template

#### `get_character_template`
Show the current character schema — required and optional fields.
**API key:** none.
**Ask for it like:** *"What fields do characters have?"* · *"Show the character template."*

#### `update_character_template`
Add or remove fields from the universal character schema.
**API key:** none.
**Ask for it like:** *"Every character should have a favourite colour."* · *"Drop the 'astrological sign' field."*
**Tips:** Core fields (name, plays-self, hollywood actor, own voice) cannot be removed. Adding a field doesn't backfill existing characters — the bot will start asking for that field as you touch each character.

#### `bulk_update_character_field`
Set or replace one field across many characters in a single pass — the right tool for backfilling a newly added template field, or normalising a value that's drifted across the cast. The bot decides each value (or pulls them from your message) and writes them in batches.
**API key:** none.
**Ask for it like:** *"Give every character a default pronoun based on what we know."* · *"Set 'archetype' to 'unknown' for everyone who doesn't have one yet."* · *"Mark plays_self false for the historical figures."*
**Tips:** Pairs naturally with `update_character_template`: add the field, then ask the bot to fill it in across everyone in one shot.

### Plot

#### `get_plot`
Return the current plot — synopsis, beat list, notes, and which beat is "current".
**API key:** none.
**Ask for it like:** *"What's the plot so far?"* · *"Show me the current plot."*

**Editing the plot.** For the synopsis, title, or freeform notes, use the universal `edit` tool with `collection: 'plot'`. Beats are managed separately — see the Beats section below.

### Director notes

Screenplay-wide rules and reminders the bot keeps in mind whenever it writes or revises. Notes are ordered, and each note carries its own text plus optional images and attachments — the perfect home for a tone reference video, a style-guide PDF, or a mood-board image.

#### `list_director_notes`
List every director note in order, with text previews and attachment counts.
**API key:** none.
**Ask for it like:** *"What are the director's notes?"* · *"Show me the style rules."*

#### `add_director_note`
Create a new director note. Defaults to the bottom of the list; pass a position to insert higher.
**API key:** none.
**Ask for it like:** *"Add a director note: avoid expository dialogue in the first act."*

#### `read_director_note`
Read one specific note's full text (useful when previews are truncated in `list_director_notes`).
**API key:** none.
**Ask for it like:** *"Read the third director note in full."*

#### `remove_director_note`
Delete a director note (and any images/attachments it owns).
**API key:** none.
**Ask for it like:** *"Drop the note about pacing."*

#### `reorder_director_notes`
Change the priority order of notes. Higher = more prominent in the system prompt.
**API key:** none.
**Ask for it like:** *"Move the dialogue rule to the top of the notes."*

#### `add_director_note_image` / `list_director_note_images` / `set_main_director_note_image` / `remove_director_note_image`
Attach, list, promote, and remove images on a director note. Same source rules as beat images — Discord upload or public URL, up to 100 MB. The main image surfaces alongside the note's text in the SPA.
**API key:** none.
**Ask for it like:** Upload an image and say *"Pin this to the lighting note."*

#### `attach_library_image_to_director_note`
Move a library image onto a director note.
**API key:** none.
**Ask for it like:** *"Bind the library image to the lighting note."*

#### `add_director_note_attachment` / `list_director_note_attachments` / `remove_director_note_attachment`
Attach, list, and remove non-image files on a director note (audio, video, PDF, scripts). Same 100 MB cap.
**API key:** none.
**Ask for it like:** Upload a PDF style guide and say *"Attach this to the style note."*

### Beats

#### `list_beats`
A compact list of all beats in order — order number, name, short description preview, body length, character count, and which one is current.
**API key:** none.
**Ask for it like:** *"List the beats."* · *"What beats do we have?"*

#### `get_beat`
Fetch the full record for one beat (name, description, body, characters, images).
**API key:** none.
**Ask for it like:** *"Show me the diner scene."* · *"What's in beat 3?"*
**Tips:** You can identify a beat by its order number, its exact name, or its id. If you're vague — *"the one with the diner argument"* — the bot will fall back to **search** automatically. For very long bodies, prefer `read_beat_body`, `search_in_beat_body`, or `outline_beat_body` below to avoid pulling the whole thing into context.

#### `read_beat_body`
Read a sliced window of a beat's body — page through long content without loading all of it. Returns a character range with cursor info so a follow-up call can continue from where it left off.
**API key:** none.
**Ask for it like:** *"Read the first 4000 characters of beat 3."* · *"Continue reading where you left off."*

#### `search_in_beat_body`
Substring search inside a single beat's body. Returns matches with surrounding context, like an in-document grep.
**API key:** none.
**Ask for it like:** *"In the diner scene, where does Alice mention her sister?"*

#### `outline_beat_body`
Skim a beat's body by paragraph or heading — outline view instead of the full text.
**API key:** none.
**Ask for it like:** *"Give me the outline of beat 3."* · *"What are the major sections of the diner scene?"*

#### `search_beats`
Substring search across beat name, description, and body. Returns ranked candidates so the bot can disambiguate when you gesture at a beat by description.
**API key:** none.
**Ask for it like:** *"The diner argument."* · *"That scene where Alice leaves."*

#### `create_beat`
Create a new beat. A beat has three text fields: a short **name** (3–6 words, e.g. "Diner Argument"), a 1–2 sentence **description** that's the elevator pitch, and a long-form **body** that grows over time.
**API key:** none.
**Ask for it like:** *"New beat: Alice and Bob argue at the diner over the missing tape."*
**Tips:** Usually leave the body empty on creation and add to it later with `edit`. The first beat you create automatically becomes the current beat.

**Editing a beat.** Renaming, rewriting the description, appending or replacing the body, and surgical mid-body edits all go through the universal `edit` tool with `collection: 'beat'`. Reordering and changing the character roster use `set_field`. See the [Universal edits](#universal-edits) section above.

#### `delete_beat`
Delete a beat (and any images attached to it).
**API key:** none.
**Ask for it like:** *"Delete the prologue beat."* · *"Drop beat 7."*
**Tips:** If the deleted beat was the current beat, the current pointer is cleared.

### Current beat

#### `set_current_beat`
Tell the bot which beat you're working on. Other tools that take an optional beat default to it.
**API key:** none.
**Ask for it like:** *"Let's work on the diner scene."* · *"Focus on beat 4."*

#### `get_current_beat`
Return the current beat (or nothing if none is set).
**API key:** none.
**Ask for it like:** *"What beat are we on?"*

#### `clear_current_beat`
Clear the current-beat pointer.
**API key:** none.
**Ask for it like:** *"Clear the current beat."* · *"Stop focusing on a beat."*

### Beat ↔ character links

#### `link_character_to_beat`
Add a character to a beat's character list. Idempotent — duplicates are silently ignored.
**API key:** none.
**Ask for it like:** *"Add Alice to the diner scene."* · *"Bob is also in beat 3."*

#### `unlink_character_from_beat`
Remove a character from a beat's character list.
**API key:** none.
**Ask for it like:** *"Take Alice out of beat 5."*

### Beat images

#### `add_beat_image`
Attach an image to a beat. The source is either a Discord upload from your previous message, or a public URL you've pasted into chat.
**API key:** none.
**Ask for it like:** Upload an image and say *"save this to the diner scene."* · *"Attach https://… as a reference for beat 3."*
**Tips:** PNG / JPEG / WEBP only, up to 100 MB. The first image attached to a beat becomes its main image; ask the bot to set a different image as the main one to override.

#### `list_beat_images`
List the images on a beat — filenames, sizes, types, source, generation prompt (for AI-generated ones), and which is the main image.
**API key:** none.
**Ask for it like:** *"What images are on the diner scene?"*

#### `set_main_beat_image`
Promote an existing image to be the beat's main image.
**API key:** none.
**Ask for it like:** *"Make the second image the main one for beat 3."*

#### `remove_beat_image`
Remove an image from a beat. If the deleted image was the main image, the next one (if any) is promoted automatically.
**API key:** none.
**Ask for it like:** *"Drop the second image from the diner scene."*

### Library

The "library" is a staging area for images and other files that aren't tied to any beat, character, or note yet — usually things you've generated without a current entity set, or pasted in for later use. The same buckets are shared by the SPA.

#### `list_library_images`
List unassigned images.
**API key:** none.
**Ask for it like:** *"What images are in the library?"* · *"Show me the unassigned images."*

#### `search_library_images`
Substring search across library images by filename, description, and generation prompt.
**API key:** none.
**Ask for it like:** *"Find the library images with 'diner' in them."* · *"Which library images mention Alice?"*

#### `show_library_image`
Display a specific library image in the reply.
**API key:** none.
**Ask for it like:** *"Show me the third library image."*

#### `replace_library_image`
Replace a library image's bytes while keeping its name, description, and metadata — useful when you've generated a variant you prefer and don't want every reference to break.
**API key:** none.
**Ask for it like:** *"Replace the library image with the variant you just made."*

#### `attach_library_image_to_beat`
Move a library image onto a beat. Once attached, it leaves the library.
**API key:** none.
**Ask for it like:** *"Attach the last image you generated to the diner scene."*

#### `move_image_to_library`
Detach an image from a beat / character / director note and move it back into the library. Useful when an image fits a different home than where it was first attached.
**API key:** none.
**Ask for it like:** *"Move Alice's second portrait into the library."*

#### `list_library_attachments`
List non-image files staged in the library (audio, video, PDF, scripts).
**API key:** none.
**Ask for it like:** *"What attachments are in the library?"*

#### `add_library_attachment`
Stash a non-image file in the library, from a Discord upload or public URL. Files up to 100 MB; any content type accepted (audio/video/PDF/scripts/etc.).
**API key:** none.
**Ask for it like:** Upload a file and say *"Stash this in the library."*

#### `attach_library_attachment_to_beat` / `attach_library_attachment_to_character` / `attach_library_attachment_to_director_note`
Reuse a library attachment by binding it to a beat, character, or director note. Three tools, same pattern as `attach_library_image_to_beat`.
**API key:** none.
**Ask for it like:** *"Attach that audio clip in the library to the diner scene."* · *"Bind the PDF in the library to Alice."*

### Image display & generation

#### `show_image`
Display an existing image (whether attached to a beat or sitting in the library) in the bot's reply.
**API key:** none.
**Ask for it like:** *"Show me the main image for beat 3."* · *"Let me see that image again."*

#### `describe_image`
Run a vision model over a stored image and return a description — useful for extracting character physical traits, environment details, or anything else encoded in pixels that you want to discuss as text.
**API key:** `ANTHROPIC_API_KEY` (vision via Claude).
**Ask for it like:** *"What does Alice look like in this portrait?"* · *"Describe the environment in the first beat image."*

#### `generate_image`
Generate an image with the bot's preferred image provider. Picks the right backend by your prompt and available keys: **Nano Banana** (Gemini, free tier), **Nano Banana Pro** (Gemini 3 Pro Image, paid via fal), **Flux 2 Pro** (paid via fal), **Flux Pro Kontext** (paid via fal), and **gpt-image-2** (paid via OpenAI). The bot displays the result in its reply and (by default, when a current beat is set) attaches it to that beat — otherwise the image lands in the library.
**API key:** `GEMINI_API_KEY` for the free tier; `FAL_KEY` for the Pro / Flux models; `OPENAI_API_KEY` for `gpt-image-2`. Any one of the three works on its own.
**Ask for it like:** *"Draw the diner exterior at night."* · *"Generate concept art for this scene."* · *"Show me what Alice looks like in this beat — use Flux Pro."*
**Tips:** The prompt can be built from your free-form description, the current/named beat, recent chat, or any combination. Aspect ratio defaults to 16:9 and can be set to 1:1, 9:16, 4:3, or 3:4. Only call this when you've actually asked for an image — the bot won't draw on its own.

#### `edit_image`
Modify or composite existing images instead of generating from scratch. Supports image-to-image edits ("repaint this in pastels"), multi-image blending ("put this character in this scene"), and reference-conditioned generation. Up to 14 reference images with Nano Banana Pro / Flux Pro Kontext; up to 9 with Flux 2 Pro.
**API key:** `FAL_KEY` (Nano Banana Pro / Flux 2 Pro / Flux Pro Kontext) or `OPENAI_API_KEY` (`gpt-image-2`).
**Ask for it like:** *"Take Alice's portrait and put her in the diner scene's background image."* · *"Make this look like a noir still."* · *"Blend these three reference images into a single establishing shot."*
**Tips:** This is the right tool when you've got source material to work from. The SPA's inline image dialog uses the same plumbing — provider picker, reference picker, undo.

### Character images

#### `add_character_image`
Attach an image to a character. Same source rules as beat images — Discord upload or public URL.
**API key:** none.
**Ask for it like:** Upload an image and say *"this is what Alice looks like."* · *"Set https://… as Bob's portrait."*
**Tips:** PNG / JPEG / WEBP, up to 100 MB. The first image becomes the character's main image; ask to set a different one to override.

#### `list_character_images`
List the images attached to a character.
**API key:** none.
**Ask for it like:** *"What images do we have for Alice?"*

#### `set_main_character_image`
Promote an existing character image to be the main one.
**API key:** none.
**Ask for it like:** *"Make the second image of Alice the main one."*

#### `remove_character_image`
Remove an image from a character. If the deleted image was the main one, the next one (if any) is promoted automatically.
**API key:** none.
**Ask for it like:** *"Drop the old portrait of Alice."*

#### `attach_library_image_to_character`
Move a library image onto a character. Once attached, it leaves the library.
**API key:** none.
**Ask for it like:** *"Set the second library image as Alice's portrait."*

> **Auto-portraits.** When a character has a real-world actor on file (`hollywood_actor`) and no main image yet, the bot quietly fetches a headshot from TheMovieDB the next time you touch the character — no need to ask. Requires `TMDB_READ_ACCESS_TOKEN`.

### Attachments

Beats, characters, and director notes carry **non-image** files too: audio takes, voice samples, location videos, PDF style guides, draft scripts. Up to 100 MB per file, any content type.

#### `add_beat_attachment` / `list_beat_attachments` / `remove_beat_attachment`
Attach, list, and remove files on a beat. Source is a Discord upload or a public URL.
**API key:** none.
**Ask for it like:** Upload an MP3 and say *"Attach this to the diner scene."* · *"What files are on beat 3?"* · *"Drop the second file from the diner scene."*

#### `add_character_attachment` / `list_character_attachments` / `remove_character_attachment`
Same shape, scoped to a character.
**API key:** none.
**Ask for it like:** Upload a voice sample and say *"Attach this to Alice."*

#### `show_attachment`
Surface an existing attachment in the reply — useful for pulling a previously-uploaded PDF or audio file back into the channel.
**API key:** none.
**Ask for it like:** *"Show me the script PDF I attached to beat 3."*

### Reports & export

#### `export_pdf`
Generate a PDF of the current characters and plot. The bot uploads it to the channel and also posts a download link.
**API key:** none.
**Ask for it like:** *"Export this as a PDF."* · *"Give me a PDF with the title 'Working Draft'."*
**Tips:** The download link is useful when the Discord attachment is too large to display inline, or when you want a stable URL to share.

#### `export_csv`
Build a spreadsheet report of characters or beats. Pick the columns (any field on the entity, plus computed pseudo-fields like `image_count`, `appears_in_beats`, `word_count`), filter rows with operators (`eq`, `contains`, `gt`, `exists`, …), optionally `group_by` a field with aggregates (`sum`, `avg`, `min`, `max`, `count`), and sort. The CSV is delivered as a Discord file attachment.
**API key:** none.
**Ask for it like:** *"Export the characters as a CSV grouped by hollywood actor."* · *"Give me a CSV of beats sorted by word count, biggest first."* · *"How many beats does each character appear in? CSV please."*
**Tips:** Use it when you want to slice the data outside Discord — open in Sheets or Excel, sort, pivot. Column field names match whatever the current character template or beat schema exposes.

#### `token_usage_report`
Show Anthropic and Gemini token consumption for a rolling time window. Returns three charts (per-user stacked bars across billed classes, per-tool token cost, per-tool invocation count) plus a Markdown summary.
**API key:** none.
**Ask for it like:** *"How many tokens have we burned this week?"* · *"Who's been hitting the bot the hardest?"* · *"Which tools cost us the most context?"*
**Tips:** Pick a window — *day* (last 24 h), *week*, *month*, or *total* (all-time). Add a name to focus on one user (*"just my usage this month"*). Useful when you suspect a runaway loop or want to budget against your Anthropic bill.

### TheMovieDB (TMDB)

The TMDB tools require `TMDB_READ_ACCESS_TOKEN`.

#### `tmdb_search_movie`
Search TheMovieDB for movies by title. Returns up to five candidates with id, title, year, short plot preview, and poster URL.
**Ask for it like:** *"Look up the movie *Heat*."* · *"Find *Inception*."*
**Tips:** Always the first step when you mention a real movie by name — the id grounds the more detailed lookups below.

#### `tmdb_get_movie`
Full details for a movie — full plot, runtime, genres, director, top eight cast members (with character names, actor names, and headshots), and poster.
**Ask for it like:** *"Tell me about *Heat* in more detail."* · *"Who directed *Heat* and what's the plot?"*

#### `tmdb_get_movie_credits`
Full cast list for a movie, ordered by billing.
**Ask for it like:** *"Who played the bank robber in *Heat*?"* · *"Give me the full cast of *Heat*."*

#### `tmdb_search_person`
Search for actors, directors, or other crew by name.
**Ask for it like:** *"Find Tilda Swinton."* · *"Look up Christopher Nolan."*

#### `tmdb_show_image`
Display a poster or actor headshot from a TMDB result in the reply.
**Ask for it like:** *"Show me the poster for *Heat*."* · *"Show me Pacino's headshot from that result."*
**Tips:** The URL has to come from a TMDB result — arbitrary image URLs are rejected.

### Tavily web search

The Tavily tools require `TAVILY_API_KEY`.

#### `tavily_search`
Live web search. Returns a summary answer, the top-ranked results, and related image URLs.
**Ask for it like:** *"What's the latest on..."* · *"Search the web for..."* · *"Look up the historical context for the Watergate hearings."*
**Tips:** Use `topic: 'news'` for current events, `time_range` to constrain recency (day / week / month / year), and `include_domains` / `exclude_domains` to focus or filter results (e.g., Wikipedia only). Default search depth is "advanced" (better-curated chunks, costs more credits); switch to "basic" for casual lookups.

#### `tavily_show_image`
Download an image URL from a Tavily result and display it in the reply.
**Ask for it like:** *"Show me that first image from the search results."*
**Tips:** Validates protocol, content type, and size (≤100 MB). Non-image URLs are rejected.

### Writing analysis

#### `find_repeated_phrases`
Scan all beats for overused multi-word phrases — the writing tics that are hard to spot while drafting. Returns ranked phrases with their counts and the beats they appear in.
**API key:** none.
**Ask for it like:** *"What am I overusing?"* · *"Scan the script for repetition."* · *"Is my writing repetitive?"*
**Tips:** Skips phrases that are entirely stopwords. Less reliable with fewer than ~10 beats — the bot will warn you.

#### `check_similarity`
Before adding or editing a character or beat, check whether a near-duplicate already exists.
**API key:** none.
**Ask for it like:** *"Before I add this character, is there one like it already?"* · *"Is the diner scene I'm about to write too close to anything we have?"*
**Tips:** Two modes: compare an existing item against the rest of the corpus, or compare draft text you haven't committed yet. The create / update tools also run this check automatically and tack a heads-up onto their result.

#### `find_character_phrases`
Concatenate every beat that features a character and surface the most-used phrases. Reveals what the character actually does in the script versus what their label says.
**API key:** none.
**Ask for it like:** *"What is Alice actually doing in this script?"* · *"What words come up most around Bob?"*
**Tips:** If a "warrior" character's top phrases are about doubt and conversation, the writing has drifted from the concept — useful as an early-warning tool.

#### `similar_character`
Detect whether a character resembles well-known existing fictional characters from books, films, or TV.
**API key:** `TAVILY_API_KEY`.
**Ask for it like:** *"Does Alice remind you of anyone famous?"* · *"Is my detective derivative?"* · *"Did the homage land?"*
**Tips:** The character's name is intentionally hidden from the analysis so the comparison is "blind". Optionally pass a focus term — *"legal drama"*, *"Russian literature"* — to bias the search.

#### `similar_works`
Detect whether the plot — or a single beat — resembles well-known existing works.
**API key:** `TAVILY_API_KEY`.
**Ask for it like:** *"Does my plot remind you of anything?"* · *"What works does this scene echo?"* · *"Is this story derivative?"*
**Tips:** Defaults to the whole plot. Ask the bot to compare a single beat instead when you want a finer-grained read.

#### `analyze_dramatic_arc`
Score each beat's sentiment and identify the climax — either the beat that deviates most from the baseline, or the one with the steepest sentiment drop. Reports where the climax sits as a 0.0–1.0 position; a healthy three-act climax sits around 0.75–0.90.
**API key:** none.
**Ask for it like:** *"Is my pacing right?"* · *"Where is the climax?"* · *"Is the climax in the right place?"*
**Tips:** Needs at least three beats. Returns "no signal" if every beat reads with identical sentiment.

### Semantic recall (RAG)

#### `screenplay_search`
Meaning-based search across the entire screenplay corpus — every beat body, character custom field, director's note, and recent Discord message. Powered by Voyage embeddings + ChromaDB. Returns the top-k chunks ranked by semantic similarity, each with the entity it came from.
**API key:** `VOYAGE_API_KEY` (plus a running Chroma — comes up automatically with `docker compose up`).
**Ask for it like:** *"Find anywhere I've written about loneliness."* · *"What beats deal with the antagonist's backstory?"* · *"Which character custom fields mention childhood trauma?"*
**Tips:** Reach for this when you remember the *idea* but not the exact phrasing. The index re-builds on a ~1s debounce as you edit, so it stays current; for a one-shot backfill (or after a Mongo wipe) run `npm run reindex`. Without `VOYAGE_API_KEY` the tool returns a friendly fallback message and the rest of the bot keeps working.

### Storyboards, video, and audio

These features are driven from the [Web UI](#web-ui) — open `/storyboard/:order` in the SPA to lay out shots, edit start/end frames, attach audio, and render video clips. The agent doesn't have direct tools for the storyboard pipeline yet; ask in chat and the bot will point you to the SPA, or you can give it a beat reference and ask it to draft a shot list as a text outline that you copy over.

### Compute

#### `calculator`
Arbitrary-precision math: `+`, `-`, `*`, `/`, `^`, `sqrt`, `log`, trig, factorial, modulo.
**API key:** none.
**Ask for it like:** *"What's 12.5% of the runtime if a beat is 4 minutes?"* · *"How many seconds is 2 hours 17 minutes?"*

#### `run_code`
Synchronous JavaScript sandbox for one-off calculations and data shaping. No `require`, no `fetch`, 5 s default timeout.
**API key:** none.
**Ask for it like:** *"Run this snippet to format the character data the way I want."* · *"Sum these durations from the storyboard."*

### Conversation memory

#### `search_message_history`
Search the channel's full message history (beyond the recent 60-message window the bot has in immediate context) using a regex.
**API key:** none.
**Ask for it like:** *"What did we say about the diner scene last month?"* · *"Find that thing I mentioned about Alice's accent."*
**Tips:** Works best with **liberal regexes** that cover spelling variants and synonyms — for "mustache", `must(?:a|ac)he?|moustache|stache`; for "the diner scene", `diner|coffee.?shop|caf[eé]|restaurant`. Use `since_days` / `until_days` for time windows ("last week" → `since_days: 7`; "two-to-three weeks ago" → `since_days: 21, until_days: 7`). Returns role, timestamp, and excerpt for each hit, plus a warning when the scan limit was reached before the bot got to older messages. For meaning-based recall instead of regex, use `screenplay_search` above.
