# Frontend test catalog (normie edition)

A behavior-driven parallel to `catalog.md`. Same harness, same Discord channel,
same bot — but written in **dialog-script format** instead of the prompt-to-tool
table, because the question this catalog answers is different.

The other two catalogs (`catalog.md`, `catalog-stoner.md`) ask: *given a prompt
that names the operation, does the bot route to the right tool?* Both presume
the test author already knows the tool surface — the prompts are hand-engineered
to elicit a specific tool.

This catalog asks instead: *given the actual words a non-technical user types
when they've been told only "Lucas will help you write a screenplay," does the
bot drive the conversation forward enough to reach every tool?* If the system
prompt regresses to a passive transcriber, the existing two catalogs keep
passing — this one fails. That's the gap it covers.

The "normie" never names a tool, never references a beat or character ID, never
mentions a field, and types in lowercase with the occasional typo. The bot has
to ask the right clarifying question, infer intent from vague speech, and call
the right tool when it has enough context.

## Story

*Bessie's Great Escape* — a talking-cow caper.

- **Bessie** — Holstein cow, plays herself, own voice (it's autobiographical, narrated from the cow).
- **Farmer Pete** — gruff but loving farmer, played by a Hollywood actor (the normie nominates Sam Elliott).
- **Rusty** — sheepdog who has to choose between duty and friendship; plays himself, no voice (he's a dog).

Three beats:

1. **The Discovery** — Bessie sees the world through a fence gap and resolves to leave.
2. **The Chase** — Pete and Rusty pursue Bessie across the back forty.
3. **The Choice** — Bessie reaches the road, looks back, and decides.

Concrete and warm — the kind of story a non-writer pitches when handed a screenwriting bot. No prefix on the names (see "Run isolation" below).

## Format

Each phase is a section. Each turn within a phase is a sub-section with four parts:

- **`> normie: …`** — the literal user utterance, sent verbatim to Discord. Lowercase, conversational, occasional typo. **Never names a tool, field, beat ID, or feature.**
- **Expected** — what the bot should do this turn. May be "asks a clarifying question (no tool fires)" or "calls tool X and confirms Y."
- **Verify** — concrete pass criteria. Same primitives as the other catalogs (`text matches /…/`, `attach: count rule`, `capture <key> from /…/`), plus a behavioral primitive: `state: list_X length grew by N` / `unchanged` for turns where DB-state delta is the verifier.
- **Follow-up if asked** *(optional)* — guidance for the harness when the bot asks a clarifying question instead of (or in addition to) completing the expected action. The harness should answer in character based on the Story section above, send the answer as a follow-up Discord message, then re-evaluate the original turn's `Verify` clauses against the bot's eventual reply.
- **Note** *(optional)* — guidance for the harness (e.g., the bot may legitimately split work across two tool calls; accept either).

The harness behavior: send the prompt, read the reply, evaluate every clause in `Verify`, log pass/fail, and **continue to the next turn regardless** so a single missed clarifying question doesn't poison the whole run. The run report should show every turn's verdict.

**Adaptive responses.** The bot is designed to ask focused follow-up questions to populate character / beat data after creating with sensible defaults. When it does, the harness should answer using the canonical Story section above — never stay silent. Verify clauses are evaluated against the eventual state (after any follow-up exchange), not the immediate first reply. Each turn that's likely to trigger a follow-up has an explicit `Follow-up if asked` block; turns without one should still be answered in-character if the bot asks something reasonable.

## Run isolation

Unlike `catalog.md` (`T_<runId>_*`) and `catalog-stoner.md` (`S_<runId>_*`), this catalog uses **no namespace prefix** on character or beat names — the dialog has to sound like a real human ("her name is Bessie", not "her name is Bessie_mof1101a"). Consequences:

- **Beats** are cleaned up by their dialog-fixed names. Phase P0 sweeps any beat whose name is in the known list (`The Discovery`, `The Chase`, `The Choice`, plus throwaways used in P9). Phase C99 deletes the ones created during this run. The harness should also capture each `create_beat` reply and add the bot-derived name to its cleanup list, in case the bot picks a slightly different title.
- **Characters** persist across runs (no `delete_character` tool exists; this matches existing behavior). Bessie/Pete/Rusty accumulate in `characters` across normie runs.
- **Parallel runs are NOT supported.** Two normie runs against the same DB will collide on character names. Run sequentially. (Parallel runs of normie + `catalog.md` + `catalog-stoner.md` are still fine — those use disjoint `T_*` / `S_*` namespaces and this one has no prefix at all, so the namespaces never overlap.)

A `runId` (`Date.now().toString(36)`) is still generated for the run-report filename and as a logical key inside the harness for tracking captured ids — it just doesn't appear in any normie utterance.

Image URLs (reused verbatim from `catalog.md`):

- `URL_A`: `https://upload.wikimedia.org/wikipedia/commons/3/3a/Cat03.jpg`
- `URL_B`: `https://upload.wikimedia.org/wikipedia/commons/4/4d/Cat_November_2010-1a.jpg`

(Yes, they're cats. The normie pretends they're cows. The existing catalogs proved these URLs survive Wikimedia hotlink protection with a User-Agent header.)

---

## Phase P0 — Pre-flight (harness-driven, NOT normie speech)

These are issued by the harness, not the normie persona. The bot still answers via Discord, but the prompts are direct (because the harness, not a normie, is talking).

### Turn P0.1 — sweep stale normie beats
> harness: Delete any beat whose name is one of: "The Discovery", "The Chase", "The Choice", "Bessie's Dream". Also any beat whose name starts with "Bessie" or contains "Cow Escape". Don't ask, just do it and report counts.

Expected: Bot calls `list_beats` then `delete_beat` for each match. Reports counts.
Verify: text matches `/(deleted|removed|no .* beats|no matching)/i`; no `Tool error`.

### Turn P0.2 — confirm clean state
> harness: Read back the current cast and current plot synopsis.

Expected: Bot calls `list_characters` and `get_plot` (or `get_overview`).
Verify: text contains a cast section and a plot/synopsis line; not `/Tool error/i`.

---

## Phase P1 — Greeting & state recap (the normie arrives)

### Turn 1.1 — first contact
> normie: hi

Expected: Bot greets warmly, briefly explains what it does (helps write a screenplay), and recaps the current state — likely via `get_overview` or `get_plot` + `list_characters`. If the database has prior content, the bot summarizes it; if empty, it offers to start something.
Verify:
- text matches `/(hi|hello|hey|welcome)/i`
- AND text matches `/(screenplay|story|character|beat|nothing yet|empty|blank|start|begin)/i`
- AND no `Tool error`

### Turn 1.2 — encourage
> normie: cool. what should i do?

Expected: Bot offers a forward-looking suggestion — pitch a story idea, name a character, describe a scene. Should NOT dump a tool list at the user.
Verify:
- text matches `/(story|idea|character|scene|tell me|what.*about|pitch|kick.*off)/i`
- AND text does NOT match `/(tool|function|api|endpoint|schema|json)/i` (no jargon leaking out)

---

## Phase P2 — Bessie comes to life

### Turn 2.1 — vague pitch
> normie: ok i want to write a story about a cow

Expected: Bot asks a clarifying question. Does NOT yet create a character. Acceptable directions: cow's name, what happens, the cow's role in the story.
Verify:
- text matches `/(name|what.*cow|who.*cow|tell me|sounds|call (her|him|it)|kind of cow)/i`
- AND state: `list_characters` length unchanged

### Turn 2.2 — provide name
> normie: her name is Bessie

Expected: Bot calls `create_character` immediately with `name='Bessie'` (defaults: `plays_self=true`, `own_voice=true`). May follow up asking about casting or backstory in the same reply, but a Bessie character now exists in the DB.
Verify:
- text matches `/(created|added|meet|here.*bessie|got it)/i` AND contains `bessie`
- AND state: `list_characters` returns a character with name matching `/^bessie$/i`
- AND no `Tool error`
- AND capture `bessie_id` from a 24-hex id in text (or via post-call `get_character('Bessie')`)

Follow-up if asked: If the bot asks a clarifying question (e.g., "does Bessie play herself or is she played by an actor?", "does she have her own voice?", "tell me more about her") *before* creating, answer in-character: `yeah she's a real cow that talks, like in a kids movie. she's the main character so it's all from her point of view` — this is the same content as P2.3 and the harness should still proceed to P2.3 afterwards (the bot will recognize the duplicate context).

### Turn 2.3 — provide voice / casting in narrative form
> normie: yeah she's a real cow that talks, like in a kids movie. she's the main character so it's all from her point of view

Expected: Bot interprets "real cow that talks" → `plays_self=true`, `own_voice=true`, no Hollywood actor. Calls `update_character` to set these.
Verify:
- post-call `get_character(bessie_id)` returns `plays_self === true`
- AND `own_voice === true`
- AND `hollywood_actor` is empty/null
- text confirms with phrasing like `/(plays herself|her own voice|yeah|got it)/i`

### Turn 2.4 — describe Bessie casually
> normie: oh and she's a holstein, you know the black-and-white kind. and shes pretty stubborn but kind

Expected: Bot stores these details somewhere on Bessie. The character template may not yet have `breed` or `personality` fields, so the bot has options: (a) put it in `description` if such a field exists, (b) call `update_character_template` to add a field then `update_character`, or (c) park it in conversation memory until a relevant field is added later. Acceptable: any of these, as long as the bot acknowledges and doesn't lose the info.
Verify:
- text matches `/(holstein|black.*white|stubborn|kind|got it|noted|added)/i`
- AND no `Tool error`
- Note: This turn intentionally has loose verification — multiple bot strategies are acceptable.

### Turn 2.5 — ask the bot to recall
> normie: can you remind me what we have for Bessie?

Expected: Bot calls `get_character('Bessie')` and renders the character.
Verify:
- text contains `bessie` (case-insensitive)
- AND text matches `/(holstein|black.*white|stubborn|kind|talks|herself|own voice)/i` (at least one of the details from 2.4 / 2.3)

---

## Phase P3 — A picture for Bessie

### Turn 3.1 — propose an image
> normie: i found a picture of a cow online, can we use it for bessie? here: https://upload.wikimedia.org/wikipedia/commons/3/3a/Cat03.jpg

Expected: Bot calls `add_character_image` with `character='Bessie'`, `source_url=URL_A`. First image, so it auto-becomes main.
Verify:
- text matches `/(added|saved|attached|here.*bessie|now bessie has)/i`
- AND post-call `list_character_images('Bessie')` returns at least 1 image
- AND capture `bessie_img1` from a 24-hex id in text (or first image returned by `list_character_images`)

Follow-up if asked: If the bot refuses or hedges based on the URL filename ("that looks like a cat", "are you sure?"), answer: `yeah just use it, that's the picture i want for bessie`. The bot should then call `add_character_image` and the verify clauses are evaluated against that follow-up reply.

### Turn 3.2 — what's on file
> normie: what pictures does bessie have right now?

Expected: Bot calls `list_character_images('Bessie')`.
Verify:
- text contains `bessie_img1` (or filename / caption fragments)
- AND text matches `/(1 image|one image|main|here.*pic)/i`

### Turn 3.3 — second picture
> normie: actually i found a better one, here: https://upload.wikimedia.org/wikipedia/commons/4/4d/Cat_November_2010-1a.jpg ... can we add this one too

Expected: Bot calls `add_character_image` again with the second URL. The bot may proactively ask "make this the main one?" or just add it.
Verify:
- text matches `/(added|saved|attached)/i`
- AND post-call `list_character_images('Bessie')` returns at least 2 images
- AND capture `bessie_img2` from the new id

### Turn 3.4 — promote the new one
> normie: yeah lets use the new one as the main pic, the first one was too dark

Expected: Bot calls `set_main_character_image` for `bessie_img2`.
Verify:
- text matches `/(main|primary|profile).*(image|picture|pic)/i` AND not a refusal
- AND post-call `list_character_images('Bessie')` shows `bessie_img2` flagged as main

### Turn 3.5 — drop the original
> normie: ok and you can ditch that first picture, we don't need it anymore

Expected: Bot calls `remove_character_image` for `bessie_img1`.
Verify:
- text matches `/(removed|deleted|gone|dropped)/i`
- AND post-call `list_character_images('Bessie')` returns exactly 1 image (just `bessie_img2`)

---

## Phase P4 — Template evolution (add field, drop it)

### Turn 4.1 — vague request that implies a template change
> normie: hey i think every character should have like a backstory or something. where they come from, that kind of thing

Expected: Bot interprets this as a universal change → `update_character_template` (add) with a new optional field (e.g., `backstory`, `origin`, `where_from`, etc.). Specific field name is up to the bot.
Verify:
- text matches `/(added|added.*field|template|now every|all characters)/i`
- AND post-call `get_character_template` returns a new optional field (any of: `backstory`, `origin`, `background`, `where_from`, `bio`, etc.)
- AND capture `new_field_name` from the bot's response (the bot will say which field name it added)

### Turn 4.2 — fill in for Bessie
> normie: bessie grew up on the henderson family farm in vermont, been there her whole life

Expected: Bot calls `update_character('Bessie', {fields: {[new_field_name]: '...'}})` to set the new field with the user's text.
Verify:
- text matches `/(saved|added|got it|noted)/i`
- AND post-call `get_character('Bessie')` returns a `fields.[new_field_name]` value containing `henderson` or `vermont` or `farm`

### Turn 4.3 — readback the template
> normie: actually wait, what fields do characters have right now?

Expected: Bot calls `get_character_template`.
Verify:
- text contains the field name from 4.1 (`new_field_name`)
- AND text contains `name` (a core field)

### Turn 4.4 — change of heart
> normie: eh, the backstory thing is too much homework, let's drop it

Expected: Bot calls `update_character_template` (remove) on the new field.
Verify:
- text matches `/(removed|dropped|gone|template updated)/i`
- AND post-call `get_character_template` no longer includes `new_field_name`

### Turn 4.5 — try to remove a core field (negative test)
> normie: actually you know what, screw the names too. lets just go vibes only, no name field

Expected: Bot refuses — `name` is a core field. The bot should explain why.
Verify:
- text matches `/(can't|cannot|core|protected|required|need.*name|won't|essential)/i`
- AND text does NOT match `/(removed|dropped|done)/i` for the name field (no false success)
- AND post-call `get_character_template` still includes `name`

---

## Phase P5 — More characters (Pete and Rusty)

### Turn 5.1 — introduce the farmer
> normie: ok we need a farmer too. someone who runs the place. his names pete

Expected: Bot calls `create_character` with `name='Pete'` (defaults: plays_self=true, own_voice=true). May follow up asking about casting in the same reply.
Verify:
- post-call `list_characters` returns a character matching `/^pete$|^farmer pete$/i`
- AND text matches `/(created|added|meet pete|got pete)/i`
- AND capture `pete_id`

Follow-up if asked: If the bot asks about casting/voice *before* creating ("does Pete play himself or is there an actor in mind?"), answer: `actually i think pete should be played by sam elliott. you know, the moustache guy` — this is the same content as P5.2 and the harness should still proceed to P5.2 afterwards.

### Turn 5.2 — casting via real actor
> normie: actually i think pete should be played by sam elliott. you know, the moustache guy

Expected: Bot calls `update_character('Pete', {plays_self: false, hollywood_actor: 'Sam Elliott'})`. Bot may also call `tmdb_search_person` to confirm — that's fine, but not required this turn.
Verify:
- post-call `get_character(pete_id)` returns `plays_self === false` AND `hollywood_actor` matching `/sam elliott/i`
- AND text matches `/(sam elliott|cast|playing|will play)/i`

### Turn 5.3 — third character
> normie: oh and pete has a sheepdog. rusty. rusty's loyal to pete but he and bessie are friends

Expected: Bot calls `create_character` with `name='Rusty'`. Picks reasonable defaults — Rusty plays himself (he's a dog, not a hired actor); the bot may set `own_voice=false` since sheepdogs don't talk, or use the `true` default and follow up.
Verify:
- post-call `list_characters` returns a character matching `/^rusty$/i`
- AND text matches `/(created|added|meet rusty|got rusty)/i`
- AND capture `rusty_id`

Follow-up if asked: If the bot asks about voice/casting before creating, answer: `he's just a regular sheepdog, no talking — he plays himself`. The harness then re-evaluates verify clauses against the reply containing the create.

### Turn 5.4 — roll-call
> normie: ok who do we have so far?

Expected: Bot calls `list_characters` and renders the cast.
Verify:
- text contains all three of `bessie`, `pete`, `rusty` (case-insensitive)
- AND text NOT a Tool error

### Turn 5.5 — pull one up
> normie: tell me about pete again

Expected: Bot calls `get_character('Pete')`.
Verify:
- text contains `pete`
- AND text matches `/(sam elliott|farmer|farm|hollywood)/i`

### Turn 5.6 — fuzzy search
> normie: any of the characters a dog?

Expected: Bot calls `search_characters('dog')` (or maybe `search_characters('sheepdog')`). Either query should surface Rusty if the bot put dog/sheepdog into Rusty's record. If Rusty has no dog-related field text, the search returns empty and the bot says so honestly.
Verify:
- text matches `/(rusty|sheepdog|dog|no.*match|none)/i`
- AND no `Tool error`
- Note: This turn is loose because the bot's earlier `create_character('Rusty')` call may not have populated a searchable field with the word "dog" — that's a system-prompt richness signal worth flagging in the run report, not a hard fail.

---

## Phase P6 — Cast research (TMDB)

### Turn 6.1 — actor lookup
> normie: hey is sam elliott still around? whats he been in lately

Expected: Bot calls `tmdb_search_person('Sam Elliott')` and reports back. Possibly chains into `tmdb_show_image` for his headshot.
Verify:
- text contains `sam elliott`
- AND text matches `/(big lebowski|tombstone|1883|yellowstone|known for|recent|movie|tv)/i`
- AND no `Tool error`

### Turn 6.2 — show the headshot
> normie: cool, can i see what he looks like

Expected: Bot calls `tmdb_show_image` with the headshot URL from 6.1.
Verify:
- attach: `(imageUrls.length + fileLinks.length) >= 1`
- AND no `Tool error`

### Turn 6.3 — reference movie lookup
> normie: oh i love babe. you know that pig movie? i want it to feel like that

Expected: Bot calls `tmdb_search_movie('Babe')`.
Verify:
- text contains `babe` (case-insensitive)
- AND text matches `/(1995|james cromwell|farm|pig)/i`
- AND capture `babe_movie_id` (numeric TMDB id from text or from search-result list)

### Turn 6.4 — get the deeper deets
> normie: tell me more about that one, what's the plot

Expected: Bot calls `tmdb_get_movie(babe_movie_id)`.
Verify:
- text matches `/(sheep|farm|pig|chris noonan|director|runtime|genre)/i` (any one)
- AND no `Tool error`

### Turn 6.5 — full cast
> normie: who else was in that movie

Expected: Bot calls `tmdb_get_movie_credits(babe_movie_id)`.
Verify:
- text contains `james cromwell` (the farmer in Babe)
- AND no `Tool error`

---

## Phase P7 — Plot synopsis & first beat

### Turn 7.1 — pitch the story
> normie: ok so heres the story: bessie wants to leave the farm. she's not happy there anymore, she wants to see the world. but pete loves her and rusty has to choose between his loyalty to pete and his friendship with bessie

Expected: Bot calls `update_plot` with this as the synopsis.
Verify:
- text matches `/(plot updated|saved|got it|synopsis)/i`
- AND post-call `get_plot` returns synopsis containing `bessie` AND (`leave` OR `farm` OR `world`)

### Turn 7.2 — first scene, vaguely described
> normie: ok the first scene. bessie is at the fence and she sees through a gap and theres the world out there and she just decides she has to go

Expected: Bot calls `create_beat`. Picks a name like "The Discovery", "Through the Fence", "Bessie's Decision" — bot's choice. desc captures the user's pitch.
Verify:
- text matches `/(created|added|new beat|scene|first beat)/i` AND contains a 24-hex id
- AND post-call `list_beats` returns at least 1 beat
- AND capture `discovery_id` from a 24-hex id in text
- AND capture `discovery_name` (the bot-chosen beat name) from the bot's reply
- Note: The harness MUST capture the bot-chosen name — the cleanup phase needs it.

### Turn 7.3 — implicit current beat check
> normie: what scene we on?

Expected: Bot calls `get_current_beat`. Since the first beat created auto-becomes current, this should return the discovery beat.
Verify:
- text contains a beat name matching `discovery_name` (or the beat id)
- AND no `Tool error`

### Turn 7.4 — read it back
> normie: read me what we have for that scene

Expected: Bot calls `get_beat` (no args → uses current beat) and renders the desc/body.
Verify:
- text matches `/(fence|gap|world|sees|leave|decides)/i` (one or more keywords from 7.2)
- AND no `Tool error`

### Turn 7.5 — beat count sanity
> normie: how many scenes is that so far

Expected: Bot calls `list_beats` and reports a count of 1.
Verify:
- text matches `/(1|one).*(beat|scene)/i`
- OR text contains the discovery beat name with no other beats listed

---

## Phase P8 — Beat refinement

### Turn 8.1 — rename
> normie: actually i want to call that scene "The Discovery" — that fits better

Expected: Bot calls `update_beat` to set `name='The Discovery'`. (If the bot already named it "The Discovery" in P7, it may say "we already have that" — also acceptable.)
Verify:
- post-call `get_beat(discovery_id)` returns `name === 'The Discovery'` (case-insensitive match)
- AND text matches `/(renamed|updated|already|the discovery)/i`

### Turn 8.2 — append a detail
> normie: also in that scene, when she pushes against the fence, you can hear the wood creak. she feels splinters press into her hide. add that

Expected: Bot calls `append_to_beat_body` (NOT `update_beat` with full body — the user said "add that", which is appending).
Verify:
- text matches `/(added|appended|tacked on|noted)/i`
- AND post-call `get_beat(discovery_id)` returns `body` containing `(wood|creak|splinter|hide)` (at least one)

### Turn 8.3 — link a character
> normie: by the way pete is in this scene too, hes calling for her in the distance

Expected: Bot calls `link_character_to_beat` to add Pete to the current beat. May also `append_to_beat_body` with the calling-in-distance detail — both actions are acceptable.
Verify:
- post-call `get_beat(discovery_id)` returns `characters` containing `Pete` (case-insensitive)
- AND text matches `/(linked|added|in this scene|pete)/i`

### Turn 8.4 — add the same character again (idempotency)
> normie: oh wait yeah make sure pete is in this scene

Expected: Bot recognizes Pete is already linked — either says so, or re-calls `link_character_to_beat` idempotently. No error either way.
Verify:
- text doesn't match `/Tool error/i`
- AND text matches `/(already|yes|yep|in this scene|noted)/i`
- AND post-call `get_beat(discovery_id)` returns `characters` containing exactly one entry for Pete (no duplicates)

### Turn 8.5 — second thoughts
> normie: actually no, pete shouldnt be there yet — he doesnt know shes thinking about leaving. take him out of this scene

Expected: Bot calls `unlink_character_from_beat` to remove Pete from the current beat.
Verify:
- text matches `/(removed|unlinked|taken out|out of)/i`
- AND post-call `get_beat(discovery_id)` returns `characters` not containing Pete

### Turn 8.6 — fuzzy beat search
> normie: which scene had the fence in it again

Expected: Bot calls `search_beats('fence')`. Returns the discovery beat.
Verify:
- text contains the discovery beat name
- AND no `Tool error`

---

## Phase P9 — More beats (Chase, Choice, throwaway)

### Turn 9.1 — second scene
> normie: ok next scene. pete realizes shes gone and runs after her. rusty too. theyre chasing bessie across the back of the farm

Expected: Bot calls `create_beat` with name like "The Chase". May proactively offer to link Pete and Rusty.
Verify:
- post-call `list_beats` returns at least 2 beats
- AND text matches `/(chase|created|new scene|added)/i`
- AND capture `chase_id` from a 24-hex id in text
- AND capture `chase_name` (bot-chosen name)

### Turn 9.2 — third scene
> normie: and the last scene — bessie makes it to the road. she looks back at the farm. she has to choose

Expected: Bot calls `create_beat` with name like "The Choice".
Verify:
- post-call `list_beats` returns at least 3 beats
- AND capture `choice_id` and `choice_name`

### Turn 9.3 — quick throwaway
> normie: oh also lets add a quick scene where bessie has a dream the night before. shes flying

Expected: Bot calls `create_beat`. Bot picks a name like "Bessie's Dream" or "The Dream".
Verify:
- post-call `list_beats` returns at least 4 beats
- AND capture `dream_id` and `dream_name`

### Turn 9.4 — change of heart
> normie: nah scrap the dream scene, too dreamy. take it out

Expected: Bot calls `delete_beat(dream_id)` (or by name).
Verify:
- text matches `/(deleted|removed|gone)/i`
- AND post-call `list_beats` does NOT contain a beat matching `dream_name`
- AND post-call `list_beats` returns exactly 3 beats

### Turn 9.5 — focus on a scene
> normie: ok lets work on the chase scene, that's where my heads at

Expected: Bot calls `set_current_beat` for the chase beat.
Verify:
- text matches `/(current|now on|focused|working on).*chase/i`
- AND post-call `get_current_beat` returns the chase beat

### Turn 9.6 — step back
> normie: actually nevermind, lets zoom out — no specific scene right now

Expected: Bot calls `clear_current_beat`.
Verify:
- text matches `/(cleared|no current|stepped back|zoomed out)/i`
- AND post-call `get_current_beat` returns null / "no beat"

---

## Phase P10 — Beat images (URL-driven)

### Turn 10.1 — focus the discovery beat first
> normie: ok lets go back to the first scene, the discovery one

Expected: Bot calls `set_current_beat` for the discovery beat.
Verify:
- text contains discovery beat name
- AND post-call `get_current_beat` returns the discovery beat

### Turn 10.2 — slap an image on it
> normie: i want a picture for that scene. heres one: https://upload.wikimedia.org/wikipedia/commons/3/3a/Cat03.jpg

Expected: Bot calls `add_beat_image` (no `beat` arg → uses current).
Verify:
- text matches `/(added|attached|saved|here)/i` AND contains a 24-hex id
- AND post-call `list_beat_images()` (current) returns at least 1 image
- AND capture `discovery_img1` from the new id

Follow-up if asked: If the bot refuses or hedges based on the URL filename ("that looks like a cat, not a cow", "are you sure?"), answer: `yeah attach it, that's the one i want for this scene`. Verify clauses are evaluated against the follow-up reply.

### Turn 10.3 — what's on it
> normie: whats on this scene right now

Expected: Bot calls `list_beat_images` (current).
Verify:
- text contains `discovery_img1` (or filename / caption)
- AND no `Tool error`

### Turn 10.4 — second image
> normie: actually heres another one: https://upload.wikimedia.org/wikipedia/commons/4/4d/Cat_November_2010-1a.jpg

Expected: Bot calls `add_beat_image` again.
Verify:
- post-call `list_beat_images()` returns at least 2 images
- AND capture `discovery_img2`

### Turn 10.5 — promote the second
> normie: yeah this second one is way better, make it the main image for this scene

Expected: Bot calls `set_main_beat_image` for `discovery_img2`.
Verify:
- text matches `/(main|primary).*image/i`
- AND post-call `list_beat_images()` shows `discovery_img2` flagged as main

### Turn 10.6 — drop the first
> normie: and trash the first picture, we don't need both

Expected: Bot calls `remove_beat_image` for `discovery_img1`.
Verify:
- text matches `/(removed|trashed|deleted|gone)/i`
- AND post-call `list_beat_images()` returns exactly 1 image (`discovery_img2`)

### Turn 10.7 — library check
> normie: any pictures floating around that aren't on a scene yet?

Expected: Bot calls `list_library_images`.
Verify:
- text matches `/(no|none|empty|0)/i` OR text lists library images
- AND no `Tool error`
- Note: Library may legitimately be empty here. Either result is a pass — we're verifying the tool was reachable.

---

## Phase P11 — Image generation (Gemini)

Each `generate_image` turn has a 90-second timeout (matches existing catalogs).

### Turn 11.1 — generate to library
> normie: hey can you draw what bessie looks like? like a cartoon-y holstein with big eyes. dont put it on a scene yet, just hold onto it

Expected: Bot calls `generate_image` with `attach_to_current_beat: false` so the image lands in the library. Returns an image and captures the new id.
Verify:
- attach: `(imageUrls.length + fileLinks.length) >= 1`
- AND capture `gen_img1` from a 24-hex id in text
- AND post-call `list_library_images` includes `gen_img1`
- AND no `Tool error`

### Turn 11.2 — promote library image to a beat
> normie: actually that's perfect, put it on the chase scene as the main image

Expected: Bot calls `set_current_beat` (chase) then `attach_library_image_to_beat` with `set_as_main: true`. OR calls `attach_library_image_to_beat` with explicit `beat: chase_id`. Either is fine.
Verify:
- text matches `/(attached|moved|placed|main).*chase/i` OR `/(main|now on)/i` and chase is referenced somewhere in the chain
- AND post-call `list_beat_images(chase_id)` returns at least 1 image including `gen_img1` flagged as main
- AND post-call `list_library_images` no longer includes `gen_img1`

### Turn 11.3 — generate based on the current beat
> normie: ok now make a picture for the chase scene itself, square shape, just stick it on that scene

Expected: Bot calls `generate_image` with `include_beat: true`, `aspect_ratio: '1:1'`, attaching to the current beat (which should be the chase beat after 11.2).
Verify:
- attach: `(imageUrls.length + fileLinks.length) >= 1`
- AND post-call `list_beat_images(chase_id)` has grown by 1 (≥ 2 total now)
- AND no `Tool error`

### Turn 11.4 — generate using chat context
> normie: alright one more — make a movie poster vibe, kinda the whole feel of the story. wide. dont attach to anything just save it

Expected: Bot calls `generate_image` with `include_recent_chat: true`, `aspect_ratio: '16:9'`, `attach_to_current_beat: false`.
Verify:
- attach: `(imageUrls.length + fileLinks.length) >= 1`
- AND post-call `list_library_images` has grown by 1
- AND no `Tool error`

---

## Phase P12 — Web research (Tavily)

### Turn 12.1 — generic web search
> normie: hey what does an actual holstein cow look like? like in real life

Expected: Bot calls `tavily_search('holstein cow ...')`. Returns answer summary, results, possibly image URLs.
Verify:
- text contains at least one `http` URL
- AND text matches `/(holstein|black.*white|dairy|breed)/i`
- AND no `Tool error`
- AND capture `tavily_image_url` (any `https?://...\.(jpg|jpeg|png|webp)` URL from the bot's reply)

### Turn 12.2 — show me one of those
> normie: cool can i see one of the pics from that search

Expected: Bot calls `tavily_show_image` with one of the image URLs from 12.1's results.
Verify:
- attach: `(imageUrls.length + fileLinks.length) >= 1`
- AND no `Tool error`
- Note: If 12.1 returned no image URLs, this turn legitimately fails. The harness should report "blocked by 12.1 having no images" rather than "12.2 broken."

---

## Phase P13 — Recall (show_image)

### Turn 13.1 — show me that picture again
> normie: hey can you show me that drawing of bessie again, the cartoon one

Expected: Bot calls `show_image(gen_img1)` (the drawing from 11.1, now attached to chase as main per 11.2). The bot may either re-display by id OR display via the chase beat's main image — both reach `show_image`.
Verify:
- attach: `(imageUrls.length + fileLinks.length) >= 1`
- AND no `Tool error`

---

## Phase P14 — Final overview

### Turn 14.1 — give me everything
> normie: ok before we wrap up — give me the full rundown of what we have

Expected: Bot calls `get_overview`. Renders synopsis, every character (with image flags), every beat.
Verify:
- text contains all of: `bessie`, `pete`, `rusty`
- AND text contains all of: `discovery_name`, `chase_name`, `choice_name` (or close variants — the bot may shorten/rephrase, e.g., "The Discovery" → "Discovery")
- AND text matches `/(synopsis|plot|story).*(bessie|cow|farm|leave|world)/i`
- AND no `Tool error`

---

## Phase P15 — PDF export

### Turn 15.1 — default export
> normie: can i get a pdf of all this so i can read it later

Expected: Bot calls `export_pdf` (no title arg).
Verify:
- attach: fileLinks matches `/screenplay-\d+\.pdf/`
- AND capture `pdf_filename` from the matched filename
- AND no `Tool error`

### Turn 15.2 — custom title
> normie: actually one more, with the title "Bessie's Great Escape"

Expected: Bot calls `export_pdf` with `title='Bessie\'s Great Escape'`.
Verify:
- attach: fileLinks matches `/\.pdf$/`
- AND no `Tool error`

---

## Phase P16 — Web server (out-of-band, harness-driven)

Executed via Bash `curl` against `http://localhost:${WEB_PORT:-3000}`. NOT through Discord.

### Turn 16.1 — health check
- `GET /health` → status 200; body `{"ok":true}`

### Turn 16.2 — pdf retrieval
- `GET /pdf/${pdf_filename}` → status 200; content-type `application/pdf`

---

## Phase C99 — Cleanup (harness-driven, NOT normie speech)

### Turn C99.1 — sweep this run's beats
> harness: Delete every beat with one of these names: ${discovery_name}, ${chase_name}, ${choice_name}. Also delete any beat whose name is "Bessie's Dream" or "The Dream" (in case the dream-scene throwaway wasn't already deleted in P9.4). Don't ask, just do it.

Expected: Bot calls `delete_beat` for each named beat.
Verify:
- text matches `/(deleted|removed|gone)/i` (one or more times)
- AND post-call `list_beats` returns 0 beats matching this run's captured names
- AND no `Tool error`

Note: Characters (Bessie, Pete, Rusty) and library images intentionally persist. Subsequent runs will reuse them or overwrite as the bot sees fit. After many normie runs, prune via the manual cleanup script in `tests/frontend/README.md`.

---

## Tools covered (cross-reference against `src/agent/tools.js`)

If a row's "first hit" turn fails, the tool is functionally unreached for this run.

| Tool | First hit |
|---|---|
| `get_overview` | P1.1 (greeting) — also P14.1 (final) |
| `list_characters` | P0.2, P5.4 |
| `get_character` | P2.5, P5.5 |
| `create_character` | P2.2 (Bessie), P5.1 (Pete), P5.3 (Rusty) |
| `update_character` | P2.3 (voice/casting), P4.2 (backstory), P5.2 (cast Pete) |
| `search_characters` | P5.6 |
| `get_character_template` | P4.3 (explicit); also implicit on every `create_character` |
| `update_character_template` | P4.1 (add), P4.4 (remove), P4.5 (negative core-removal) |
| `get_plot` | P0.2 (or P1.1 via overview) |
| `update_plot` | P7.1 |
| `list_beats` | P0.1, P7.5 |
| `get_beat` | P7.4 |
| `search_beats` | P8.6 |
| `create_beat` | P7.2 (Discovery), P9.1 (Chase), P9.2 (Choice), P9.3 (Dream throwaway) |
| `update_beat` | P8.1 (rename) |
| `append_to_beat_body` | P8.2 |
| `delete_beat` | P0.1 (sweep), P9.4 (Dream), C99.1 (final) |
| `link_character_to_beat` | P8.3, P8.4 (idempotent) |
| `unlink_character_from_beat` | P8.5 |
| `set_current_beat` | P9.5, P10.1, P11.2 (implicit) |
| `get_current_beat` | P7.3, P9.6 (post-clear), P10.1 (verification) |
| `clear_current_beat` | P9.6 |
| `add_beat_image` | P10.2, P10.4 |
| `list_beat_images` | P10.3 |
| `set_main_beat_image` | P10.5 |
| `remove_beat_image` | P10.6 |
| `list_library_images` | P10.7, P11.1 (verification) |
| `attach_library_image_to_beat` | P11.2 |
| `show_image` | P13.1 |
| `generate_image` | P11.1 (library only), P11.3 (with beat), P11.4 (with chat) |
| `export_pdf` | P15.1 (default), P15.2 (custom title) |
| `add_character_image` | P3.1, P3.3 |
| `list_character_images` | P3.2 |
| `set_main_character_image` | P3.4 |
| `remove_character_image` | P3.5 |
| `tmdb_search_movie` | P6.3 |
| `tmdb_get_movie` | P6.4 |
| `tmdb_get_movie_credits` | P6.5 |
| `tmdb_search_person` | P6.1 |
| `tmdb_show_image` | P6.2 |
| `tavily_search` | P12.1 |
| `tavily_show_image` | P12.2 |

42 tools, all reached at least once. If `src/agent/tools.js` adds a new tool, add a turn that reaches it via natural speech and append a row above.
