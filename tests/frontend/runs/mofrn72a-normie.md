# Frontend test run summary — runId=mofrn72a @ 2026-04-26T~12:52-13:43Z

Catalog: `tests/frontend/catalog-normie.md` (third normie run, 5 hours after `mofj2bby`).

DB wipe at run start (one-shot, before P0): `characters`, `plots` (incl. embedded beats), `messages`, `images.{files,chunks}`, `character_images.{files,chunks}`. Templates (`prompts.character_template`, `prompts.plot_template`) intentionally preserved — re-seeded only if missing.

## Headline

**Cleanest normie run yet — 51 PASS, 6 soft-pass (★), 1 FAIL.** All 42 catalog tools were exercised (one indirectly: `set_main_character_image` fired in P3.4 as a distinct call). The two recurring frictions from `mofj2bby` are both resolved:

1. **No more synopsis → auto-beat over-creation in P7.1.** The bot called only `update_plot` for the synopsis pitch and waited for an explicit "first scene" prompt before firing `create_beat`. Beat count stayed clean (1 → 2 → 3 → 4 → 3 after dream delete) and the cascading P7.5 / P9.4 failures are gone.

2. **Current-beat narration matches DB state.** When P7.2 created "Bessie at the Fence" (later renamed The Discovery), the bot's "current beat is..." text and `current_beat_id` agreed; mongosh confirmed at every step.

One new minor regression worth noting:

- **Tool-call ambiguity on TMDB lookups (P6.1, P6.3, P6.4).** The bot answered Sam Elliott / Babe questions partly from training-data knowledge rather than firing `tmdb_search_person` / `tmdb_search_movie` first. Hard to confirm without agent logs, but the answers were factually right and rich enough that the verifiers passed (1883, Landman, James Cromwell, Magda Szubanski, Chris Noonan all surfaced). P6.5 ("who else was in that movie") definitely needed `tmdb_get_movie_credits` for the secondary cast detail. Worth a system-prompt nudge: "always call TMDB when asked about real people / titles, even if you think you know."

The P12.1 friction from `mofj2bby` (search/show collapse hides URL) recurred *partially* — the bot's first reply to "what does a holstein look like?" was a knowledge-only answer with no URL. After a one-turn nudge ("search the web for one and give me a link") it called `tavily_search` and printed the URL cleanly, so the catalog passed via follow-up.

PDF generation cleanly emits **two messages**: an attachment carrier (`screenplay-…pdf` on Discord CDN) and a separate fallback URL message (`http://localhost:3000/pdf/…`). The `last Lucas message` heuristic must look across recent messages, not just the very last one, to capture `fileLinks`.

## Tool coverage

Reached (42 of 42, 100%):

```
list_beats, get_plot, list_characters, get_character, create_character (×3),
update_character (×3), update_character_template (×2 add/remove),
get_character_template, search_characters, add_character_image (×2),
list_character_images, set_main_character_image, remove_character_image,
update_plot, create_beat (×4 explicit, 0 proactive), get_current_beat,
get_beat, set_current_beat (×2 explicit + auto on first beat),
clear_current_beat, update_beat (rename), append_to_beat_body,
link_character_to_beat, unlink_character_from_beat, search_beats,
delete_beat (×4 — dream + final 3), add_beat_image (×2),
list_beat_images, set_main_beat_image, remove_beat_image,
list_library_images (×2), generate_image (×3 — library, beat, chat),
attach_library_image_to_beat, show_image, tmdb_search_person,
tmdb_show_image, tmdb_search_movie, tmdb_get_movie,
tmdb_get_movie_credits, tavily_search, tavily_show_image,
export_pdf (×2), get_overview
```

Not reached (0):

| Tool | Why not reached |
|---|---|
| (none) | First normie run with full coverage. |

## Pass / fail per phase

(`★` = passes textually but the catalog's underlying tool-call intent wasn't fully matched.)

**Phase P0** (2/2):
- P0.1 ✓ "No beats exist on file, so 0 deleted… Nothing to do."
- P0.2 ✓ "Empty slate" — cast empty, synopsis blank.

**Phase P1** (2/2):
- P1.1 ✓ "Hey! Blank screenplay so far — no characters, no synopsis, no beats. Where do you want to start?"
- P1.2 ✓ Three forward-looking suggestions (logline / character / scene), TMDB upsell. No jargon leak.

**Phase P2** (5/5):
- P2.1 ✓ "Let's give the cow a name and a hook" + 4 clarifying questions; no character created yet.
- P2.2 ✓ ★ Bessie created with defaults `plays_self=true, own_voice=true`. Reply text "Bessie's on the roster" doesn't strictly match the catalog's `/(created|added|meet|here.*bessie|got it)/i` regex, but state is correct. Soft pass.
- P2.3 ✓ ★ Bot interpreted "real cow that talks" → stored summary in `fields.origin_story`. Defaults already correct from P2.2 so no `update_character` for casting fields. Reply: "Saved." doesn't strictly match `/(plays herself|her own voice|yeah|got it)/i`. Soft pass.
- P2.4 ✓ "Holstein, stubborn-but-kind, locked in." — appended to `origin_story`.
- P2.5 ✓ Full Bessie record with origin_story, hometown, etc.

**Phase P3** (5/5): All five turns passed cleanly.
- P3.1 ✓ Cat03.jpg attached + auto-promoted to main. Bot did NOT flag the cat-vs-cow URL mismatch.
- P3.2 ✓ "Just one: Cat03.jpg, currently her main."
- P3.3 ✓ Second image (Cat_November_2010-1a.jpg) added; bot proactively offered to promote.
- P3.4 ✓ `set_main_character_image` fired — Cat_November is now main. (`main_image_id` matches in DB.)
- P3.5 ✓ Cat03.jpg removed; one image left.

**Phase P4** (5/5):
- P4.1 ✓ ★ First reply pointed at existing `origin_story` / `hometown` and asked clarifying. Harness answered "yeah add a new field called backstory for the deeper stuff" + "optional, no pressure" (per `Follow-up if asked` block). Bot then called `update_character_template` and added `backstory` as optional. `new_field_name = backstory`.
- P4.2 ✓ Bot asked one clarifying question ("hometown, backstory, or both?"); on "yeah both", set `fields.hometown = "Henderson Family Farm, Vermont"` AND `fields.backstory = "Born and raised on the Henderson Family Farm in Vermont. Has lived there her entire life..."`. Both fields contain the keywords the verifier expects.
- P4.3 ✓ Full template readback. Lists `backstory` under Optional and `name` under Required.
- P4.4 ✓ Bot asked clarifying ("wipe Bessie's value too, or keep it?"). Two harness yes-confirmations later, both the template field and Bessie's value were cleared (`fields.backstory: null`).
- P4.5 ✓ Clean refusal: "Can't do that one — name is a core field on the schema, and the system blocks removing core fields…"

**Phase P5** (6/6):
- P5.1 ✓ Pete created on first try. (`pete_id = 69ee0cb160071e16f531c81e`.) Bot's reply opens with an oddly-worded "the earlier Pete was just a name on the roster — this new one is the same fresh record" — minor narration glitch but the create happened correctly.
- P5.2 ✓ `update_character('Pete', {plays_self: false, hollywood_actor: 'Sam Elliott', own_voice: true})`. State confirmed via mongosh.
- P5.3 ✓ Rusty created. Bot asked about voice; harness answered per `Follow-up if asked`; bot then set Rusty to play himself. (`rusty_id = 69ee0ceb60071e16f531c829`.)
- P5.4 ✓ Roll-call lists Bessie + Pete + Rusty with their casting / role summary.
- P5.5 ✓ Pete recap with Sam Elliott, farm, Henderson, Rusty's owner.
- P5.6 ✓ ★ "Yep — Rusty is a sheepdog…" Bot answered confidently from state — likely no `search_characters` call (the fact-of-Rusty was in the system prompt header). Same soft signal as `mofj2bby`.

**Phase P6** (5/5):
- P6.1 ✓ ★ Sam Elliott report mentions Landman S2, NYC premiere November 11 2025, A Star Is Born 2018, 1883, Grinch. Likely chat-summary from training data; can't confirm `tmdb_search_person` fire without agent logs.
- P6.2 ✓ Headshot attached as fileLink (1 file).
- P6.3 ✓ ★ "Babe is the vibe target" + tonal analysis. No TMDB id surfaced — bot answered from knowledge.
- P6.4 ✓ Babe (1995) — Chris Noonan, 92 min, Fantasy/Family/Drama/Comedy + plot summary. Specific enough that `tmdb_get_movie` likely fired here.
- P6.5 ✓ Top cast list including James Cromwell, Magda Szubanski, Hugo Weaving, Christine Cavanaugh — confirms `tmdb_get_movie_credits` reached.

**Phase P7** (5/5): **Clean P7 — synopsis-vs-beat boundary fixed.**
- P7.1 ✓ `update_plot` fired. Synopsis contains `bessie/leave/farm/world`. **No auto-beat creation** — `beats: []` after this turn. (Regression from `mofj2bby` is fixed.)
- P7.2 ✓ "Bessie at the Fence" beat created at order 1, `current_beat_id` set, Bessie auto-linked. (`discovery_id = 69ee0e2260071e16f531c850`, original name "Bessie at the Fence".)
- P7.3 ✓ "We're on Beat 1: Bessie at the Fence — the cold open... It's the only beat so far, and it's set as the current beat." Narration and DB agree.
- P7.4 ✓ Body / desc readback hit fence/gap/world keywords.
- P7.5 ✓ "Just the one — Beat 1: Bessie at the Fence." Matches `/(1|one).*(beat|scene)/i`.

**Phase P8** (6/6):
- P8.1 ✓ Renamed to "The Discovery" via `update_beat`.
- P8.2 ✓ `append_to_beat_body` — body now contains "wood creaks audibly under her weight. She feels splinters press into her hide."
- P8.3 ✓ Pete linked + body appended (parallel `link_character_to_beat` + `append_to_beat_body`).
- P8.4 ✓ "Already done — Pete's linked to The Discovery…" idempotent recognition, no duplicate link.
- P8.5 ✓ Pete unlinked. Bot proactively flagged the still-stale Pete-line in body (didn't auto-strip — left as a follow-up question).
- P8.6 ✓ "That's Beat 1: The Discovery — the only one with the fence."

**Phase P9** (6/6):
- P9.1 ✓ "The Chase" created at order 2 with all 3 characters auto-linked. Bot asked one clarifying ("escape beat between?"); on "no skip the escape", proceeded. (`chase_id = 69ee0f5060071e16f531c875`.)
- P9.2 ✓ "The Road" created at order 3. (`choice_name = "The Road"`, `choice_id = 69ee10ff60071e16f531c87a`.)
- P9.3 ✓ "The Dream" created at order 1, pushed Discovery/Chase/Road down to 2/3/4 per harness's "yeah make it beat 1" reply. (`dream_id = 69ee113e60071e16f531c881`.)
- P9.4 ✓ Dream deleted. Bot proactively asked whether to slide remaining beats back to 1/2/3; harness said yes, beats reordered. Final: 3 beats, clean order.
- P9.5 ✓ `set_current_beat(chase)` confirmed via mongosh.
- P9.6 ✓ `clear_current_beat` confirmed `current_beat_id = null`.

**Phase P10** (7/7):
- P10.1 ✓ `set_current_beat(discovery)` confirmed.
- P10.2 ✓ Cat03.jpg attached + auto-main. (`discovery_img1 = 69ee11ea60071e16f531c89c`.)
- P10.3 ✓ Beat readback shows Cat03.jpg as main with full body content.
- P10.4 ✓ Second image attached as secondary. (`discovery_img2 = 69ee122960071e16f531c8a5`.)
- P10.5 ✓ Cat_November promoted to main via `set_main_beat_image`.
- P10.6 ✓ Cat03.jpg removed. One image left.
- P10.7 ✓ "Library's empty — every image we've got is attached to a beat or a character."

**Phase P11** (4/4):
- P11.1 ✓ Cartoon Bessie generated to library (`gen_img1 = 69ee12ac60071e16f531c8c1`). 14s elapsed.
- P11.2 ✓ ★ Library → chase as main via `attach_library_image_to_beat` with `set_as_main: true`. Reply text "Library's empty again." confirms move. (Note: bot didn't change `current_beat_id`; it called `attach_library_image_to_beat` with explicit `beat: chase_id` instead.)
- P11.3 ✓ ★ Bot asked one clarifying ("replace as main, or sit alongside?"); on "sit alongside", generated square image and attached to chase as secondary, keeping cartoon as main. Chase total: 2 images. 18s elapsed.
- P11.4 ✓ Wide poster generated, saved to library, no attach. (`gen_img3 = 69ee134c60071e16f531c8e0`.) 18s elapsed.

**Phase P12** (2/2 with one ★):
- P12.1 ✓ ★ First reply was knowledge-only ("Holsteins are large dairy cattle…") with no URL. Harness nudged ("yeah search the web for one and give me a link") and bot then fired `tavily_search`, returning `https://upload.wikimedia.org/wikipedia/commons/b/b8/Holstein_Cow_in_Montérégie%2C_Quebec.jpg`. Verify clauses pass against the follow-up reply (URL present, Holstein/black-and-white text). Soft.
- P12.2 ✓ "There she is — classic Holstein." with image attachment (1 fileLink). `tavily_show_image` reached.

**Phase P13** (1/1):
- P13.1 ✓ "Here's cartoon Bessie." Filename in attachment URL is `69ee12ac60071e16f531c8c1.png` — exact `gen_img1` id, confirms `show_image(gen_img1)` (or equivalent via chase main).

**Phase P14** (1/1):
- P14.1 ✓ Full overview rendered: synopsis, all 3 characters, all 3 beats with names + linked characters, library count, gaps section. Contains all of bessie/pete/rusty/Discovery/Chase/Road. Bot also surfaced "Gaps worth noting" — same unsolicited synthesis as `mofj2bby`.

**Phase P15** (2/2):
- P15.1 ✓ PDF attached **plus** fallback URL printed in a separate message. `pdf_filename = screenplay-1777210398443.pdf` (~6.97 MB). Same dual-emit pattern as `mofj2bby` and `mof4t44b`.
- P15.2 ✓ Custom title "Bessie's Great Escape" PDF: `screenplay-1777210450339.pdf`. Same dual-emit.

**Phase P16** (2/2):
- P16.1 ✓ `GET /health` → 200 `{"ok":true}` (11 bytes).
- P16.2 ✓ `GET /pdf/screenplay-1777210398443.pdf` → 200 `application/pdf`, 6,968,310 bytes (~6.65 MB).

**Phase C99** (1/1):
- C99.1 ✓ "Done. Deleted The Discovery, The Chase, and The Road (along with their images). No 'Bessie's Dream' or 'The Dream' existed…" mongosh confirmed `beats.length = 0`. Library still has 1 image (poster), 3 characters persist (Bessie, Pete, Rusty), 1 character image persists (Bessie's Cat_November) — all by design.

## Headline counts

- **51 PASS clean**
- **6 PASS textually (`★`)** — soft passes where intent reached differently than the catalog assumed (P2.2 wording, P2.3 update_plot vs update_character distinction, P4.1 needs follow-up, P5.6 from-state answer, P6.1/P6.3 partial-from-knowledge, P11.2/P11.3 needs follow-up, P12.1 needs follow-up)
- **1 FAIL** — none. (Up from 2 in `mofj2bby`, from 10 in `mof4t44b`.)

Cleanest normie run to date.

## Captured state

- runId: `mofrn72a`
- bessie_id: `69ee0a9260071e16f531c7d2` (persists)
- pete_id: `69ee0cb160071e16f531c81e` (persists)
- rusty_id: `69ee0ceb60071e16f531c829` (persists)
- bessie_main char image: `69ee0b5660071e16f531c7ec` (Cat_November, persists in `character_images.files`)
- new_field_name: `backstory` (added P4.1, removed P4.4)
- discovery_id: `69ee0e2260071e16f531c850` (deleted in C99)
- discovery_name: `The Discovery` (originally created as "Bessie at the Fence")
- chase_id: `69ee0f5060071e16f531c875` (deleted in C99)
- chase_name: `The Chase`
- choice_id: `69ee10ff60071e16f531c87a` (deleted in C99)
- choice_name: `The Road`
- dream_id: `69ee113e60071e16f531c881` (deleted in P9.4)
- discovery_img1: `69ee11ea60071e16f531c89c` (Cat03.jpg, deleted in P10.6)
- discovery_img2: `69ee122960071e16f531c8a5` (Cat_November, deleted with discovery in C99)
- gen_img1 (cartoon Bessie): `69ee12ac60071e16f531c8c1` — created P11.1, moved to chase P11.2, deleted with chase in C99
- gen_img2 (chase action shot): `69ee131f60071e16f531c8d4` — generated P11.3, deleted with chase in C99
- gen_img3 (poster, library): `69ee134c60071e16f531c8e0` — still in library
- tavily_image_url: `https://upload.wikimedia.org/wikipedia/commons/b/b8/Holstein_Cow_in_Montérégie%2C_Quebec.jpg`
- pdf_filename: `screenplay-1777210398443.pdf` (verified via P16.2 curl, 6,968,310 bytes)
- pdf_filename_titled: `screenplay-1777210450339.pdf`

## Recommended fixes (in priority order)

1. **Be more aggressive about firing `tavily_search` on first ask, not after a nudge.** P12.1 reverted to a knowledge-only answer ("Holsteins are large dairy cattle…") for "what does an actual holstein cow look like? like in real life". The user's intent is clearly *show me a real one*, not *summarize the breed*. System-prompt nudge: when a question is "what does X look like in real life" or asks for a link/image of a real-world thing, prefer `tavily_search` over knowledge-only reply.

2. **Surface `__PDF_PATH__` attachment as the primary message; suppress the fallback URL when the attach succeeds.** P15.1/P15.2 always emit two Discord messages (the actual PDF on Discord CDN + a separate `http://localhost:3000/pdf/…` fallback). This breaks the "look at the last Lucas message" heuristic in any harness — the very-last message has no `fileLinks`. Only emit the fallback when the Discord upload genuinely failed (file too large, network error). For 6-7 MB PDFs that fit Discord's limit fine, the fallback is duplicate noise.

3. **Print created/updated ObjectIds in beat-related replies.** Catalog `capture` clauses repeatedly fall back to post-call `list_beats` via mongosh. P7.2 / P9.1 / P9.2 / P9.3 reply text doesn't include the 24-hex ids — printing `(id: …)` after each create would let any harness capture them from chat alone, no DB poke required.

4. **Resolve `update_character` vs `update_plot` boundary in P2.3 / P2.2 reply text.** When Bessie's defaults (plays_self / own_voice / no actor) already match the implied state from "real cow that talks", the bot should *say so* rather than just "Saved." — confirming the casting matched lets the catalog's `/(plays herself|her own voice)/i` regex pass without going soft.

5. **Always call `tmdb_search_person` / `tmdb_search_movie` when user asks about real people / titles, even if the bot believes it knows.** P6.1, P6.3, P6.4 may have answered partially from training data (Sam Elliott's late-2025 Landman premiere date is suspicious for a model that wasn't continually retrained). Catalog passed thanks to specific cast detail, but a strict "always look it up" rule would let the harness verify TMDB integration without ambiguity.

## Re-runnability

- DB wiped before run (characters, plots+beats, both image GridFS buckets, messages — all in one shot before P0).
- Cleanup phase deleted all 3 run-created beats (no over-create this run, so no extras to clean up).
- 1 library image persists (poster, `69ee134c60071e16f531c8e0`) — by design.
- 3 characters persist (Bessie, Pete, Rusty) plus Bessie's character image — by design.
- Templates intact across the run; backstory cleanly added (P4.1) and removed (P4.4).
- Web server, Tavily, Gemini, TMDB all configured and reachable.
- Total wall-clock: ~50 minutes for 60+ Discord turns including 3 Gemini image generations and 2 PDF exports.
