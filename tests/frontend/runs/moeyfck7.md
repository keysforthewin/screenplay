# Frontend test run summary — runId=moeyfck7 @ 2026-04-25T23:14Z

PASS: 21   FAIL: 4   BLOCKED: 33   TOTAL: 58
Duration: ~10 min

## Headline finding

A latent bug in `src/mongo/messages.js:78 loadHistoryForLlm` makes the bot
*unrecoverably wedge* once the rolling 60-message window cuts mid-tool-turn.
Anthropic returns `400 invalid_request_error: messages.0.content.0: unexpected
tool_use_id found in tool_result blocks: …` because the loaded history begins
with an orphaned `tool_result` whose `tool_use` was truncated off.

This was first observable around T2.8 (intermittent — every 2–3 calls) and by
the time Phase 3 began it was firing on **every call**, blocking all
remaining Discord-driven tests including the Phase 10 cleanup. To re-run
the suite, fix this bug first, then drop or trim `messages` so the next run
starts from a healthy state:

```js
// In the screenplay db, mongo shell
db.messages.deleteMany({ channel_id: "322822813549461535" });
```

(Or fix `loadHistoryForLlm` and just wait — the orphan rolls out of the
window after enough new messages.)

## Failures

- **HISTORY-BUG (the only real failure, hit by T2.8, T2.10, T2.13, T2.16, T2.17,
  T3.1 first attempt, T3.2 both attempts, all of T3.3–T8.2 and C10.1)**
  - Symptom: bot reply is `"Sorry — internal error: 400 {…unexpected tool_use_id
    found in tool_result blocks: toolu_…}"`.
  - Reproduce: send any message that triggers a tool while the oldest doc in
    the last 60 of `messages` is a user-role doc whose `content` is an array
    starting with a `tool_result` block.
  - Suspect: `src/mongo/messages.js:78` — `loadHistoryForLlm` returns the
    last 60 docs verbatim (`docs.reverse(); return docs.map(docToLlmMessage)`)
    with no logic to drop a leading orphan or to keep tool_use/tool_result
    pairs atomic across the truncation boundary.
  - Suggested fix sketch (after `docs.reverse()`):
    ```js
    while (docs.length) {
      const first = docs[0];
      const isOrphanToolResult =
        first.role === 'user' &&
        Array.isArray(first.content) &&
        first.content.length > 0 &&
        first.content.every((b) => b.type === 'tool_result');
      if (!isOrphanToolResult) break;
      docs.shift();
    }
    ```
    Optionally also drop a leading `assistant` message whose `content` is an
    array containing only `tool_use` blocks — its result has been recorded but
    keeping the assistant turn alone is fine for Anthropic; no fix needed there.
  - Add a unit test in `tests/messages-format.test.js` covering: history that
    starts with an orphan `tool_result` user message → loader strips it.

- **WIKIMEDIA-HOTLINK (cosmetic, T3.1 first attempt only)**
  - Symptom: `add_character_image` returned a friendly error about Wikimedia
    requiring special headers.
  - Reproduce: `add_character_image source_url=https://upload.wikimedia.org/...`.
  - Note: not a bot bug — Wikimedia genuinely refuses hotlinks without a
    `User-Agent`. Either set a UA in `src/mongo/imageBytes.js:fetchImageFromUrl`
    or drop Wikimedia from the test catalog. Picsum (`https://picsum.photos`)
    is a working stand-in and is now baked into the catalog.

## Blocked (history bug — root failure means dependents weren't fairly tested)

- **Phase 3 (T3.3, T3.4, T3.5)** — list/set-main/remove character image
- **Phase 4 (T4.1–T4.7)** — beat images, library, show_image
- **Phase 5 (T5.1–T5.4)** — generate_image (Gemini)
- **Phase 6 (T6.1–T6.6)** — TMDB search/get/credits/person/show_image
- **Phase 7 (T7.1–T7.3)** — Tavily search and show_image
- **Phase 8 (T8.1, T8.2)** — export_pdf
- **T9.2** — `GET /pdf/<filename>` (skipped: needs T8.1 to produce a file)
- **C10.1** — beat cleanup (will be swept by next run's Phase 0)

These are NOT independent failures — they are downstream of the history bug.
Once the loader fix is in place, expect all of these to pass without further
changes.

## Pass list

- **Phase 0**: P0.1, P0.2, P0.3, P0.4
- **Phase 1**: T1.1, T1.2, T1.3, T1.4, T1.5, T1.6, T1.7, T1.8, T1.9, T1.10
- **Phase 2**: T2.1, T2.2, T2.3, T2.4, T2.5, T2.6, T2.7, T2.9, T2.11, T2.12,
  T2.13 (on retry), T2.14, T2.15, T2.16 (on retry)
- **Phase 9**: T9.1 (`GET /health` → 200, body `{"ok":true}`)

## Captured run state (for re-run reference)

- `runId`: `moeyfck7`
- `hero_id`: `69ed4ae38f018b2fb66d9077`
- `villain_id`: `69ed4af38f018b2fb66d907c`
- `beat ids`: Open=`69ed4b5e8f018b2fb66d909d`, Mid=`69ed4b688f018b2fb66d90a2`,
  Close=`69ed4b718f018b2fb66d90a7`
- Test characters and the three test beats persist in Mongo. The next run's
  Phase 0 sweep will clear the beats; characters live on (no
  `delete_character` tool exists).
