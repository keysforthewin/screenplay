# Project rename & delete (About page) — design

Date: 2026-07-27

## Problem

The About page can edit the screenplay's cover title but offers no way to
rename the *project* (the name in the header brand and in the `/p/<title>/`
URL), and there is no way to delete a project at all. `ProjectManagerDialog`
shipped as "list + switch + create (rename/delete deferred)"; this is that
deferred half, surfaced on the About page where the user expects it.

A secondary confusion to fix: the About tab's `Project name` field edits the
*plot* doc's `title` (the screenplay's cover title) and is commonly blank,
which reads as "the project has no name". It gets relabelled.

## Scope

1. `PATCH /api/projects/:id` — rename a project.
2. `DELETE /api/projects/:id` — full cascade delete of one project.
3. About page: a plain rename field, and a bottom-of-tab danger zone with a
   type-the-title confirmation.

Out of scope: per-project backup/export before delete (backup remains
whole-DB `mongodump`), undo, soft delete, agent-facing tools for either
operation, role-based permission (any approved session may do both, matching
the rest of the SPA's v1 auth model).

## Delete cascade

A project owns rows in eight places. Order matters — entity ids must be
collected before the documents holding them are removed.

1. **Collect ids**: beat ids from the project's `plots` doc, character ids
   from `characters`. Needed to derive y-doc room names.
2. **Content collections** (`project_id` equality): `plots`, `characters`,
   `messages`, `storyboards`, `dialogs`, `edit_announcements`.
3. **Prompts**: composite ids `<pid>:character_template`,
   `<pid>:plot_template`, `<pid>:director_notes`.
4. **GridFS**: every file in the `images` and `attachments` buckets whose
   `metadata.project_id` matches, removed via `bucket.delete(id)` so chunks go
   with the file.
5. **y-docs** (`yjs_docs`): singleton rooms `plot:<pid>`, `notes:<pid>`,
   `library:<pid>`, plus `beat:<id>`, `storyboards:<id>`, `dialogs:<id>` for
   every collected beat id and `character:<id>` for every character id.
6. **Chroma**: `deleteProject(projectId)` in `src/rag/indexer.js`, deleting
   `where: {project_id}`. Best-effort through the existing `safeRun` wrapper —
   an unreachable Chroma logs and does not fail the request.
7. **`channel_state`**: any channel whose `current_project_id` is the deleted
   project is repointed at the default project, so the Discord bot never holds
   a dangling project id.
8. **The `projects` doc**, last, so a mid-way crash leaves the project
   visible and re-deletable rather than orphaning its content.

`token_usage` is channel-scoped, not project-scoped, and is deliberately left
alone (billing/usage history outlives the project).

### Known limitation: live Hocuspocus rooms

If another browser tab is still connected to a room belonging to the deleted
project, the ~2s persistence tick can re-insert that room's `yjs_docs` row
after step 5. The orphan row is harmless — the project and all of its Mongo
documents are gone, and `resolveRoom` fails closed on a room whose entity no
longer exists — but it is not prevented. y-docs are deleted late to narrow the
window.

### Implementation shape

`src/web/projectDelete.js` exports `deleteProjectCascade(projectId)`, which
runs the steps above and returns per-step counts. The route stays thin and the
cascade is unit-testable against `tests/_fakeMongo.js`.

## Endpoints

Added to `src/web/entityRoutes.js` beside the existing `GET`/`POST`
`/projects`. Both address the project by path id rather than the
`X-Project-Id` header, so deleting a project you are not currently viewing
works and a stale header cannot misdirect a destructive call.

| Route | Success | Errors |
| --- | --- | --- |
| `PATCH /api/projects/:id {title}` | `200 {id, title}` | `400` invalid title, `404` unknown project, `409` duplicate title |
| `DELETE /api/projects/:id` | `200 {ok:true, deleted:{…counts}}` | `404` unknown project, `409` when it is the only project |

The `409` on the last project avoids the empty-database state in which the bot
lazily recreates a blank `Screenplay` project mid-request.

`renameProject(id, title)` is added to `src/mongo/projects.js`: it reuses
`normalizeProjectTitle`, rejects a `title_lower` collision with any *other*
project, and updates `title` + `title_lower`. Rename is safe by construction —
every room name, GridFS file, and content row keys off `project_id`, never the
title. Only the URL and the displayed name change.

## About page

**Rename** — top of the About tab: a plain (non-collaborative) `Project title`
text input plus a Save button, helper text "The project's name in the header
and URL." On success the SPA updates the module store in `api.js` and the
`screenplay_project_v1` localStorage entry, then `location.assign`es to the new
`/p/<newTitle>/` — a full page load, mirroring how project switching already
tears down every socket, EventSource, and poller.

The adjacent collaborative field keeps editing the plot doc but is relabelled
**Screenplay title**, helper text "The title on the screenplay cover page", so
the two names are no longer confusable.

**Danger zone** — bottom of the About tab (not the Dialogue or Director's
Notes tabs): a red-bordered panel listing in plain English what will be
destroyed, and a `Delete this project` button opening a `Modal` whose confirm
button stays disabled until the exact project title is typed. On success the
SPA clears the stored project and `location.assign`es to `/`, which redirects
into the default project.

## Testing

Vitest against the in-memory fake Mongo:

- rename: success, duplicate title `409`, invalid title `400`, unknown id `404`
- delete: every project-scoped row and GridFS file removed
- delete: **a second project's rows are left fully intact** (the isolation case)
- delete: the only remaining project returns `409` and deletes nothing
- delete: `channel_state.current_project_id` is repointed at the default project

`tests/_fakeMongo.js` gains whatever the cascade needs (at minimum
`deleteMany`/`deleteOne`).
