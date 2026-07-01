# Beat drag-and-drop reorder + automatic renumbering

**Date:** 2026-07-01
**Status:** Approved design, pending spec review

## Problem

Beats are numbered by a loose `beat.order` integer stored in the embedded
`plots.beats[]` array. Nothing keeps `order` a clean sequence, so today:

- Reordering a beat means the user manually renumbers every beat afterward.
- `createBeat(order)` can produce duplicate numbers.
- `updateBeat({order})` sets a literal value and re-sorts — ties and gaps
  survive.
- `deleteBeat` leaves a gap (1, 2, 4, 5).
- The Table of Contents (`web/src/routes/Toc.jsx`) is a static list on all
  three tabs (Beats / Dialog / Storyboards) with no drag-and-drop.
- When the AI agent moves beats, the user still has to ask it to renumber.

## Goal

1. **`beat.order` becomes a maintained invariant:** always the contiguous
   sequence `1..N`, no gaps and no ties. Every operation that changes beat
   membership or position renumbers automatically.
2. **Drag-and-drop reorder** on the TOC Beats, Dialog, and Storyboards tabs.
   Dragging a beat immediately renumbers all beats sequentially.
3. **The AI agent renumbers automatically** — moving/creating/deleting a beat
   never requires a separate "set the beat number" step.
4. **Live TOC updates:** an open TOC re-fetches when the agent renumbers beats
   in the background.

Out of scope: decimal/gapped numbering schemes (confirmed: always sequential
`1,2,3…`); per-tab independent ordering (all three tabs order the *same*
underlying beats).

## Existing patterns to mirror

- **Dialog reorder** is the proven end-to-end template:
  `web/src/routes/DialogBeat.jsx#handleDragEnd` → `POST /dialogs/reorder`
  (`src/web/entityRoutes.js:5504`) → `reorderDialogsViaGateway`
  (`src/web/gateway.js:2165`) → `reorderDialogsForBeat`
  (`src/mongo/dialogs.js:189`, which already assigns `order = i + 1`).
- **dnd-kit** is already a dependency; `DialogItem.jsx` shows the
  `useSortable` + drag-handle pattern.
- **`reorder_director_notes`** (`src/agent/handlers.js:1502`) is the precedent
  for an agent-facing reorder tool.
- **Live broadcast:** `broadcastFieldsUpdated(roomName, payload)`
  (`src/web/gateway.js:216`) sends a `{type:'fields_updated'}` stateless ping
  to a room; the client listens via the `provider.on('stateless', …)` handler
  in `web/src/editor/CollabSurface.jsx:95`. The singleton `plot:<projectId>`
  room already exists (`About.jsx:84` connects to it).

## Design

### 1. Backend — normalization as an invariant (`src/mongo/plots.js`)

Add a pure helper:

```js
// Sort by current order, then rewrite order to a contiguous 1..N sequence.
// Returns a new array; does not persist.
function normalizeBeatOrders(beats) {
  return [...beats]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((b, i) => (b.order === i + 1 ? b : { ...b, order: i + 1 }));
}
```

Apply it in the three mutation paths so `1..N` is always maintained:

- **`createBeat`** — "insert at position N" semantics. When `order` is given,
  set the new beat's sort key to `order - 0.5` so it lands *before* whoever
  currently occupies position N, push, then `normalizeBeatOrders`. When `order`
  is omitted, append (current behavior) then normalize.
- **`updateBeat` (order changing)** — redefine `order = N` as **"move to
  position N"**: set the target beat's sort key to `N - 0.5`, then
  `normalizeBeatOrders` the full array and `persistBeatsFullArray`. `N` past the
  end clamps to the end. This replaces the current "set literal value + re-sort"
  block (`plots.js:405-420`).
- **`deleteBeat`** — after the `$pull`, read back, `normalizeBeatOrders`, and
  `persistBeatsFullArray` so gaps close. (Keep the `current_beat_id` clearing.)

Add the dedicated positional reorder (mirrors `reorderDialogsForBeat`):

```js
// orderedIds: full list of beat _ids in the desired sequence.
export async function reorderBeats(projectId, orderedIds) { … }
```

Validate: `orderedIds` is an array, length equals current beat count, no
duplicates, every id belongs to this project's plot. Then assign
`order = i + 1` by array position and `persistBeatsFullArray`. Return the
sorted beats.

**Why `N - 0.5` then normalize:** it gives unambiguous "insert before the beat
currently at N" behavior without relying on sort stability for ties, and the
normalize pass guarantees the persisted values are always clean integers.

### 2. Backend — gateway + REST

- **`reorderBeatsViaGateway({ projectId, orderedIds })`** (`src/web/gateway.js`)
  — call `mongoReorderBeats`, then broadcast the beats-changed ping (below).
  Returns the reordered beats.
- **Beats-changed broadcast.** Add a small shared helper
  `broadcastBeatsChanged(projectId)` that pings the singleton room:
  `broadcastFieldsUpdated(buildRoomName('plot', projectId), { changed: ['beats'] })`.
  Call it from every gateway-level path that renumbers beats: the new
  `reorderBeatsViaGateway`, `updateBeatViaGateway` when `order` changed, and
  from beat **create**/**delete** paths. To make create/delete fire the ping,
  route the agent handlers and REST endpoints for those through gateway
  wrappers (`createBeatViaGateway` / `deleteBeatViaGateway`) instead of calling
  `Plots.*` directly — mirroring how `updateBeatViaGateway` already wraps
  updates. The mongo layer stays broadcast-free (CLI/tests have no Hocuspocus).
- **`POST /beats/reorder`** (`src/web/entityRoutes.js`, mirror `/dialogs/reorder`
  at 5504): body `{ ordered_ids: [beatId…] }`; 400 if not an array; calls
  `reorderBeatsViaGateway`; responds `{ beats: [...] }`.

### 3. Frontend — shared sortable list + live TOC (`web/src/`)

- **`SortableBeatList`** (new widget, e.g. `web/src/widgets/SortableBeatList.jsx`)
  — mirrors `DialogBeat`'s DnD wiring:
  - `DndContext` (PointerSensor + KeyboardSensor, `closestCenter`) +
    `SortableContext` (`verticalListSortingStrategy`) over beat `_id`s.
  - Each row: a small drag handle (`⋮⋮`) via `useSortable`, plus caller-supplied
    row content (so the Beats tab keeps its `* #N — name` label and the
    Dialog/Storyboard tabs keep their `(count)` suffix). Row content is passed
    as a render function or `content` field per item.
  - `onDragEnd`: `arrayMove` locally (optimistic) → `POST /beats/reorder`
    `{ ordered_ids }` → on success refetch `/toc`; on error revert local order
    and surface the message.
  - **Disabled while the TOC search filter is active** (the list is partial —
    reordering a filtered subset is ill-defined). Drag handles hidden/inert
    when `query` is non-empty.
- **`Toc.jsx`** — replace the three static `<ul>` beat lists (Beats at 296,
  Dialog at 321, Storyboard at 350) with `SortableBeatList`. All three call the
  same `/beats/reorder`; the row renderer differs per tab.
- **Live updates via `useRoomBroadcast`** (new hook,
  `web/src/hooks/useRoomBroadcast.js`): connect a bare `HocuspocusProvider` to a
  given room (reusing the same ws-URL resolution `CollabSurface` uses),
  subscribe to `provider.on('stateless', …)`, parse `fields_updated`, and invoke
  a callback; tear down on unmount. TOC uses it on `plot:<projectId>` (project id
  from `useProject()`) to refetch `/toc` (debounced ~300ms) when a
  `{changed:['beats']}` ping arrives. This is a focused, reusable unit rather
  than abusing `CollabSurface`'s editor-wrapping contract.

### 4. Agent (`src/agent/`)

- **`reorder_beats` tool** (mirror `reorder_director_notes`): input
  `{ beat_ids: [string…] }` (full ordered list) → `reorderBeatsViaGateway` →
  returns a confirmation with the new order. Add matching schema in
  `tools.js` (with `keywords: ['move','reorder','renumber','sequence','order']`)
  and handler in `handlers.js`; `tests/tools-schema.test.js` requires both.
- **Auto-renumber everywhere else is free** — `set_field {field:'order'}` and
  `create_beat`/`delete_beat` all flow through the mongo functions above, which
  now always renumber. Update the `set_field` beat-order help text and the
  `create_beat`/`reorder_beats` descriptions to state that ordering stays
  sequential automatically and that `order = N` means "move to position N",
  so the model stops trying to renumber by hand.

## Data flow

**Drag (human):** drag row → optimistic `arrayMove` → `POST /beats/reorder` →
`reorderBeatsViaGateway` → `reorderBeats` (order = i+1) +
`broadcastBeatsChanged` → TOC refetch. Other open TOCs get the `plot:` ping and
refetch.

**Agent move:** `reorder_beats` / `set_field order` / `create_beat` /
`delete_beat` → mongo renumber → gateway broadcast to `plot:<projectId>` →
open TOCs refetch live.

## Error handling

- `reorderBeats` throws on length mismatch / duplicate / unknown id (like
  `reorderDialogsForBeat`); `POST /beats/reorder` maps a bad body to 400 and
  lets other throws hit the error middleware.
- Frontend reverts optimistic order and shows the error banner on failure.
- `broadcastFieldsUpdated` is a no-op when no clients are connected (returns
  false) — safe from CLI/agent contexts.

## Testing

- **mongo (`tests/`, fake Mongo):** `normalizeBeatOrders` closes gaps and ties;
  `createBeat({order:2})` inserts at position 2 and yields `1..N`;
  `updateBeat({order:2})` moves-to-position-2 and renumbers; `deleteBeat` closes
  the gap; `reorderBeats` renumbers by array position and rejects
  length/dup/unknown-id inputs.
- **REST:** `POST /beats/reorder` happy path + 400 on non-array `ordered_ids`
  + renumbering assertion.
- **agent:** `reorder_beats` handler renumbers; `tools-schema` parity holds;
  `set_field order` move-and-renumber behavior.
- **frontend:** light — a unit test on the `SortableBeatList` reorder callback
  (compute `ordered_ids` from a drag) and that drag is disabled under an active
  filter, following existing web test coverage depth (full dnd-kit DOM
  simulation is not currently covered for dialogs and is not added here).

## Files touched

- `src/mongo/plots.js` — `normalizeBeatOrders`, `reorderBeats`, and renumber in
  `createBeat`/`updateBeat`/`deleteBeat`.
- `src/web/gateway.js` — `reorderBeatsViaGateway`, `createBeatViaGateway`,
  `deleteBeatViaGateway`, `broadcastBeatsChanged`.
- `src/web/entityRoutes.js` — `POST /beats/reorder`; route create/delete beat
  through the new gateway wrappers.
- `src/agent/tools.js`, `src/agent/handlers.js` — `reorder_beats` tool + help
  text updates.
- `web/src/widgets/SortableBeatList.jsx` (new),
  `web/src/hooks/useRoomBroadcast.js` (new), `web/src/routes/Toc.jsx`.
- Tests across `tests/` and `web/` per the plan above.
