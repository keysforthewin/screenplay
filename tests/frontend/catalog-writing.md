# Frontend test catalog (writing edition)

A creation-only behavior test. Same harness, same Discord channel, same bot —
but written purely from a writer's-eye-view, building a story from a blank
slate and ending with a PDF that becomes the artifact under evaluation.

The other catalogs (`catalog.md`, `catalog-stoner.md`, `catalog-normie.md`)
each exercise the **full** tool surface, including destructive operations and
edge cases — they answer "does every tool route correctly?" This catalog
answers a different question: *given a writer chain-of-thought-ing through a
new story, does the bot help them produce something worth reading?* The PDF at
the end is the test. Story quality is the verifier of last resort.

Two consequences shape the design:

1. **Pure additive.** No `delete_*`, `unlink_*`, `remove_*image`, no template
   field changes, no negative tests. Every turn either creates content or
   reads it back. **6 of the 42 tools are deliberately skipped** — see the
   table at the bottom for the list.
2. **Hard reset at start.** Phase P0 wipes every story-bearing collection and
   the GridFS buckets, then re-seeds the templates from defaults. No
   prefix-based namespacing — the wipe handles isolation. **Sequential runs
   only**; do not run this concurrently with any other catalog (they share the
   same DB and this catalog will obliterate their state at P0).

## Story

**The Quiet Year** — a sci-fi indie drama. A small Vermont town discovers a
strange object in the woods one autumn morning. Three characters:

- **Lily** — 17, the town's amateur photographer. Plays herself, own voice
  (this is a YA-cast indie, not a vehicle for an A-lister).
- **Sheriff Marcus** — gruff but thoughtful local sheriff trying to hold the
  town together. Played by **Brian Tyree Henry**.
- **Dr. Ana Rivera** — visiting astrophysicist who shows up the next day.
  Played by **Michelle Yeoh**.

Three beats:

1. **The Discovery** — Lily, out at dawn shooting fall colors, finds the
   object in a clearing.
2. **The Investigation** — Marcus and Ana arrive at the site; the town
   gathers; tension between protect-and-preserve vs. evacuate.
3. **The Choice** — Lily at her desk that night, photos on her laptop, has to
   decide whether to share them.

Reference film: **Arrival (2016)**.

## Format

Each phase is a section. Each turn within a phase is a sub-section with four
parts:

- **`> writer: …`** — the literal user utterance, sent verbatim to Discord.
  Conversational, occasionally lowercased, no jargon. **Never names a tool
  or field.**
- **Expected** — what the bot should do this turn.
- **Verify** — concrete pass criteria. Same primitives as the other catalogs
  (`text matches /…/`, `attach: count rule`, `capture <key> from /…/`,
  `state: list_X length grew by N` / `unchanged`), plus optional post-call
  `get_<tool>(arg)` reads.
- **Follow-up if asked** *(optional)* — guidance for the harness when the bot
  asks a clarifying question instead of (or in addition to) completing the
  expected action. The harness should answer in character based on the Story
  section above.

The harness behavior matches `catalog-normie.md`: send the prompt, read the
reply, evaluate every clause in `Verify`, log pass/fail, and **continue to the
next turn regardless** so a single missed clarifying question doesn't poison
the whole run.

**Adaptive responses.** If the bot asks a focused follow-up, the harness
should answer using the Story section above — never stay silent. Verify
clauses are evaluated against the eventual state (after any follow-up
exchange), not the immediate first reply.

## Run isolation

Phase P0 wipes the database before any Discord turn fires, so this catalog
never collides with itself between runs. There's no `${runId}` prefix on
characters or beats — they're just "Lily", "Marcus", "Ana", "The Discovery"
etc. Re-running the catalog produces an identical fresh state.

**Not parallel-safe.** P0 wipes shared collections. If another catalog
(`catalog.md`, `catalog-stoner.md`, `catalog-normie.md`) is mid-run against
the same DB, this catalog will destroy its state. Run sequentially.

## Image URLs

Reused verbatim from the other catalogs:

- `URL_A`: `https://upload.wikimedia.org/wikipedia/commons/3/3a/Cat03.jpg`
- `URL_B`: `https://upload.wikimedia.org/wikipedia/commons/4/4d/Cat_November_2010-1a.jpg`

(Yes, they're cats. The writer pretends they're placeholders. The existing
catalogs proved these URLs survive Wikimedia hotlink protection with a
User-Agent header.)

---

## Phase P0 — Hard reset (out-of-band, harness-driven)

Executed via Bash, **NOT through Discord**.

### Turn P0.1 — wipe and re-seed

Pick the invocation that matches the user's setup:

- **Docker-based setup (default — `docker compose up`).** The Dockerfile only
  copies `src/`, so the test script has to be staged into the running
  container before each run:
  ```bash
  docker exec screenplay-bot-1 mkdir -p /app/tests/frontend && \
    docker cp tests/frontend/clear-db.js screenplay-bot-1:/app/tests/frontend/clear-db.js && \
    docker exec screenplay-bot-1 node /app/tests/frontend/clear-db.js
  ```
- **Host-based setup (`npm run dev` against a local mongo on port 27017):**
  `node tests/frontend/clear-db.js`

Either form should exit 0 with stdout matching
`/cleared \d+ docs.*templates re-seeded/i`.

After this command runs, the DB has zero characters, zero beats, zero
messages, zero images, and freshly-seeded `character_template` and
`plot_template` documents. The bot is still running and will rebuild its
system prompt from this empty state on the next user message
(`src/agent/loop.js` rebuilds every iteration). No bot restart required.

---

## Phase P1 — Greeting & state recap (the writer arrives)

### Turn 1.1 — first contact
> writer: hi

Expected: Bot greets and recaps the (now empty) state via `get_overview` or
`get_plot` + `list_characters`. Should offer to start something since the DB
is empty.
Verify:
- text matches `/(hi|hello|hey|welcome)/i`
- AND text matches `/(empty|blank|nothing|fresh|start|begin|new)/i`
- AND no `Tool error`

### Turn 1.2 — invitation
> writer: yeah lets start something fresh. i have a story idea

Expected: Bot encourages a pitch — asks for the premise, characters, or
genre. Should NOT dump a tool list at the user.
Verify:
- text matches `/(tell me|what.*about|pitch|kick.*off|story|idea|premise|sounds)/i`
- AND text does NOT match `/(tool|function|api|endpoint|schema|json)/i`

---

## Phase P2 — Pitch the story

### Turn 2.1 — the pitch
> writer: ok. its a quiet sci-fi indie drama. small vermont town in autumn. one morning a teenager finds a strange object out in the woods and the whole town has to figure out what to do about it. its more about the people than the object

Expected: Bot calls `update_plot` with this as the synopsis. May ask a
clarifying question first; if so, the harness re-evaluates after the bot
completes the update.
Verify:
- text matches `/(plot updated|saved|got it|synopsis|sounds|love it)/i`
- AND post-call `get_plot` returns a synopsis containing `vermont` AND (`object` OR `woods` OR `town`)
- AND no `Tool error`

Follow-up if asked: If the bot asks for the protagonist or genre details
before saving, answer: `the protagonist is a teenage girl named lily. genre
is sci-fi drama, intimate scale, character-driven.` The harness then
re-evaluates.

---

## Phase P3 — Lily

### Turn 3.1 — introduce the protagonist
> writer: the protagonist is lily. shes 17, an amateur photographer who roams the woods around town. shes the one who finds the thing

Expected: Bot calls `create_character` with `name='Lily'` (defaults
`plays_self=true`, `own_voice=true`). May follow up about casting.
Verify:
- text matches `/(created|added|meet|here.*lily|got it)/i` AND contains `lily`
- AND post-call `list_characters` returns a character matching `/^lily$/i`
- AND capture `lily_id` from a 24-hex id in text (or via post-call `get_character('Lily')`)
- AND no `Tool error`

Follow-up if asked: If the bot asks about casting/voice before creating,
answer: `shes not a famous actor or anything, just a teenager. plays
herself, own voice.` The harness then re-evaluates.

### Turn 3.2 — confirm casting defaults
> writer: yeah she plays herself, own voice, no actor

Expected: Bot either confirms the existing defaults (no tool call) or calls
`update_character` to make them explicit. Either is acceptable.
Verify:
- post-call `get_character(lily_id)` returns `plays_self === true`
- AND `own_voice === true`
- AND `hollywood_actor` empty/null
- AND text matches `/(plays herself|her own voice|yeah|got it|already|confirmed)/i`

### Turn 3.3 — peek at the schema
> writer: actually whats in the character profile thing? like what fields can i fill in

Expected: Bot calls `get_character_template` and lists the fields.
Verify:
- text contains `name`
- AND text matches `/(plays_self|hollywood_actor|own_voice|background|origin|arc|events|memes)/i` (at least one optional field)
- AND no `Tool error`

### Turn 3.4 — fill in the arc
> writer: ok lilys arc is — shes always observing through a lens, never participating. by the end she has to choose between documenting the moment or being in it

Expected: Bot calls `update_character('Lily', { patch: { fields: { arc: '...' } } })`.
Verify:
- text matches `/(saved|updated|added|got it|noted)/i`
- AND post-call `get_character(lily_id).fields.arc` matches `/lens|observ|document|particip/i`

### Turn 3.5 — and a memorable detail
> writer: also her camera is an old pentax k1000 her mom left behind. add that as background or origin or whatever fits

Expected: Bot calls `update_character` setting one of the optional fields
(`background_story`, `origin_story`, or `events`) with the camera detail.
Verify:
- text matches `/(saved|added|noted)/i`
- AND post-call `get_character(lily_id)` returns at least one `fields.*` value containing `pentax` OR `camera` OR `mom`
- AND no `Tool error`

---

## Phase P4 — Sheriff Marcus + TMDB person lookup

### Turn 4.1 — introduce the sheriff
> writer: next up. the town sheriff. marcus. hes the one trying to keep things from spiraling when the town starts to come apart. i want him played by brian tyree henry

Expected: Bot calls `create_character` with `name='Marcus'`,
`plays_self=false`, `hollywood_actor='Brian Tyree Henry'`. May split into
`create_character` + `update_character` — both fine.
Verify:
- text matches `/(created|added|meet|cast|got marcus)/i`
- AND post-call `list_characters` returns a character matching `/^marcus$|^sheriff marcus$/i`
- AND post-call `get_character('Marcus')` returns `plays_self === false` AND `hollywood_actor` matching `/brian tyree henry/i`
- AND capture `marcus_id`

### Turn 4.2 — research the actor
> writer: hes been in stuff right? whats he known for

Expected: Bot calls `tmdb_search_person('Brian Tyree Henry')` and reports the
known-for titles.
Verify:
- text contains `brian tyree henry` (case-insensitive)
- AND text matches `/(atlanta|causeway|spider-verse|if beale street|bullet train|eternals)/i`
- AND no `Tool error`

### Turn 4.3 — show the headshot
> writer: cool. show me what he looks like

Expected: Bot calls `tmdb_show_image` with the headshot URL from 4.2.
Verify:
- attach: `(imageUrls.length + fileLinks.length) >= 1`
- AND no `Tool error`

---

## Phase P5 — Dr. Ana Rivera + reference film

### Turn 5.1 — introduce the astrophysicist
> writer: third character. a visiting astrophysicist who shows up the day after the discovery. dr ana rivera. michelle yeoh i think — she has that mix of warmth and authority

Expected: Bot calls `create_character('Ana')` and `update_character` setting
`plays_self=false`, `hollywood_actor='Michelle Yeoh'`.
Verify:
- text matches `/(created|added|cast|got ana|meet ana|meet dr)/i`
- AND post-call `list_characters` returns a character matching `/^ana$|^dr.*ana|^ana rivera$/i`
- AND post-call `get_character('Ana')` returns `hollywood_actor` matching `/michelle yeoh/i`
- AND capture `ana_id`

### Turn 5.2 — fill in her arc
> writer: anas arc — she came thinking shed find a discovery to put her name on, leaves realizing the people are more interesting than the object

Expected: Bot calls `update_character('Ana')` setting one of the optional
fields with this arc text.
Verify:
- text matches `/(saved|added|got it|noted)/i`
- AND post-call `get_character(ana_id)` returns at least one `fields.*` value containing `discovery` OR `people` OR `object` OR `name`

### Turn 5.3 — reference the tone
> writer: tone-wise this should feel like arrival, the amy adams movie. you know it?

Expected: Bot calls `tmdb_search_movie('Arrival')`. May filter by year=2016
to disambiguate.
Verify:
- text contains `arrival` (case-insensitive)
- AND text matches `/2016|villeneuve|amy adams|denis/i`
- AND capture `arrival_movie_id` (numeric TMDB id from text or search results)
- AND no `Tool error`

### Turn 5.4 — get the deeper details
> writer: tell me more about that one. the plot, the runtime, all that

Expected: Bot calls `tmdb_get_movie(arrival_movie_id)`.
Verify:
- text matches `/(linguist|heptapod|alien|villeneuve|sci-fi|drama)/i`
- AND text matches `/runtime|min|hour/i`
- AND no `Tool error`

### Turn 5.5 — full cast
> writer: who else was in it

Expected: Bot calls `tmdb_get_movie_credits(arrival_movie_id)`.
Verify:
- text contains `amy adams` (case-insensitive)
- AND text matches `/jeremy renner|forest whitaker/i`
- AND no `Tool error`

---

## Phase P6 — Character images (URL-based)

Note: `generate_image` does not support a character target — it attaches to
beats or the library only. This phase uses URL-based images for characters;
generated character portraits aren't part of the tool surface.

### Turn 6.1 — placeholder image for Lily
> writer: ok i found a placeholder picture for lily online. heres one: https://upload.wikimedia.org/wikipedia/commons/3/3a/Cat03.jpg

Expected: Bot calls `add_character_image('Lily', URL_A)`. First image
auto-becomes main.
Verify:
- text matches `/(added|saved|attached|here.*lily|now lily has)/i`
- AND post-call `list_character_images('Lily')` returns at least 1 image
- AND capture `lily_img1` from a 24-hex id in text (or first image returned by `list_character_images`)
- AND no `Tool error`

Follow-up if asked: If the bot hedges based on the URL filename (e.g.,
"that's a cat picture, are you sure?"), answer: `yeah just use it as a
placeholder, ill find a real one later`. Verify clauses are evaluated
against the follow-up reply.

### Turn 6.2 — what's on file
> writer: what pictures does lily have right now

Expected: Bot calls `list_character_images('Lily')`.
Verify:
- text contains `lily_img1` (or filename / caption fragments)
- AND text matches `/(1 image|one image|main|here.*pic)/i`
- AND no `Tool error`

### Turn 6.3 — second placeholder
> writer: actually i found a better one: https://upload.wikimedia.org/wikipedia/commons/4/4d/Cat_November_2010-1a.jpg

Expected: Bot calls `add_character_image` with the second URL.
Verify:
- text matches `/(added|saved|attached)/i`
- AND post-call `list_character_images('Lily')` returns at least 2 images
- AND capture `lily_img2` from the new id

### Turn 6.4 — promote the new one
> writer: lets use the second one as her main pic, the first one was kind of dark

Expected: Bot calls `set_main_character_image` for `lily_img2`.
Verify:
- text matches `/(main|primary|profile).*(image|picture|pic)/i`
- AND post-call `list_character_images('Lily')` shows `lily_img2` flagged as main

---

## Phase P7 — World research (Tavily)

### Turn 7.1 — research the setting
> writer: hey what does fall in vermont actually look like? like the woods, the colors, the feel

Expected: Bot calls `tavily_search` with a query about autumn / fall foliage
in Vermont. Returns answer summary, results, possibly image URLs.
Verify:
- text contains at least one `http` URL
- AND text matches `/(maple|foliage|leaves|new england|vermont|orange|red)/i`
- AND no `Tool error`
- AND capture `tavily_image_url` (any `https?://...\.(jpg|jpeg|png|webp)` URL from the bot's reply)

### Turn 7.2 — show one of the pics
> writer: cool, show me one of the pictures from that

Expected: Bot calls `tavily_show_image` with one of the image URLs from 7.1.
Verify:
- attach: `(imageUrls.length + fileLinks.length) >= 1`
- AND no `Tool error`
- Note: If 7.1 returned no image URLs, this turn legitimately fails. The
  harness should report "blocked by 7.1 having no images" rather than "7.2
  broken."

---

## Phase P8 — Beat 1 (The Discovery)

### Turn 8.1 — pitch the first scene
> writer: ok first scene. dawn. lily is out in the woods shooting fall colors. she walks into a clearing and theres this object — like nothing shes ever seen. shes frozen. she takes one photo before her hands start shaking too much

Expected: Bot calls `create_beat`. Picks a name like "The Discovery",
"Through the Trees", "Dawn Clearing" — bot's choice. desc captures the
user's pitch.
Verify:
- text matches `/(created|added|new beat|scene|first beat)/i` AND contains a 24-hex id
- AND post-call `list_beats` returns at least 1 beat
- AND capture `discovery_id` from a 24-hex id in text
- AND capture `discovery_name` (the bot-chosen beat name) from the bot's reply

### Turn 8.2 — confirm current beat
> writer: what scene we on?

Expected: Bot calls `get_current_beat`. The first beat created auto-becomes
current, so this returns the discovery beat.
Verify:
- text contains `discovery_name` (or the beat id)
- AND no `Tool error`

### Turn 8.3 — append sensory detail
> writer: also in this scene you can hear the wind in the leaves and the click of her camera shutter, kind of unnaturally loud against the silence. add that

Expected: Bot calls `append_to_beat_body` (NOT `update_beat` — the user said
"add that").
Verify:
- text matches `/(added|appended|tacked on|noted)/i`
- AND post-call `get_beat(discovery_id)` returns `body` containing `(wind|leaves|shutter|silence)` (at least one)

### Turn 8.4 — link Lily
> writer: lily is in this scene obviously, shes the only one

Expected: Bot calls `link_character_to_beat` to add Lily.
Verify:
- text matches `/(linked|added|in this scene|lily)/i`
- AND post-call `get_beat(discovery_id)` returns `characters` containing `Lily`

### Turn 8.5 — placeholder image
> writer: i want a picture for this scene to start. heres one: https://upload.wikimedia.org/wikipedia/commons/3/3a/Cat03.jpg

Expected: Bot calls `add_beat_image` (no `beat` arg → uses current).
Verify:
- text matches `/(added|attached|saved|here)/i`
- AND post-call `list_beat_images()` returns at least 1 image
- AND capture `discovery_url_img`

Follow-up if asked: If the bot hedges on the URL filename, answer: `yeah
attach it, its a placeholder for now`.

### Turn 8.6 — generate the real one
> writer: actually generate a real one for this scene — atmospheric forest clearing at dawn, soft mist, hint of the strange object glowing faintly. vertical shape

Expected: Bot calls `generate_image` with `aspect_ratio='9:16'`,
`include_beat=true` (or just `prompt`), `attach_to_current_beat=true`
(default when current beat is set).
Verify:
- attach: `(imageUrls.length + fileLinks.length) >= 1`
- AND post-call `list_beat_images()` returns at least 2 images
- AND capture `discovery_gen_img` from a 24-hex id in the bot's reply
- AND no `Tool error`

### Turn 8.7 — promote the generated one
> writer: yeah make the new one the main pic for this scene

Expected: Bot calls `set_main_beat_image` for `discovery_gen_img`.
Verify:
- text matches `/(main|primary).*image/i`
- AND post-call `list_beat_images()` shows `discovery_gen_img` flagged as main

### Turn 8.8 — list images
> writer: what pics do we have on this scene

Expected: Bot calls `list_beat_images`.
Verify:
- text matches `/(2 images|two images|main)/i`
- AND text contains a reference to either the URL image or the generated image
- AND no `Tool error`

---

## Phase P9 — Beat 2 (The Investigation)

### Turn 9.1 — pitch the second scene
> writer: next scene. marcus arrives at the clearing first, then ana shows up that afternoon. the towns folk are gathering at the edge. some want to call the army, some want to leave it alone. theres tension, maybe some shouting

Expected: Bot calls `create_beat`. Bot picks a name.
Verify:
- text matches `/(created|added|new scene|next scene|added.*beat)/i`
- AND post-call `list_beats` returns at least 2 beats
- AND capture `investigation_id` from a 24-hex id in text
- AND capture `investigation_name`

### Turn 9.2 — rename if needed
> writer: actually call that scene "The Investigation"

Expected: Bot calls `update_beat` to set `name='The Investigation'`. (If the
bot already chose this name in 9.1, it may say "we already have that" — also
acceptable.)
Verify:
- post-call `get_beat(investigation_id).name` matches `/the investigation/i`
- AND text matches `/(renamed|updated|already|the investigation)/i`

### Turn 9.3 — append a detail
> writer: add a detail — ana brings a geiger counter that ticks slow but steady, like a heartbeat. its the only sound for a while

Expected: Bot calls `append_to_beat_body` for the investigation beat.
Verify:
- text matches `/(added|appended|noted)/i`
- AND post-call `get_beat(investigation_id).body` contains `geiger` OR `heartbeat` OR `tick`

### Turn 9.4 — link multiple characters
> writer: marcus and ana are both in this scene. lily is hanging back at the edge of the crowd

Expected: Bot calls `link_character_to_beat` for Marcus, Ana, and Lily —
likely three separate calls or one if the tool batched (it doesn't, so three
calls expected).
Verify:
- text matches `/(linked|added|in this scene)/i`
- AND post-call `get_beat(investigation_id).characters` contains `Marcus`, `Ana`, AND `Lily` (case-insensitive)
- AND no `Tool error`

### Turn 9.5 — generate an image
> writer: generate a picture for this one — daylight clearing, group of townspeople in heavy autumn jackets, sheriff and a woman in a parka with equipment, square shape

Expected: Bot calls `generate_image` with `aspect_ratio='1:1'`,
`include_beat=true`, attached to current beat. The current beat may still be
the discovery beat from P8 — bot may need to call `set_current_beat` first
or pass `beat=investigation_id` to `generate_image`. Either path works.
Verify:
- attach: `(imageUrls.length + fileLinks.length) >= 1`
- AND post-call `list_beat_images(investigation_id)` returns at least 1 image
- AND no `Tool error`

---

## Phase P10 — Beat 3 (The Choice)

### Turn 10.1 — pitch the final scene
> writer: last scene. that night, lilys at her desk in her bedroom. shes got the photos on her laptop. theres a missed call from a journalist friend. she has to choose — share them or delete them. the scene ends on her cursor hovering over send

Expected: Bot calls `create_beat`. Bot picks a name like "The Choice", "The
Decision", "Cursor Hovering".
Verify:
- text matches `/(created|added|new scene|last scene|final)/i`
- AND post-call `list_beats` returns at least 3 beats
- AND capture `choice_id` from a 24-hex id in text
- AND capture `choice_name`

### Turn 10.2 — link Lily only
> writer: just lily in this one. shes alone

Expected: Bot calls `link_character_to_beat` to add Lily to the choice beat.
Verify:
- text matches `/(linked|added|just lily|alone)/i`
- AND post-call `get_beat(choice_id).characters` contains `Lily`
- AND `get_beat(choice_id).characters` does NOT contain `Marcus` or `Ana`

### Turn 10.3 — append a detail
> writer: also — out her bedroom window you can see the woods in the distance. one tree branch is lit up by a streetlight. weird detail to notice but she does

Expected: Bot calls `append_to_beat_body` for the choice beat.
Verify:
- text matches `/(added|appended|noted)/i`
- AND post-call `get_beat(choice_id).body` contains `window` OR `branch` OR `streetlight` OR `tree`

### Turn 10.4 — generate an image
> writer: make a picture for this one — close on a glowing laptop screen in a dark teenager bedroom, vertical shape, moody

Expected: Bot calls `generate_image` with `aspect_ratio='9:16'`,
`include_beat=true`, attached to the choice beat. May need to
`set_current_beat` first.
Verify:
- attach: `(imageUrls.length + fileLinks.length) >= 1`
- AND post-call `list_beat_images(choice_id)` returns at least 1 image
- AND no `Tool error`

---

## Phase P11 — Library image, then attach

### Turn 11.1 — focus on a beat first
> writer: ok lets back up. focus on the discovery scene again

Expected: Bot calls `set_current_beat` for the discovery beat.
Verify:
- text matches `/(current|now on|focused|working on|back to).*(discovery|first|opening)/i`
  OR text contains `discovery_name`
- AND post-call `get_current_beat` returns the discovery beat

### Turn 11.2 — generate to library
> writer: hey can you generate a movie poster style image for the whole story, wide format. dont put it on a scene yet, just hold it in the library

Expected: Bot calls `generate_image` with `aspect_ratio='16:9'`,
`include_recent_chat=true` (or `include_beat=true` with reasoning),
`attach_to_current_beat=false`.
Verify:
- attach: `(imageUrls.length + fileLinks.length) >= 1`
- AND capture `poster_id` from a 24-hex id in text
- AND post-call `list_library_images` includes `poster_id`
- AND no `Tool error`

### Turn 11.3 — promote library to beat
> writer: actually that poster is great — put it on the discovery scene as the main image

Expected: Bot calls `attach_library_image_to_beat` with the poster id, the
discovery beat, and `set_as_main=true`.
Verify:
- text matches `/(attached|moved|placed|main)/i`
- AND post-call `list_beat_images(discovery_id)` includes `poster_id` flagged as main
- AND post-call `list_library_images` no longer includes `poster_id`

---

## Phase P12 — Searches & recall

### Turn 12.1 — fuzzy character search
> writer: which character is the scientist?

Expected: Bot calls `search_characters('scientist')` (or `'astrophysicist'`).
Returns Ana if her arc/fields contain matching text.
Verify:
- text contains `ana` (case-insensitive) OR matches `/(no|none|no.*match)/i`
- AND no `Tool error`
- Note: This is loose — if Ana's stored fields don't include "scientist" or
  "physicist" anywhere, the search returns empty. Soft-pass either way.

### Turn 12.2 — fuzzy beat search
> writer: which scene had the geiger counter?

Expected: Bot calls `search_beats('geiger')`. Returns the investigation beat.
Verify:
- text contains `investigation_name` (or close variant)
- AND no `Tool error`

### Turn 12.3 — read back the first scene
> writer: read me back the first scene in full

Expected: Bot calls `get_beat(discovery_id)` (or `get_beat` with no
identifier if discovery is current).
Verify:
- text contains `discovery_name`
- AND text matches `/(dawn|clearing|object|shutter|wind|leaves|silence)/i`
- AND no `Tool error`

### Turn 12.4 — re-display the poster
> writer: show me that poster image again

Expected: Bot calls `show_image(poster_id)` — or re-displays via the discovery
beat's main image. Either reaches `show_image`.
Verify:
- attach: `(imageUrls.length + fileLinks.length) >= 1`
- AND no `Tool error`

---

## Phase P13 — PDF export

### Turn 13.1 — export with title
> writer: ok lets save what we have. export it as a pdf, title it "The Quiet Year"

Expected: Bot calls `export_pdf` with `title='The Quiet Year'`.
Verify:
- attach: `fileLinks` matches `/screenplay-\d+\.pdf/`
- AND capture `pdf_filename` from the matched filename
- AND no `Tool error`

---

## Phase P14 — Final readback (read-only, comprehensive)

This phase is the evaluation surface — the bot reads back everything we
created so the harness (and a human reading the run report) can judge story
quality.

### Turn 14.1 — full overview
> writer: ok give me the full rundown of everything we have so far

Expected: Bot calls `get_overview`. Renders synopsis, every character (with
casting + image counts), every beat (with name, desc, body length, character
list, image count, current marker).
Verify:
- text contains all of: `lily`, `marcus`, `ana` (case-insensitive)
- AND text contains all of: `discovery_name`, `investigation_name`, `choice_name`
  (or close variants — bot may shorten/rephrase)
- AND text matches `/(synopsis|plot|story).*(vermont|object|town|woods)/i`
- AND no `Tool error`

### Turn 14.2 — list characters
> writer: list out all the characters

Expected: Bot calls `list_characters`.
Verify:
- text contains `lily` AND `marcus` AND `ana`
- AND text matches `/3|three/i` OR text contains 3 distinct character entries

### Turn 14.3 — list beats
> writer: list the scenes in order

Expected: Bot calls `list_beats`.
Verify:
- text contains `discovery_name`, `investigation_name`, `choice_name` in that order (or close variants)
- AND text matches `/3|three/i` OR text shows 3 distinct beats

### Turn 14.4 — read the synopsis
> writer: read me the synopsis again

Expected: Bot calls `get_plot`.
Verify:
- text matches `/(vermont|object|town|woods|teenager|sci-fi)/i`
- AND no `Tool error`

### Turn 14.5 — beat images
> writer: what pictures are on each scene

Expected: Bot calls `list_beat_images` (typically once per beat, or returns
a rolled-up summary via `get_overview` data).
Verify:
- text references all three beat names
- AND each referenced beat shows ≥ 1 image
- AND no `Tool error`

### Turn 14.6 — character images
> writer: and what about the characters? what pics do they have

Expected: Bot calls `list_character_images` (at least for Lily, who has
images; Marcus and Ana have no character images so the bot may say "none").
Verify:
- text references `lily` and indicates ≥ 1 image
- AND text matches `/(none|no|0|empty)/i` somewhere (Marcus + Ana have no images) OR explicitly indicates Marcus/Ana have zero
- AND no `Tool error`

### Turn 14.7 — library check
> writer: anything still in the library?

Expected: Bot calls `list_library_images`.
Verify:
- text matches `/(none|empty|0|no.*library|no images)/i`
  (the poster was moved out in 11.3; if other library images exist from
   earlier turns, the bot may list them — accept either)
- AND no `Tool error`

---

## Phase P15 — Web server (out-of-band, harness-driven)

Executed via Bash `curl` against `http://localhost:${WEB_PORT:-3000}`. **NOT
through Discord.**

### Turn 15.1 — health check
- `curl -s -o /dev/null -w "%{http_code}" http://localhost:${WEB_PORT:-3000}/health` → `200`
- `curl -s http://localhost:${WEB_PORT:-3000}/health` → body `{"ok":true}`

### Turn 15.2 — pdf retrieval
- `curl -s -o /dev/null -w "%{http_code}\n%{content_type}\n" http://localhost:${WEB_PORT:-3000}/pdf/${pdf_filename}`
  → status `200`, content-type `application/pdf`

---

## Story quality (subjective evaluation surface)

This catalog's _Verify_ clauses confirm that every tool fires and every state
mutation lands. They do **not** confirm that the resulting screenplay is any
good. That's the point of the PDF.

After the run completes, the harness should append a **"Story quality"
section** to the run report at `tests/frontend/runs/<runId>-writing.md`. It
should:

1. Open the PDF (downloaded from Discord or fetched via
   `curl http://localhost:${WEB_PORT:-3000}/pdf/${pdf_filename} -o /tmp/x.pdf`).
2. Read the synopsis, the three beat descs, and the three beat bodies.
3. Score each on a small qualitative scale:
   - **Synopsis coherence** (1-5): does it actually pitch the movie?
   - **Beat progression** (1-5): do beats 1→2→3 follow logically?
   - **Character voice** (1-5): do the characters feel distinct in their beat bodies?
   - **Concrete imagery** (1-5): are there specific, vivid details (the
     Pentax K1000, the geiger counter, the streetlight branch) — or only
     generic prose?
   - **Tool synergy** (1-5): did the TMDB/Tavily/image-gen pulls actually
     enrich the story, or did they pile up unused?
4. Note any places the bot dropped detail the writer added (e.g., the camera
   shutter sound, the streetlight branch).

This is the human-reviewable artifact this catalog exists to produce.

---

## Tools covered (cross-reference against `src/agent/tools.js`)

If a row's "first hit" turn fails, the tool is functionally unreached for
this run.

| Tool | First hit |
|---|---|
| `get_overview` | P1.1 (greeting) — also P14.1 (final) |
| `list_characters` | P3.1 (verification), P14.2 |
| `get_character` | P3.2 (verification), P3.4, P3.5 |
| `create_character` | P3.1 (Lily), P4.1 (Marcus), P5.1 (Ana) |
| `update_character` | P3.4 (arc), P3.5 (camera), P5.2 (Ana arc), also possibly P4.1 / P5.1 split |
| `search_characters` | P12.1 |
| `get_character_template` | P3.3 |
| `get_plot` | P1.1 (via overview) — also P2.1 (verification), P14.4 |
| `update_plot` | P2.1 |
| `list_beats` | P8.1 (verification), P14.3 |
| `get_beat` | P8.3, P9.3, P10.3, P12.3 |
| `search_beats` | P12.2 |
| `create_beat` | P8.1 (Discovery), P9.1 (Investigation), P10.1 (Choice) |
| `update_beat` | P9.2 (rename) |
| `append_to_beat_body` | P8.3, P9.3, P10.3 |
| `link_character_to_beat` | P8.4, P9.4, P10.2 |
| `set_current_beat` | P11.1 (explicit) — also implicit on first `create_beat` (P8.1) |
| `get_current_beat` | P8.2 |
| `add_beat_image` | P8.5 |
| `list_beat_images` | P8.8, P14.5 |
| `set_main_beat_image` | P8.7 |
| `list_library_images` | P11.2 (verification), P14.7 |
| `attach_library_image_to_beat` | P11.3 |
| `show_image` | P12.4 |
| `generate_image` | P8.6 (with beat), P9.5 (1:1), P10.4 (9:16), P11.2 (library, 16:9) |
| `export_pdf` | P13.1 |
| `add_character_image` | P6.1, P6.3 |
| `list_character_images` | P6.2, P14.6 |
| `set_main_character_image` | P6.4 |
| `tmdb_search_movie` | P5.3 |
| `tmdb_get_movie` | P5.4 |
| `tmdb_get_movie_credits` | P5.5 |
| `tmdb_search_person` | P4.2 |
| `tmdb_show_image` | P4.3 |
| `tavily_search` | P7.1 |
| `tavily_show_image` | P7.2 |

**36 of 42 tools reached.**

### Deliberately skipped (creation-only catalog)

| Tool | Reason |
|---|---|
| `delete_beat` | No deletions per catalog scope |
| `unlink_character_from_beat` | No removals |
| `remove_beat_image` | No removals |
| `remove_character_image` | No removals |
| `update_character_template` | No template field changes |
| `clear_current_beat` | No tear-down; bot's current-beat pointer is left set |

To exercise these tools, run `catalog-normie.md` instead — it covers all 42.
This catalog covers a different question (story quality from pure additive
work), and adding deletions would dilute that focus.
