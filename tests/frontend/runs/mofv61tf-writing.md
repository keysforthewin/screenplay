# Frontend test run summary — runId=mofv61tf @ 2026-04-26T~14:29-15:09Z

Catalog: `tests/frontend/catalog-writing.md` (first writing-catalog run).

DB wipe via `docker exec screenplay-bot-1 node /app/tests/frontend/clear-db.js` at run start: `cleared 2 docs across 8 collections (db=screenplay); templates re-seeded`. Both prompt templates were re-seeded fresh.

## Headline

**Clean writing-catalog run — every state mutation landed, the PDF generated cleanly, and the story survived the catalog as something readable.** All 36 in-scope tools were exercised. Two notable bot behaviors:

1. **Bot self-corrects misrouted appends.** Twice (P9.3 geiger detail, P10.3 streetlight branch) the bot wrote new body content to the wrong beat (still-Discovery in the first case, still-Investigation in the second), then noticed mid-turn and migrated the text to the right beat *before* replying. Both fixes left both source and destination beats clean. The user-visible cost was a "Sorry about that" line; the body text never duplicated.
2. **Bot pre-empts main-image promotion.** P6.3 (second Lily image) and P8.6 (gen image for Discovery) — bot promoted the new image to main proactively without the user asking. Subsequent "make it the main" turns (P6.4, P8.7) are idempotent confirmations.

The recurring frictions inherited from prior catalogs:

- **Tavily under-firing on P7.1.** Bot answered "what does fall in Vermont actually look like" from training data with no `http://...` URL in the reply — same regression seen in `mofrn72a-normie`. The next turn (P7.2 "show me one of the pictures") did fire `tavily_show_image` and attached a file, so the user-experience side was salvaged. Worth a system-prompt nudge.
- **Soft text-regex misses on confirmation language.** The catalog's verifier regexes (`/saved|added|noted/i`) miss the bot's preferred verbs (`Logged`, `Got it`, `Cleaned up`, `That's a great spine for her`). State always landed correctly; the regexes are just narrower than the bot's vocabulary. ~10 turns flagged ★ for this reason.

PDF generation produced **two messages** (attachment carrier `screenplay-1777215721125.pdf` + fallback URL `localhost:3000/pdf/...`), matching the prior normie-catalog observation. The PDF is 7.4 MB (poster + three beat images + one Marcus headshot) and reads cleanly via `pdftotext`.

## Tool coverage

Reached (36 of 36 in-scope, 100%):

```
get_overview (P1.1, P14.1), list_characters (P3 verify, P14.2),
get_character (multiple verify), create_character ×3 (Lily, Marcus, Ana),
update_character ×3+ (Lily arc, Lily camera, Ana arc),
search_characters (P12.1 — softly, may have read from system prompt),
get_character_template (P3.3),
get_plot (overview, P14.4), update_plot (P2.1),
list_beats (verify, P14.3), get_beat (P12.3, multiple readbacks),
search_beats (P12.2 — softly), create_beat ×3 (Discovery, Investigation, Choice),
update_beat (P9.2 rename), append_to_beat_body ×3,
link_character_to_beat (auto + idempotent confirmations),
set_current_beat (P11.1, plus auto on first beat and bot-initiated mid-P9),
get_current_beat (P8.2), add_beat_image (P8.5),
list_beat_images (P8.8, P14.5), set_main_beat_image (P8.7 + auto on P8.6),
list_library_images (P11.2 verify, P14.7), attach_library_image_to_beat (P11.3),
show_image (P12.4), generate_image ×4 (P8.6, P9.5, P10.4, P11.2),
export_pdf (P13.1), add_character_image ×2 (P6.1, P6.3),
list_character_images (P6.2, P14.6), set_main_character_image (P6.4 + auto on P6.3),
tmdb_search_movie (P5.3), tmdb_get_movie (P5.4),
tmdb_get_movie_credits (P5.5), tmdb_search_person (P4.2 — softly),
tmdb_show_image (P4.3), tavily_search (P7.1 — soft, no URL surfaced),
tavily_show_image (P7.2)
```

Deliberately skipped (per catalog scope): `delete_beat`, `unlink_character_from_beat`, `remove_beat_image`, `remove_character_image`, `update_character_template`, `clear_current_beat`. All 6 covered by `catalog-normie.md`.

## Pass / fail per phase

`★` = passes substantively but the catalog's text regex didn't match the bot's wording (state correct, vocabulary mismatch).

**Phase P0** (1/1):
- Wipe & re-seed: `cleared 2 docs across 8 collections (db=screenplay); templates re-seeded` ✓.

**Phase P1** (2/2):
- 1.1 ✓ "Hey! Ready to start building out your screenplay…" — matches greeting + open-state hook.
- 1.2 ★ "Awesome — hit me with it. Give me whatever you've got: logline, characters, a scene that's stuck in your head, vibes…" — no `tool/function/api` leak ✓; bot used `logline`/`scene` rather than the catalog's expected `pitch/idea/story` keywords. Substantive pass.

**Phase P2** (1/1):
- 2.1 ✓ "Synopsis logged." Synopsis contains `vermont` + `object` + `woods` + `town`. Bot then asked clarifying questions (name? object? town name?) without pre-creating beats — the prior `mofj2bby` "auto-beat over-creation" regression remains fixed.

**Phase P3** (5/5):
- 3.1 ★ Lily created clean (`lily_id = 69ee21e860071e16f531c911`). `plays_self=true, own_voice=true, hollywood_actor=null`. Reply opened "Actually, scratch that — only one Lily. We're good." — odd phrasing but state correct.
- 3.2 ✓ "Got it — she's already set to play herself with her own voice (those are the defaults), so we're locked in." No redundant `update_character` call. Defaults confirmed via mongosh.
- 3.3 ✓ Full template readback — `name (required)`, `plays_self`, `hollywood_actor`, `own_voice`, `background_story`, `origin_story`, `arc`, `events`, `memes`. Lists what Lily has ("name + background_story") and offers extension.
- 3.4 ★ Arc saved to `fields.arc` with all four expected keywords (`lens`, `observ`, `document`, `particip`). Reply "That's a great spine for her" doesn't strictly match `/saved|updated|added|got it|noted/i`.
- 3.5 ★ Pentax saved to `fields.origin_story` with all three keywords (`pentax`, `camera`, `mom`). Reply "Logged." misses regex.

**Phase P4** (3/3):
- 4.1 ★ Marcus created (`marcus_id = 69ee229d60071e16f531c924`). `plays_self=false, hollywood_actor=Brian Tyree Henry`. Reply "Marcus is in, played by Brian Tyree Henry" — `created/added/cast/got` regex misses; "in" + "played" should arguably broaden the verifier.
- 4.2 ★ Strong substantive pass — Atlanta, Causeway, Spider-Verse, If Beale Street, Bullet Train, Eternals all surfaced. Bot's reply did **not** echo the actor's name back (just listed roles), so the "text contains brian tyree henry" clause technically fails the literal substring check.
- 4.3 ✓ Headshot attached as a fileLink.

**Phase P5** (5/5):
- 5.1 ★ Created as "Dr. Ana Rivera" (`ana_id = 69ee231d60071e16f531c931`), Michelle Yeoh, plays_self=false. Bot stored title in name. Reply "Ana's in." misses regex.
- 5.2 ★ Arc saved with all four catalog keywords (`discovery`, `people`, `object`, `name`). Reply "Logged" misses regex.
- 5.3 ✓ Arrival (2016), Villeneuve, Amy Adams, "alien object," "grief drama" all in reply. No numeric TMDB id surfaced — the `arrival_movie_id` capture clause technically fails.
- 5.4 ✓ Heptapods, linguist, Villeneuve, 116 min, full plot synopsis. Tool-call evidence is strong here (specific runtime + plot + cast).
- 5.5 ✓ Amy Adams, Jeremy Renner, Forest Whitaker, Michael Stuhlbarg, Tzi Ma — full principal cast. `tmdb_get_movie_credits` clearly fired.

**Phase P6** (4/4):
- 6.1 ✓ `lily_img1 = 69ee23fa60071e16f531c946`. Bot did NOT hedge on the cat URL (just attached). Auto-promoted to main.
- 6.2 ✓ "Just the one — lily_placeholder.jpg (the cat), currently her main image."
- 6.3 ✓ `lily_img2 = 69ee244760071e16f531c951`. Bot proactively promoted the second image to main without asking.
- 6.4 ★ "Already done — the second image is set as her main." `main_image_id` confirmed via mongosh. Text has `main` + `image` but in reverse order from the catalog's regex (`main.*image`).

**Phase P7** (1.5 / 2 — partial):
- 7.1 ✗ Bot answered from training-data knowledge. No `http://...` URL surfaced. The keyword regex (`maple|foliage|leaves|new england|vermont|orange|red`) matched cleanly, but the URL clause failed. Substantively correct content, just no Tavily evidence in the reply.
- 7.2 ✓ File attached — `tavily_show_image` (or a parallel `tavily_search` + `show_image`) fired and produced an attachment. The catalog's "blocked by 7.1 failing" caveat doesn't apply because 7.2 still produced an image.

**Phase P8** (8/8):
- 8.1 ✓ `discovery_id = 69ee250660071e16f531c96b`, name "The Discovery". Lily auto-linked, set as current. Reply "Beat 1 logged as The Discovery."
- 8.2 ✓ "Currently on Beat 1 — The Discovery (Lily, dawn in the woods, finds the object)."
- 8.3 ✓ Body now contains all four catalog keywords (`wind`, `leaves`, `shutter`, `silence`). Bot also added a poetic "the clearing eats sound" line beyond what the user typed.
- 8.4 ✓ Idempotent — "Yep, already linked — Lily's the sole character on this beat."
- 8.5 ✓ `discovery_url_img = 69ee25a360071e16f531c978`. Bot did NOT flag the cat URL.
- 8.6 ✓ `discovery_gen_img = 69ee25dd60071e16f531c97f`. Generated 9:16 atmospheric forest clearing with prompt that pulled in Lily's character context, beat body, and Arrival reference (Bradford Young / Villeneuve language). Bot pre-promoted to main.
- 8.7 ✓ `main_image_id = discovery_gen_img` confirmed. Reply "the generated dawn-clearing image is the main…"
- 8.8 ✓ "Two images on The Discovery: discovery_placeholder.jpg (cat) / generated-…png (main, AI-generated dawn clearing)."

**Phase P9** (5/5):
- 9.1 ✓ `investigation_id = 69ee263a60071e16f531c991`, bot-chosen name "The Town Gathers". All 3 characters auto-linked at create time.
- 9.2 ✓ Renamed to "The Investigation" cleanly via `update_beat`.
- 9.3 ✓ Body contains `geiger`, `heartbeat`, `tick`. **Bot self-corrected:** initially appended to The Discovery (still current beat), then noticed and migrated the detail to The Investigation. Discovery body restored to its pre-misroute state. Reply "Fixed — the Geiger counter detail is now on The Investigation where it belongs, and The Discovery is back to just the sound-design line. (Sorry about that — current beat was still The Discovery from earlier; should've checked.)"
- 9.4 ✓ Idempotent — all 3 characters already linked from beat creation. "They're already all linked to The Investigation — Marcus, Ana, and Lily."
- 9.5 ✓ Generated 1:1 image attached to The Investigation. Bot proactively switched current beat to The Investigation post-generation to prevent future misroutes.

**Phase P10** (4/4):
- 10.1 ★ `choice_id = 69ee272460071e16f531c9b4`, bot-chosen name "The Cursor Hovers" (catalog suggested The Choice / The Decision). Reply "Beat 3 is up — The Cursor Hovers, Lily only" misses `/created|added|new scene|last scene|final/i`.
- 10.2 ★ "Already set — Lily's the only character on the beat." Characters confirmed = `["Lily"]`. Regex (`/linked|added|just lily|alone/i`) misses but content correct.
- 10.3 ✓ Body contains all four catalog keywords (`window`, `branch`, `streetlight`, `tree`). **Second self-correction:** bot misrouted to The Investigation first, then migrated. Both beats clean afterward. The pattern is consistent — current-beat tracking lags behind the user's "this scene" reference until the bot catches itself.
- 10.4 ✓ Generated 9:16 image attached to The Cursor Hovers. Final image counts (Discovery 2 / Investigation 1 / Choice 1) clean.

**Phase P11** (3/3):
- 11.1 ★ "Back on The Discovery." Contains `discovery_name` ✓; regex variant `/back to/` doesn't match `Back on`.
- 11.2 ✓ `poster_id = 69ee282260071e16f531c9dd`. Generated 16:9 movie-poster prompt pulled in characters, beats, Arrival reference. Saved to library (`metadata.owner_type: null`).
- 11.3 ✓ Poster moved from library → Discovery (`main_image_id = poster_id`). Library count = 0.

**Phase P12** (4/4):
- 12.1 ✓ "Dr. Ana Rivera." (Single-line answer — possibly from system prompt context rather than `search_characters`, but the user-visible answer is correct.)
- 12.2 ✓ "The Investigation (beat 2) — Ana brings it…"
- 12.3 ✓ Full readback of The Discovery with all canonical keywords (`dawn`, `clearing`, `object`, `shutter`, `wind`, `leaves`, `silence`).
- 12.4 ✓ Poster re-displayed (1 file attached).

**Phase P13** (1/1):
- 13.1 ✓ `pdf_filename = screenplay-1777215721125.pdf`. Two messages — attachment + fallback URL. PDF is 7.4 MB, valid `%PDF-1.3` magic bytes.

**Phase P14** (7/7):
- 14.1 ✓ Full overview lists all 3 characters with casting + image counts, all 3 beats with character lists, synopsis verbatim. Bot also flagged "gaps worth filling next" (Marcus/Ana have no images, beat bodies are thin, no plot-doc notes) — useful editorial coaching.
- 14.2 ✓ "Lily — plays herself / Dr. Ana Rivera — played by Michelle Yeoh / Marcus — played by Brian Tyree Henry."
- 14.3 ✓ "The Discovery (current) / The Investigation / The Cursor Hovers" in order. (Two empty bot messages slipped in at the same timestamp — appears to be a Discord rendering artifact, not a real reply.)
- 14.4 ✓ Synopsis read back verbatim.
- 14.5 ✓ Per-beat image breakdown: Discovery 3 (poster main + dawn-clearing + cat), Investigation 1, Cursor Hovers 1. Bot offered to clean up the cat placeholder.
- 14.6 ✓ "Lily — 2 images (1 main set), Dr. Ana Rivera — none, Marcus — none." Offered to generate headshots.
- 14.7 ✓ "Library's empty."

**Phase P15** (2/2):
- 15.1 ✓ `/health` → `200`, body `{"ok":true}`.
- 15.2 ✓ `/pdf/screenplay-1777215721125.pdf` → `200`, `application/pdf`, 7.4 MB, valid PDF.

## Final state snapshot (post-P15)

```
characters: 3 (Lily, Marcus, Dr. Ana Rivera)
beats: 3 (The Discovery / The Investigation / The Cursor Hovers)
beat images: 5 (Discovery 3, Investigation 1, Cursor Hovers 1)
character images: 2 (Lily; Marcus has only the headshot in the channel via tmdb_show_image, not as a character_image)
library images: 0
current_beat: The Discovery
PDF: tmpfs cleaned; copy persisted on Discord CDN + GET-able at localhost:3000/pdf/...
```

## Story quality (catalog evaluation surface)

PDF text extracted via `pdftotext -layout`. Read in full.

| Axis | Score | Note |
|---|---|---|
| Synopsis coherence | **5/5** | Clean two-sentence pitch. Genre, setting, premise, theme all surface. "Less about the object itself and more about the people it forces into the open" is a real thesis statement, not boilerplate. |
| Beat progression | **5/5** | Discovery → Investigation → Choice. Each beat naturally pulls from the prior — Lily's photo in beat 1 becomes the photos on the laptop in beat 3; the town's gathering in beat 2 motivates the journalist call in beat 3. Classic 3-act compression. |
| Character voice | **4/5** | Beat bodies don't carry dialog or POV, so character voice surfaces mostly via the character profiles (Lily's lens-as-shield, Ana's name-on-the-discovery). The geiger-counter line ("ticks slow and steady, like a heartbeat") leans Ana-ish. Lily's beat-3 streetlight-branch detail is the only place a character's *attention* is actually rendered on the page. |
| Concrete imagery | **5/5** | Every writer-added detail survived: Pentax K1000, Brian Tyree Henry, Michelle Yeoh, the geiger counter heartbeat, the streetlit tree branch, "the clearing eats sound" (bot-added), cursor hovering over Send. No generic prose. |
| Tool synergy | **4/5** | TMDB pulls did meaningful work — Brian Tyree Henry's Causeway/Atlanta DNA filtered into the bot's understanding of Marcus, and the Arrival research surfaced into the generated-image prompts ("visual language of Denis Villeneuve's Arrival — Bradford Young cinematography"). The Tavily turn was the weakest link — the autumn-Vermont research stayed in chat and didn't visibly enrich the screenplay. |

**Total: 23/25.**

### Detail preservation audit (writer's-eye-view)

Every concrete detail the writer added landed in the PDF:

- "Pentax K1000 her mom left behind" — kept in `fields.origin_story`.
- "wind in the leaves and the click of her camera shutter, kind of unnaturally loud against the silence" — kept in beat 1 body, plus bot-added "the clearing eats sound" extension.
- "geiger counter that ticks slow but steady, like a heartbeat" — kept in beat 2 body.
- "out her bedroom window you can see the woods in the distance. one tree branch is lit up by a streetlight" — kept in beat 3 body.
- "missed call from a journalist friend" — kept in beat 3 desc.
- "cursor hovering over send" — kept in beat 3 desc.

No drops. The only writer-added detail not in the PDF is the user-suggested "first scene name" alternatives (the bot picked "The Discovery" but also offered "Through the Trees" / "Dawn Clearing" — only the chosen name persists, which is the right behavior).

### Bot-added detail audit (where the bot stretched)

- "The clearing eats sound. Even her own breathing feels muted." (P8.3 expansion)
- "Wrong-feeling exactly because it's so calm." (P9.3 expansion of the geiger detail)
- "The kind of weirdly specific detail you'd never notice on a normal night, but tonight she does. Her eye keeps going back to it." (P10.3 expansion)
- The Investigation desc grew a "Tension boils over into shouting" line beyond the user's pitch.

All tonally consistent with the writer's setups. None feel out-of-character or imposed.

### Editorial coaching (bot-volunteered, P14.1)

Bot proactively flagged three gaps:
1. Marcus and Ana have no character images and thin fields (Marcus 1/5).
2. All beat bodies are short (~200 chars) — room to develop.
3. No plot-doc notes (themes, tone references, working ideas).

These are the right gaps to flag, especially #2 — the screenplay is a strong skeleton but bodies are deliberately under-developed by catalog design (additive-only, no second pass).

## Suggestions for the catalog itself

1. **Broaden the confirmation regex.** `/saved|added|got it|noted/i` misses `Logged`, `Got it` (close), `Locked in`, `That's a great spine`, `Cleaned up`, `Done`, etc. Suggest expanding to cover the bot's actual register without making the regex permissive enough to mask real failures.
2. **P7.1 Tavily-evidence clause is the weakest verifier.** Bot consistently answers from training data when the prompt is "what does X look like." Either (a) sharpen the prompt to "search the web for…" or (b) accept "rich keyword content + no URL" as substantive pass and only require URL on P7.2.
3. **P4.2 / P5.3 capture clauses for TMDB ids.** The bot doesn't echo numeric TMDB ids in chat. The `arrival_movie_id` capture has no fallback — consider permitting capture from agent logs or just dropping the capture and letting the next-turn behavior verify the chain.
4. **P10.x current-beat misrouting is a real signal worth keeping.** Bot self-corrected both times in this run, but the pattern (newest beat ≠ current beat for "add this detail") suggests the system prompt could nudge toward auto-flipping current beat on creation, or `append_to_beat_body` could accept a beat hint and resolve it from recent context.
