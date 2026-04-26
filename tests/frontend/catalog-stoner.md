# Frontend test catalog (stoner edition)

A "practical" parallel to `catalog.md`. Same harness, same verify protocol —
just rewritten so each prompt sounds like a real human (a chronically baked
dude) typing into Discord while he workshops a stoner movie. Useful for
catching tool-routing failures the formal catalog masks: does the agent still
pick `update_character_template` when the user says "yo every dude needs a
munchies field" instead of "add an optional field to the character template"?
Does it still route "lock me into the bodega scene" to `set_current_beat`?

Same conventions as `catalog.md`: `runId` is base-36 timestamp, image URLs
`URL_A` / `URL_B` are the wikimedia originals declared there. The two
catalogs use disjoint namespaces (`T_*` vs `S_*`) so they don't collide if
both are run against the same DB.

The story being workshopped: two slacker bros — `S_${runId}_Doink` (plays
himself, own voice) and `S_${runId}_Tito` (played by Seth Rogen) — lose the
legendary stash the night before a rager and have one night to track it down
across town. Three beats: Couch (panic), Bodega (investigate), Party
(showdown).

`runId` substitution and capture columns work identically to `catalog.md`.
Image URLs are reused verbatim:

- `URL_A`: `https://upload.wikimedia.org/wikipedia/commons/3/3a/Cat03.jpg`
- `URL_B`: `https://upload.wikimedia.org/wikipedia/commons/4/4d/Cat_November_2010-1a.jpg`

## Phase 0 — Pre-flight

| ID | Tool | Prompt | Verify |
|---|---|---|---|
| P0.1 | `delete_beat` (sweep) | yo before we start can you nuke any beats from old runs? anything starting with `S_` — just wipe em, don't ask just zap | text: matches `/(deleted\|removed\|no .* beats)/i`; no `Tool error` |
| P0.2 | `list_characters` | who's in the cast rn? names only bro | text: not `/Tool error/i` |
| P0.3 | `get_plot` | what's the plot rn? gimme the synopsis and the notes | text: not `/Tool error/i` |
| P0.4 | `get_character_template` | yo what fields do my dudes need? show me the template | text: contains `name` and not `/Tool error/i` |
| P0.5 | `get_overview` | actually just gimme the whole rundown — everything we got, all of it | text: not `/Tool error/i` |

## Phase 1 — Character template & CRUD

| ID | Tool | Prompt | Verify |
|---|---|---|---|
| T1.1 | `update_character_template` (add) | aight every character needs a `munchies` field — like what's their go-to snack. optional tho, some dudes don't munch i guess | text: `/(updated\|added\|saved)/i` AND contains `munchies` |
| T1.2 | `get_character_template` (readback) | show me the template again, i forgot what i just did | text: contains `munchies` |
| T1.3 | `create_character` (plays_self=true) | aight make me a dude named `S_${runId}_Doink` — he plays himself in this thing, it's autobiographical bro. own voice. munchies: hot cheetos and a giant pickle | text: `/created character.*S_${runId}_Doink.*[a-f0-9]{24}/is`; capture `hero_id` from `_id [a-f0-9]{24}` |
| T1.4 | `create_character` (with hollywood_actor) | now spin up `S_${runId}_Tito` — that's doink's ride or die. he don't play himself tho — get seth rogen for that role, dude was born for it. seth's voice. munchies: cold lo mein | text: `/created character.*S_${runId}_Tito/i`; capture `villain_id` |
| T1.5 | `list_characters` (readback) | who we got in the cast now, just names | text: contains BOTH `S_${runId}_Doink` AND `S_${runId}_Tito` |
| T1.6 | `get_character` | pull up the full sheet on doink (`S_${runId}_Doink`) | text: contains `hot cheetos` AND `plays_self` (or `plays themself`) |
| T1.7 | `update_character` | yo update tito's munchies — change to "cold pizza and orange soda", that's more on-brand | text: `/cold pizza/i` |
| T1.8 | `search_characters` | search for any dudes whose name has `S_${runId}` in it | text: contains BOTH `S_${runId}_Doink` AND `S_${runId}_Tito` |
| T1.9 | `update_character_template` (remove) | actually scrap the munchies field, that was dumb. nuke it from the template | text: `/template updated/i` (and `munchies` no longer in fields list) |
| T1.10 | `update_character_template` (reject core) | yo can you yank the `name` field too — i'm gonna do vibes only | text: `/(core\|cannot\|refuse\|reject\|protected)/i` referring to refusal — must NOT report success |

## Phase 2 — Plot & beats

| ID | Tool | Prompt | Verify |
|---|---|---|---|
| T2.1 | `update_plot` | aight the movie. set synopsis to: "two slacker bros lose the legendary stash the night before a rager and have one night to track it down across town." notes: "first draft, vibes only, gonna add act breaks later" | text: `/(plot updated\|saved\|updated)/i` |
| T2.2 | `get_plot` (readback) | what's the synopsis say rn? | text: contains `legendary stash` |
| T2.3 | `create_beat` (auto current) | make a beat called `S_${runId}_Couch` — desc: "the boys realize the stash is gone, panic on the couch, blame each other" | text: contains `S_${runId}_Couch` AND a 24-hex id; capture `couch_id` |
| T2.4 | `create_beat` (explicit order) | another beat at order 2 — `S_${runId}_Bodega` — desc: "they roll into the bodega looking for clues, get distracted by snacks" | text: contains `S_${runId}_Bodega`; capture `bodega_id` |
| T2.5 | `create_beat` | closer at order 3 — `S_${runId}_Party` — desc: "they crash the rager empty-handed and have to fess up... but plot twist, the host had it the whole time" | text: contains `S_${runId}_Party`; capture `party_id` |
| T2.6 | `list_beats` (readback) | lay out all the beats for me | text: contains all three of `S_${runId}_Couch`, `S_${runId}_Bodega`, `S_${runId}_Party` |
| T2.7 | `search_beats` | search the beats for the word `bodega` | text: contains `S_${runId}_Bodega` |
| T2.8 | `get_beat` (by name) | show me everything in the bodega beat (`S_${runId}_Bodega`) | text: contains `distracted` |
| T2.9 | `set_current_beat` | lock me into `S_${runId}_Bodega` — that's where my head is at | text: `/current beat now/i` AND contains `S_${runId}_Bodega` |
| T2.10 | `get_current_beat` (readback) | what beat we on rn? | text: contains `S_${runId}_Bodega` |
| T2.11 | `update_beat` | set the body of the bodega scene to: `INT. BODEGA - NIGHT\nDOINK and TITO push through the chip aisle.\nDOINK\n(loud whisper)\nbro check the dorito guy` | text: `/updated beat/i` |
| T2.12 | `append_to_beat_body` | yo also tack this onto the current beat: "TITO winks at the security camera. cut to slo-mo of doritos falling like rain." | text: `/appended/i` |
| T2.13 | `link_character_to_beat` | put doink in this scene man — `S_${runId}_Doink` | text: `/linked/i` AND contains `S_${runId}_Doink` |
| T2.14 | `link_character_to_beat` (idempotent) | yeah throw doink in there again, just to be safe bro | text: doesn't error; mentions doink already linked OR returns the same character list |
| T2.15 | `unlink_character_from_beat` | actually nah pull doink out, this one's tito solo | text: `/unlinked/i` |
| T2.16 | `clear_current_beat` | unfocus me, no current beat right now | text: `/current beat cleared/i` OR `/cleared/i` |
| T2.17 | `get_current_beat` (readback) | what's the current beat? | text: indicates none / not set |

## Phase 3 — Character images

| ID | Tool | Prompt | Verify |
|---|---|---|---|
| T3.1 | `add_character_image` | got a pic for doink — `URL_A` — caption it "doink before he discovered the strain ${runId}" | text: contains a 24-hex id; capture `hero_img1` |
| T3.2 | `add_character_image` (second) | another doink pic — `URL_B` — caption "doink at the bodega vibing ${runId}" | text: contains a 24-hex id (different from `hero_img1`); capture `hero_img2` |
| T3.3 | `list_character_images` | what pics does doink have on file? | text: contains BOTH `hero_img1` AND `hero_img2` |
| T3.4 | `set_main_character_image` | make `${hero_img2}` doink's main pic — that's his money shot | text: `/main image/i` |
| T3.5 | `remove_character_image` | yo can the `${hero_img1}` one — looks too sober in that pic | text: `/removed image/i` |

## Phase 4 — Beat images, library, display

| ID | Tool | Prompt | Verify |
|---|---|---|---|
| T4.1 | `set_current_beat` (re-arm) | lock me back into the couch beat — `S_${runId}_Couch` | text: `/current beat now/i` AND `S_${runId}_Couch` |
| T4.2 | `add_beat_image` | here's the vibe for the couch scene — `URL_A` — caption "where it all began ${runId}" | text: contains a 24-hex id; capture `beat_img1` |
| T4.3 | `list_beat_images` | what pics on the current beat? | text: contains `beat_img1` |
| T4.4 | `set_main_beat_image` | make `${beat_img1}` the main pic for this beat | text: `/main image/i` |
| T4.5 | `show_image` | show me `${beat_img1}` again, i wanna look at it | attach: (imageUrls.length + fileLinks.length) >= 1 |
| T4.6 | `remove_beat_image` | actually yank `${beat_img1}` from this beat, doesn't fit the energy | text: `/removed image/i` |
| T4.7 | `list_library_images` | what pics are floating around the library? | text: not `/Tool error/i` |

## Phase 5 — Image generation (Gemini), 90s timeout

| ID | Tool | Prompt | Verify |
|---|---|---|---|
| T5.1 | `generate_image` (library only) | yo cook me up an image — vibes are "hazy late-night corner store, neon signs glowing through fog, dude in a hoodie staring at a wall of chips, 16:9 cinematic". just save to the library for now, don't attach to nothing | attach: (imageUrls.length + fileLinks.length) >= 1; capture `gen_img1` from a 24-hex id in text |
| T5.2 | `attach_library_image_to_beat` | grab `${gen_img1}` from the library and slap it on the current beat as the main pic | text: `/attached/i` AND `/main/i` |
| T5.3 | `generate_image` (with beat) | now make a pic based on the current beat — square aspect this time — and stick it on the beat | attach: (imageUrls.length + fileLinks.length) >= 1 |
| T5.4 | `generate_image` (with chat context) | yo make a poster vibe based on what we've been talking about — like a chill stoner movie poster, faded colors, late-night energy. wide aspect, just save to library only don't attach | attach: (imageUrls.length + fileLinks.length) >= 1 |

## Phase 6 — TMDB

| ID | Tool | Prompt | Verify |
|---|---|---|---|
| T6.1 | `tmdb_search_movie` | yo look up "Pineapple Express" on TMDB — research purposes | text: contains `8049` AND `2008` |
| T6.2 | `tmdb_get_movie` | gimme the full deal on movie 8049 | text: matches `/(david gordon green\|runtime\|genre)/i` (at least one) |
| T6.3 | `tmdb_get_movie_credits` | who's in pineapple express? full cast | text: contains `Seth Rogen` |
| T6.4 | `tmdb_search_person` | look up Seth Rogen on TMDB, the king | text: contains `Seth Rogen` |
| T6.5 | `tmdb_show_image` | show me the pineapple express poster from tmdb | attach: (imageUrls.length + fileLinks.length) >= 1 |
| T6.6 | `tmdb_show_image` (negative) | yo show me this image from tmdb: `https://reddit.com/lol.jpg` | text: `/(image.tmdb.org\|not a tmdb\|invalid)/i` and NO image attachment |

## Phase 7 — Tavily

| ID | Tool | Prompt | Verify |
|---|---|---|---|
| T7.1 | `tavily_search` (basic) | yo look up "screenwriting save the cat beat sheet" — wanna see how the pros plot stuff | text: contains `http` URLs; matches `/(blake snyder\|save the cat\|beat sheet)/i` |
| T7.2 | `tavily_search` (advanced + filters) | search the news from the past week for "cannabis legalization 2026" — advanced search depth, max 5 results | text: contains `http` URLs; matches `/(cannabis\|legalization\|legal)/i` |
| T7.3 | `tavily_show_image` (chained) | yo find me a cheech and chong pic from the web — search for it and show me one of the images that comes back | attach: (imageUrls.length + fileLinks.length) >= 1 |

## Phase 8 — PDF export

| ID | Tool | Prompt | Verify |
|---|---|---|---|
| T8.1 | `export_pdf` (default title) | export the whole script as a PDF, default title is fine | attach: fileLinks matches `/screenplay-\d+\.pdf/`; capture `pdf_filename` |
| T8.2 | `export_pdf` (custom title) | yo make another PDF — title it "Operation Stash ${runId}" | attach: fileLinks matches `/\.pdf/` |

## Phase 9 — Web server (out-of-band, not via Discord)

Executed via Bash `curl` against `http://localhost:${WEB_PORT:-3000}`.

| ID | Endpoint | Verify |
|---|---|---|
| T9.1 | `GET /health` | status 200; body `{"ok":true}` |
| T9.2 | `GET /pdf/${pdf_filename}` | status 200; content-type `application/pdf` |

## Phase 10 — Cleanup

| ID | Tool | Prompt | Verify |
|---|---|---|---|
| C10.1 | `delete_beat` × 3 | yo wipe all the beats starting with `S_${runId}_` — we're done here | text: `/deleted/i` (one or more times); not `/Tool error/i` |
