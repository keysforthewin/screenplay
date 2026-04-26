# Frontend test catalog

Source of truth for which tools get exercised and how each result is verified.
The Claude session running the suite reads this file, substitutes `${runId}`
in prompts, sends them via Chrome DevTools MCP, and applies the verify rule to
the bot's reply. Capture columns name a context key that becomes available to
later tests (e.g. `hero_img1` is the image id captured from T3.1, used by T3.5).

Notation: `[ro]` read-only · `[mut]` mutating · `[gen]` LLM/generation ·
`[net]` external API · `verify` types: `text` regex, `attach` count + optional
filename regex, `readback` follow-up assertion, `capture` extract id.

`runId` is a base-36 timestamp, e.g. `lwz9k3a`. Image URLs:
- `URL_A`: `https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/640px-Cat03.jpg`
- `URL_B`: `https://upload.wikimedia.org/wikipedia/commons/thumb/4/4d/Cat_November_2010-1a.jpg/640px-Cat_November_2010-1a.jpg`

## Phase 0 — Pre-flight

| ID | Tool | Prompt | Verify |
|---|---|---|---|
| P0.1 | `delete_beat` (sweep) | Delete every beat whose name starts with `T_`. Don't ask for confirmation; just do it and report how many were removed. | text: matches `/(deleted|removed|no .* beats)/i`; no `Tool error` |
| P0.2 | `list_characters` | List all characters by name. | text: not `/Tool error/i` |
| P0.3 | `get_plot` | What's the current plot synopsis and notes? | text: not `/Tool error/i` |
| P0.4 | `get_character_template` | Show me the character template fields. | text: contains `name` (core field) and not `/Tool error/i` |

## Phase 1 — Character template & CRUD

| ID | Tool | Prompt | Verify |
|---|---|---|---|
| T1.1 | `update_character_template` (add) | Add a `tagline` string field to the character template. Optional, not core. | text: `/template updated/i` AND contains `tagline` |
| T1.2 | `get_character_template` (readback) | Show me the character template fields again. | text: contains `tagline` |
| T1.3 | `create_character` (plays_self=true) | Create a character named `T_${runId}_Hero` who plays themself, with their own voice. Tagline: "tries hard, fails harder." | text: `/created character.*T_${runId}_Hero.*[a-f0-9]{24}/is`; capture `hero_id` from `_id [a-f0-9]{24}` |
| T1.4 | `create_character` (with hollywood_actor) | Create a character named `T_${runId}_Villain`. They don't play themselves — they're played by Anthony Hopkins. Use the actor's voice. | text: `/created character.*T_${runId}_Villain/i`; capture `villain_id` |
| T1.5 | `list_characters` (readback) | List every character by name. | text: contains BOTH `T_${runId}_Hero` AND `T_${runId}_Villain` |
| T1.6 | `get_character` | Show me the full record for `T_${runId}_Hero`. | text: contains `tries hard` AND `plays_self` (or `plays themself`) |
| T1.7 | `update_character` | Update `T_${runId}_Villain` — set their tagline to "the architect of woe". | text: `/architect of woe/i` |
| T1.8 | `search_characters` | Search characters for the substring `T_${runId}`. | text: contains BOTH `T_${runId}_Hero` AND `T_${runId}_Villain` |
| T1.9 | `update_character_template` (remove) | Remove the `tagline` field from the character template. | text: `/template updated/i` (and `tagline` no longer in fields list) |
| T1.10 | `update_character_template` (reject core) | Remove the `name` field from the character template. | text: `/(core|cannot|refuse|reject|protected)/i` referring to refusal — must NOT report success |

## Phase 2 — Plot & beats

| ID | Tool | Prompt | Verify |
|---|---|---|---|
| T2.1 | `update_plot` | Set the plot synopsis to: "A brittle prodigy and a charming wreck must rob a bank that stole their father." Notes: "draft 1, no act breaks yet". | text: `/plot updated/i` |
| T2.2 | `get_plot` (readback) | What's the plot synopsis right now? | text: contains `brittle prodigy` |
| T2.3 | `create_beat` (auto current) | Create a beat named `T_${runId}_Open` described as "hero meets mentor at a diner". | text: contains `T_${runId}_Open` AND a 24-hex id; capture `open_id` |
| T2.4 | `create_beat` (explicit order) | Create a beat named `T_${runId}_Mid` at order 2: "villain reveals plan". | text: contains `T_${runId}_Mid`; capture `mid_id` |
| T2.5 | `create_beat` | Create a beat named `T_${runId}_Close` at order 3: "showdown on the rooftop". | text: contains `T_${runId}_Close`; capture `close_id` |
| T2.6 | `list_beats` (readback) | List all beats. | text: contains all three of `T_${runId}_Open`, `T_${runId}_Mid`, `T_${runId}_Close` |
| T2.7 | `search_beats` | Search beats for the word `rooftop`. | text: contains `T_${runId}_Close` |
| T2.8 | `get_beat` (by name) | Show me the beat called `T_${runId}_Mid` in full. | text: contains `villain reveals` |
| T2.9 | `set_current_beat` | Set the current beat to `T_${runId}_Mid`. | text: `/current beat now/i` AND contains `T_${runId}_Mid` |
| T2.10 | `get_current_beat` (readback) | What's the current beat? | text: contains `T_${runId}_Mid` |
| T2.11 | `update_beat` | Update `T_${runId}_Mid` — set body to: `INT. WAREHOUSE - NIGHT\nVILLAIN steps from shadow.` | text: `/updated beat/i` |
| T2.12 | `append_to_beat_body` | Append to the current beat's body: "He smiles. Cut to black." | text: `/appended/i` AND `/\d+ char/i` |
| T2.13 | `link_character_to_beat` | Link `T_${runId}_Hero` to the current beat. | text: `/linked/i` AND contains `T_${runId}_Hero` |
| T2.14 | `link_character_to_beat` (idempotent) | Link `T_${runId}_Hero` to the current beat again. | text: doesn't error; mentions Hero is already linked OR returns the same character list |
| T2.15 | `unlink_character_from_beat` | Unlink `T_${runId}_Hero` from the current beat. | text: `/unlinked/i` |
| T2.16 | `clear_current_beat` | Clear the current beat — no beat should be current anymore. | text: `/current beat cleared/i` OR `/cleared/i` |
| T2.17 | `get_current_beat` (readback) | What's the current beat? | text: indicates none / not set |

## Phase 3 — Character images

| ID | Tool | Prompt | Verify |
|---|---|---|---|
| T3.1 | `add_character_image` | Add this image to `T_${runId}_Hero`: `URL_A` — caption "headshot ${runId}". | text: contains a 24-hex id; capture `hero_img1` |
| T3.2 | `add_character_image` (second) | Add another image to `T_${runId}_Hero` from `URL_B` — caption "alt ${runId}". | text: contains a 24-hex id (different from `hero_img1`); capture `hero_img2` |
| T3.3 | `list_character_images` | List images attached to `T_${runId}_Hero`. | text: contains BOTH `hero_img1` AND `hero_img2` |
| T3.4 | `set_main_character_image` | Make image `${hero_img2}` the main image for `T_${runId}_Hero`. | text: `/main image set/i` |
| T3.5 | `remove_character_image` | Remove image `${hero_img1}` from `T_${runId}_Hero`. | text: `/removed image/i` |

## Phase 4 — Beat images, library, display

| ID | Tool | Prompt | Verify |
|---|---|---|---|
| T4.1 | `set_current_beat` (re-arm) | Set the current beat to `T_${runId}_Open`. | text: `/current beat now/i` AND `T_${runId}_Open` |
| T4.2 | `add_beat_image` | Add this image to the current beat: `URL_A` — caption "diner ${runId}". | text: contains a 24-hex id; capture `beat_img1` |
| T4.3 | `list_beat_images` | List images on the current beat. | text: contains `beat_img1` |
| T4.4 | `set_main_beat_image` | Make `${beat_img1}` the main image for the current beat. | text: `/main image set/i` |
| T4.5 | `show_image` | Show me image `${beat_img1}`. | attach: imageUrls.length >= 1 |
| T4.6 | `remove_beat_image` | Remove `${beat_img1}` from the current beat. | text: `/removed image/i` |
| T4.7 | `list_library_images` | List the unattached library images. | text: not `/Tool error/i` |

## Phase 5 — Image generation (Gemini), 90s timeout

| ID | Tool | Prompt | Verify |
|---|---|---|---|
| T5.1 | `generate_image` (library only) | Generate an image with the prompt: "moody noir alleyway, neon puddle reflections, 16:9 cinematic". Save to library — DON'T attach to any beat. | attach: imageUrls.length >= 1; capture `gen_img1` from a 24-hex id in text |
| T5.2 | `attach_library_image_to_beat` | Attach library image `${gen_img1}` to the current beat as the main image. | text: `/attached/i` AND `/main/i` |
| T5.3 | `generate_image` (with beat) | Generate an image based on the current beat's content. Square aspect ratio. Attach it to the current beat. | attach: imageUrls.length >= 1 |
| T5.4 | `generate_image` (with chat context) | Generate an image inspired by the recent chat in this channel — wide aspect ratio, save to library only. | attach: imageUrls.length >= 1 |

## Phase 6 — TMDB

| ID | Tool | Prompt | Verify |
|---|---|---|---|
| T6.1 | `tmdb_search_movie` | Look up the movie "The Matrix" on TMDB. | text: contains `603` AND `1999` |
| T6.2 | `tmdb_get_movie` | Get full TMDB details for movie id 603. | text: matches `/(wachowski\|runtime\|genre)/i` (at least one of the three) |
| T6.3 | `tmdb_get_movie_credits` | Get the full cast credits for TMDB movie 603. | text: contains `Keanu Reeves` |
| T6.4 | `tmdb_search_person` | Search TMDB for the actor Cate Blanchett. | text: contains `Cate Blanchett` |
| T6.5 | `tmdb_show_image` | Pull and display the Matrix poster from TMDB (the poster URL on image.tmdb.org). | attach: imageUrls.length >= 1 |
| T6.6 | `tmdb_show_image` (negative) | Show me this image from TMDB: `https://example.com/poster.jpg` | text: `/(image.tmdb.org\|not a tmdb\|invalid)/i` and NO image attachment |

## Phase 7 — Tavily

| ID | Tool | Prompt | Verify |
|---|---|---|---|
| T7.1 | `tavily_search` (basic) | Search the web for "screenwriting save the cat beat sheet". Show me the top results. | text: contains `http` URLs; matches `/(blake snyder\|save the cat\|beat sheet)/i` |
| T7.2 | `tavily_search` (advanced + filters) | Search news from the past week for "Cannes film festival 2026 lineup". Use advanced search depth, max 5 results. | text: contains `http` URLs; matches `/(cannes\|festival\|lineup)/i` |
| T7.3 | `tavily_show_image` | Show this image: `URL_A` — caption "library cat". | attach: imageUrls.length >= 1 |

## Phase 8 — PDF export

| ID | Tool | Prompt | Verify |
|---|---|---|---|
| T8.1 | `export_pdf` (default title) | Export the current screenplay as a PDF. | attach: fileLinks matches `/screenplay-\d+\.pdf/`; capture `pdf_filename` |
| T8.2 | `export_pdf` (custom title) | Export the screenplay as a PDF titled "Test Run ${runId}". | attach: fileLinks matches `/\.pdf/` |

## Phase 9 — Web server (out-of-band, not via Discord)

Executed via Bash `curl` against `http://localhost:${WEB_PORT:-3000}`.

| ID | Endpoint | Verify |
|---|---|---|
| T9.1 | `GET /health` | status 200; body `{"ok":true}` |
| T9.2 | `GET /pdf/${pdf_filename}` | status 200; content-type `application/pdf` |

## Phase 10 — Cleanup

| ID | Tool | Prompt | Verify |
|---|---|---|---|
| C10.1 | `delete_beat` × 3 | Delete every beat whose name starts with `T_${runId}_`. | text: `/deleted/i` (one or more times); not `/Tool error/i` |
