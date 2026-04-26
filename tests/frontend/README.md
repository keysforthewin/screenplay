# Frontend test suite (Discord-driven)

Drives the screenplay bot end-to-end through its only UI: the configured
Discord channel. Each case sends one message via Chrome DevTools MCP, waits for
the bot's reply, and verifies the observable effect (text content, image
attachment, PDF attachment, or state-readback through a follow-up tool call).

This is **not** a Vitest suite. It runs from a Claude Code session that has
Chrome DevTools MCP attached to a browser already logged into Discord. To
re-run: open the channel in Chrome, then ask Claude:

> Run the frontend test suite from `tests/frontend/`.

Claude reads `catalog.md` for the case list and `dom-helpers.js` for the
page-side scripts that read Discord's DOM via `evaluate_script`.

## Files

- `catalog.md` — the ~58 test cases as Markdown tables. Source of truth for what
  gets tested and how each result is verified. Edit here when adding tools.
- `dom-helpers.js` — page-side scripts (passed verbatim to
  `mcp__chrome-devtools__evaluate_script`). One reads channel state, one waits
  for a new bot reply, one focuses the message editor.
- `runs/` — markdown summaries from prior runs (one file per `runId`).

## Run isolation

Each run picks a fresh `runId = Date.now().toString(36)` and namespaces its
characters and beats with `T_<runId>_*`. Phase 0 sweeps any `T_*` beats from
prior crashed runs before the new run begins. Phase 10 deletes this run's
beats on success.

## Manual cleanup (rarely needed)

Test characters and library-generated images are not deleted automatically
because no `delete_character` tool exists and library images aren't
addressable for deletion. After many runs, prune them via the Mongo shell:

```js
// Inside the screenplay db
db.characters.deleteMany({ name: /^T_/ });
db['character_images.files'].deleteMany({});  // reclaims orphaned char images
db['images.files'].deleteMany({ 'metadata.owner_type': null });  // library
```

## Re-runnability guarantees

1. Fresh `runId` per run → no name collisions in `characters` / `beats`.
2. Phase 0 pre-sweep handles partial state from a crashed prior run.
3. Phase 10 cleanup deletes this run's beats on success.
4. Template mutations (T1.1 add tagline) are reverted in the same phase
   (T1.9 remove tagline). T1.10 is a negative test that doesn't mutate.
5. Failing tests do not block re-runs. Subsequent runs use a fresh prefix.
