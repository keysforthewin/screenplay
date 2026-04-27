# screenplay

screenplay is a Discord bot that turns a chat channel into a screenplay-writing workspace. Talk to it like a writers'-room assistant — introduce characters, sketch plot beats, attach reference images, generate concept art, look up real movies and actors, scan your draft for repetition or pacing issues, and export the whole thing as a PDF when you're done.

## Features

- **Mutable character template.** Say "every character should have a favourite colour" and that field is added to every existing and future character.
- **Plot organised into ordered beats.** Each beat has a short name, a one-line summary, and a long-form body that grows over time. A "current beat" pointer means you don't have to re-name the beat on every follow-up.
- **Auto-portraits.** Give a character a real-world actor and the bot quietly attaches a headshot the next time you touch the character.
- **PDF export** of the whole screenplay, posted to Discord and reachable via a download link.
- **Real-movie / real-actor grounding** via TheMovieDB — search films, look up casts, pull posters and headshots.
- **Live web search** via Tavily — ground real-world references, current events, or check whether your character or plot resembles existing fiction.
- **Writing analysis** — scan for overused phrases, detect near-duplicates, examine what a single character actually does in the script, and check whether the climax sits where it should.
- **Searchable conversation memory.** Ask the bot to recall something said weeks ago and it can search the full channel history with regex.

## Quick start

```sh
cp .env.example .env       # then fill in the keys (see Configuration below)
docker compose up --build -d
# talk to the bot in the channel whose ID you set as MOVIE_CHANNEL_ID
```

To stop: `docker compose down`.

## Configuration

The three keys at the top of the table are required. The rest are optional — leave them blank and the corresponding tools will return a friendly "not configured" message instead of breaking the bot.

| Env var | Required? | Where to get it | What it unlocks |
| --- | --- | --- | --- |
| `DISCORD_BOT_TOKEN` | yes | [Discord Developer Portal](https://discord.com/developers/applications) → New Application → Bot → Reset Token. Invite the bot to your server with the `bot` scope and the **Message Content Intent** enabled. | Talking to the bot. |
| `MOVIE_CHANNEL_ID` | yes | In Discord, enable Developer Mode (User Settings → Advanced), then right-click the channel → Copy Channel ID. | Picking which channel the bot listens in. |
| `ANTHROPIC_API_KEY` | yes | [console.anthropic.com](https://console.anthropic.com) → Settings → API Keys → Create Key. Add billing. | Everything the bot says and does. |
| `ANTHROPIC_MODEL` | optional | Defaults to `claude-opus-4-7`. Override to switch models. | Choosing a smarter or cheaper model. |
| `GEMINI_API_KEY` | optional | [aistudio.google.com](https://aistudio.google.com) → "Get API key". The free tier is plenty for development. | AI image generation (`generate_image`). |
| `TMDB_READ_ACCESS_TOKEN` | optional | [themoviedb.org](https://www.themoviedb.org) → Settings → API → request a v4 key (free, instant for personal projects). Use the **v4 read access token** (the long JWT-style string), not the v3 API key. | Real-movie / real-actor lookup (`tmdb_*` tools) and auto-portraits. |
| `TAVILY_API_KEY` | optional | [tavily.com](https://tavily.com) → sign up → API Keys. Free tier is ~1000 searches/month. | Live web search and the "is my character/plot derivative?" tools. |

A handful of additional knobs (PDF download URL, log level, etc.) live in `.env.example` with sensible defaults — touch them only if you need to.

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
**Tips:** Defaults are *plays self: yes*, *own voice: yes*. The bot will create the character as soon as you name them, even if other details aren't known yet — extra fields can be filled in later.

#### `update_character`
Patch fields on an existing character. Only the fields you mention are touched.
**API key:** none.
**Ask for it like:** *"Alice is now 32."* · *"Bob's favourite colour is green."*

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

### Plot

#### `get_plot`
Return the current plot — synopsis, beat list, notes, and which beat is "current".
**API key:** none.
**Ask for it like:** *"What's the plot so far?"* · *"Show me the current plot."*

#### `update_plot`
Modify the synopsis or the freeform notes.
**API key:** none.
**Ask for it like:** *"Update the synopsis to..."* · *"Add a note: be careful about the third-act timing."*
**Tips:** This tool does **not** touch beats — use the beat tools below for those.

### Beats

#### `list_beats`
A compact list of all beats in order — order number, name, short description preview, body length, character count, and which one is current.
**API key:** none.
**Ask for it like:** *"List the beats."* · *"What beats do we have?"*

#### `get_beat`
Fetch the full record for one beat (name, description, body, characters, images).
**API key:** none.
**Ask for it like:** *"Show me the diner scene."* · *"What's in beat 3?"*
**Tips:** You can identify a beat by its order number, its exact name, or its id. If you're vague — *"the one with the diner argument"* — the bot will fall back to **search** automatically.

#### `search_beats`
Substring search across beat name, description, and body. Returns ranked candidates so the bot can disambiguate when you gesture at a beat by description.
**API key:** none.
**Ask for it like:** *"The diner argument."* · *"That scene where Alice leaves."*

#### `create_beat`
Create a new beat. A beat has three text fields: a short **name** (3–6 words, e.g. "Diner Argument"), a 1–2 sentence **description** that's the elevator pitch, and a long-form **body** that grows over time.
**API key:** none.
**Ask for it like:** *"New beat: Alice and Bob argue at the diner over the missing tape."*
**Tips:** Usually leave the body empty on creation and add to it later with **append-to-beat-body**. The first beat you create automatically becomes the current beat.

#### `update_beat`
Patch fields on an existing beat. Renaming, reordering, swapping characters, or replacing the body wholesale all live here.
**API key:** none.
**Ask for it like:** *"Rename beat 3 to 'Confrontation'."* · *"Replace the body of the diner scene with..."*
**Tips:** The body field here **replaces** the existing body. To **add** to the body without overwriting, use `append_to_beat_body`.

#### `append_to_beat_body`
Append more long-form content to a beat's body without overwriting what's there. A blank line separates the new content from the old.
**API key:** none.
**Ask for it like:** *"Also, in the diner scene Bob says: 'Don't pretend you didn't see it.'"*
**Tips:** This is the right tool when you're dumping additional lore onto an existing beat. Defaults to the current beat if you don't name one.

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
**Tips:** PNG / JPEG / WEBP only, up to 25 MB. The first image attached to a beat becomes its main image; ask the bot to set a different image as the main one to override.

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

### Library images

The "library" is a staging area for images that aren't tied to any beat yet — usually images you've generated without a current beat set, or pasted in for later use.

#### `list_library_images`
List unassigned images.
**API key:** none.
**Ask for it like:** *"What images are in the library?"* · *"Show me the unassigned images."*

#### `attach_library_image_to_beat`
Move a library image onto a beat. Once attached, it leaves the library.
**API key:** none.
**Ask for it like:** *"Attach the last image you generated to the diner scene."*

### Image display & generation

#### `show_image`
Display an existing image (whether attached to a beat or sitting in the library) in the bot's reply.
**API key:** none.
**Ask for it like:** *"Show me the main image for beat 3."* · *"Let me see that image again."*

#### `generate_image`
Generate an image with Google's "Nano Banana" model. The bot displays the result in its reply and (by default, when a current beat is set) attaches it to that beat — otherwise the image lands in the library.
**API key:** `GEMINI_API_KEY`.
**Ask for it like:** *"Draw the diner exterior at night."* · *"Generate concept art for this scene."* · *"Show me what Alice looks like in this beat."*
**Tips:** The prompt can be built from your free-form description, the current/named beat, recent chat, or any combination. Aspect ratio defaults to 16:9 and can be set to 1:1, 9:16, 4:3, or 3:4. Only call this when you've actually asked for an image — the bot won't draw on its own.

### Character images

#### `add_character_image`
Attach an image to a character. Same source rules as beat images — Discord upload or public URL.
**API key:** none.
**Ask for it like:** Upload an image and say *"this is what Alice looks like."* · *"Set https://… as Bob's portrait."*
**Tips:** PNG / JPEG / WEBP, up to 25 MB. The first image becomes the character's main image; ask to set a different one to override.

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

> **Auto-portraits.** When a character has a real-world actor on file (`hollywood_actor`) and no main image yet, the bot quietly fetches a headshot from TheMovieDB the next time you touch the character — no need to ask. Requires `TMDB_READ_ACCESS_TOKEN`.

### PDF export

#### `export_pdf`
Generate a PDF of the current characters and plot. The bot uploads it to the channel and also posts a download link.
**API key:** none.
**Ask for it like:** *"Export this as a PDF."* · *"Give me a PDF with the title 'Working Draft'."*
**Tips:** The download link is useful when the Discord attachment is too large to display inline, or when you want a stable URL to share.

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
**Tips:** Validates protocol, content type, and size (≤25 MB). Non-image URLs are rejected.

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

### Conversation memory

#### `search_message_history`
Search the channel's full message history (beyond the recent 60-message window the bot has in immediate context) using a regex.
**API key:** none.
**Ask for it like:** *"What did we say about the diner scene last month?"* · *"Find that thing I mentioned about Alice's accent."*
**Tips:** Works best with **liberal regexes** that cover spelling variants and synonyms — for "mustache", `must(?:a|ac)he?|moustache|stache`; for "the diner scene", `diner|coffee.?shop|caf[eé]|restaurant`. Use `since_days` / `until_days` for time windows ("last week" → `since_days: 7`; "two-to-three weeks ago" → `since_days: 21, until_days: 7`). Returns role, timestamp, and excerpt for each hit, plus a warning when the scan limit was reached before the bot got to older messages.
