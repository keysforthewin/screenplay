# AI Chatbot Beat Undo/Redo — Design

**Date:** 2026-06-14
**Status:** Approved, pending implementation plan

## Goal

When a user makes an edit through the AI chatbot in the web UI, capture the
state of the beat being edited so the edit can be undone — and keep a 10-deep
history so the user can walk undo/redo back and forth across the chatbot's
recent edits to that beat.

## Scope

- **Covered:** the three text fields of the beat on the current page —
  `name`, `desc`, `body` (the beat top fields per `roomRegistry.js`).
- **Trigger context:** undo/redo applies only when the chat is contextualized
  on a beat page (`pageCtx.kind === 'beat'`). On any other page (TOC,
  character, plot, library, notes) the controls are disabled with a tooltip
  explaining they only apply on a beat page.

### Out of scope (v1)

- Images, characters, structured/scene-bible fields, or any non-beat entity.
- Multiple entities touched in one run — only the current-page beat's text.
- Persistence across page reloads or across tabs (history is in-memory for the
  tab session, matching the chat transcript's existing behavior).
- Concurrent-edit guarding — see Concurrency below.

## Architecture

Client-side history + a thin restore endpoint. All history logic lives in the
UI where the buttons are; restore reuses the existing gateway → CRDT write path
so a revert propagates live to every open editor and persists to Mongo exactly
like an agent edit.

(Rejected alternative: a server-side snapshot store in Mongo. It would survive
reloads and be shared across tabs, but needs a new collection, eviction, and
cross-tab sync — too much for a session-scoped "undo what I just did" feature.)

## Data model — transaction stack, per beat, in-memory

A new hook `useBeatEditHistory` holds, keyed by beat `_id`:

- `undoStack`: array of transactions `{ before, after }`, where `before` and
  `after` are each `{ name, desc, body }` snapshots. **Capped at 10**; the
  oldest is dropped when an 11th is pushed.
- `redoStack`: array of the same shape.

Transaction semantics (robust against the live CRDT moving underneath us — we
record concrete before/after pairs rather than absolute positions):

- **Record** (after a chat run that targeted the current beat): read the beat's
  text again; if it differs from the pre-send snapshot, push `{ before, after }`
  to `undoStack` and clear `redoStack`.
- **Undo**: pop from `undoStack`, apply its `before`, push the transaction to
  `redoStack`.
- **Redo**: pop from `redoStack`, apply its `after`, push the transaction to
  `undoStack`.

"Going back and forth across ten changes" = a 10-deep `undoStack` the user can
walk up and down via undo/redo.

## Flow on each send (`ChatDialog`)

1. On send, if `pageCtx.kind === 'beat'`, capture
   `before = { name, desc, body }` for the beat (from the already-loaded beat
   or via `GET /api/beat?id=…`). Stash it alongside the pending message.
2. When the SSE run reaches `done`, fetch the beat text again → `after`. If it
   changed, record the transaction (see Data model).
3. The undo/redo buttons reflect the current beat's stacks
   (`undoStack.length` / `redoStack.length` drive disabled state).

## Server endpoint

`PUT /api/beat/:id/text` in `src/web/entityRoutes.js`, body
`{ name?, desc?, body? }`. For each provided field, call
`setEntityFieldMarkdown({ projectId: req.projectId, entityType: 'beat',
entityId, field, markdown })`. This reuses the existing gateway path:

- With Hocuspocus running, it applies CRDT ops so restores propagate live to
  every open editor and persist to Mongo.
- Without Hocuspocus (tests, CLI), the gateway falls back to writing Mongo
  directly via the existing helpers.

Project-scoped via `req.projectId`; unknown beat → 404.

## Concurrency

If a human or the bot edits the beat text between the AI edit and the user
clicking Undo, restoring the snapshot **overwrites** that intervening edit. No
compare/confirm guard — undo always writes the stored text back. The redo entry
still holds the AI's version, so a user who undoes too aggressively can recover
the AI edit (though not the lost intervening human edit). Accepted for v1.

## UI

A small control row in the `ChatDialog` footer, near the existing context chip:

- **↶ Undo** and **↷ Redo** buttons.
- Disabled when the respective stack is empty, or when not on a beat page.
- A brief transient status line after acting (e.g. "Reverted beat text").

## Testing

- **History reducer (unit, Vitest, no Mongo):** push caps at 10 (oldest
  dropped), undo/redo move transactions between stacks, redo stack cleared on a
  new recorded edit.
- **Endpoint (`PUT /api/beat/:id/text`):** against `tests/_fakeMongo.js`
  (gateway fallback writes Mongo when Hocuspocus isn't running) — assert the
  named fields update, partial patches work, and unknown beat → 404.
