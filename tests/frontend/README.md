# Frontend test suite (Discord-driven)

Drives the screenplay bot end-to-end through its only UI: the configured
Discord channel. Each case sends one message via Chrome DevTools MCP, waits for
the bot's reply, and verifies the observable effect (text content, image
attachment, PDF attachment, or state-readback through a follow-up tool call).

This is **not** a Vitest suite. It runs from a Claude Code session that has
Chrome DevTools MCP attached to a browser already logged into Discord. To
re-run: open the channel in Chrome, then ask Claude:

> Run the frontend test suite from `tests/frontend/<catalog>.md`.

…where `<catalog>` is one of `catalog.md` (default formal run), `catalog-stoner.md`
(slacker-voiced), or `catalog-normie.md` (behavior test of bot-driven dialog).
Claude reads the chosen catalog for the case list and `dom-helpers.js` for the
page-side scripts that read Discord's DOM via `evaluate_script`.

## Files

- `catalog.md` — the ~58 test cases as Markdown tables. Source of truth for what
  gets tested and how each result is verified. Edit here when adding tools.
- `catalog-stoner.md` — alternate run with stoner-voiced prompts driving the
  same tool surface (a slacker-bros stoner-caper screenplay). Uses an `S_*`
  namespace so it can coexist with `catalog.md` in the same DB. Useful for
  catching tool-routing failures the formal catalog masks (does the agent
  still resolve "yo lock me into the bodega scene" → `set_current_beat`?).
- `catalog-normie.md` — **behavior-driven** test in dialog-script format (NOT
  the prompt-to-tool table). Plays the role of a non-technical user who's been
  told only "Lucas will help you write a screenplay" and types in casual,
  vague language without ever naming a tool. The verifier asks "did the bot
  drive the conversation forward enough to reach every tool organically?" —
  the regression signal `catalog.md` and `catalog-stoner.md` can't catch,
  because their prompts already do the routing work. Uses **no** namespace
  prefix (the dialog has to sound real), so normie runs must be sequential
  against the same DB. See its own preamble for the format spec.
- `dom-helpers.js` — page-side scripts (passed verbatim to
  `mcp__chrome-devtools__evaluate_script`). One reads channel state, one waits
  for a new bot reply, one focuses the message editor.
- `runs/` — markdown summaries from prior runs (one file per `runId`).

## Run isolation

Each `catalog.md` / `catalog-stoner.md` run picks a fresh
`runId = Date.now().toString(36)` and namespaces its characters and beats with
`T_<runId>_*` (or `S_<runId>_*`). Phase 0 sweeps any `T_*` / `S_*` beats from
prior crashed runs before the new run begins. Phase 10 deletes this run's
beats on success.

`catalog-normie.md` deliberately uses **no namespace prefix** — the dialog has
to sound like a real human, and "her name is Bessie_mof1101a" doesn't. As a
result, normie runs must be sequential against the same DB (parallel normie
runs collide on character names). Parallel runs of normie + `catalog.md` +
`catalog-stoner.md` are still safe — the namespaces never overlap. Cleanup
sweeps a fixed set of beat names (`The Discovery`, `The Chase`, `The Choice`,
plus throwaways) that the normie story uses.

## Manual cleanup (rarely needed)

Test characters and library-generated images are not deleted automatically
because no `delete_character` tool exists and library images aren't
addressable for deletion. After many runs, prune them via the Mongo shell:

```js
// Inside the screenplay db
db.characters.deleteMany({ name: /^T_/ });                              // catalog.md
db.characters.deleteMany({ name: /^S_/ });                              // catalog-stoner.md
db.characters.deleteMany({ name: { $in: ['Bessie', 'Pete', 'Rusty'] }});// catalog-normie.md
db['character_images.files'].deleteMany({});  // reclaims orphaned char images
db['images.files'].deleteMany({ 'metadata.owner_type': null });  // library
```

## Re-runnability guarantees

1. Fresh `runId` per run (table catalogs only) → no name collisions in
   `characters` / `beats`. The normie catalog forgoes a prefix and relies on
   sequential runs + fixed-name beat sweeps.
2. Phase 0 pre-sweep handles partial state from a crashed prior run.
3. Final-phase cleanup deletes this run's beats on success (Phase 10 in the
   table catalogs, Phase C99 in the normie catalog).
4. Template mutations are reverted within the same run (e.g. catalog.md T1.1
   add tagline → T1.9 remove tagline; catalog-normie.md P4.1 add field → P4.4
   remove field). Negative tests (catalog.md T1.10, catalog-normie.md P4.5)
   verify refusal without mutating.
5. Failing tests do not block re-runs. Subsequent runs use a fresh `runId` (or
   for normie, the same fixed beat names — Phase P0 sweeps any leftovers).
