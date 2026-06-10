#!/usr/bin/env node
/**
 * One-shot migration: single-project deployment -> multi-project.
 *
 * Implements the 7 steps from docs/superpowers/specs/2026-06-09-multi-project-design.md
 * § "Migration":
 *   1. Create the default project, titled from the current screenplay title
 *      (stripMarkdown(plot.title), fallback "Screenplay"). Idempotency anchor:
 *      if a project already exists, the oldest one (by created_at) is adopted.
 *      Hardening: if the NEW code restarted before this script ran, two timing
 *      windows exist:
 *        a) CRASH-MID-SEED: the new code started, created a lazy "Screenplay"
 *           project, then crashed before stamping the main plot. The main plot
 *           doc is UNSTAMPED (project_id missing).
 *        b) RESTART-FIRST: the new code fully booted, ran seedDefaults(), and
 *           stamped the main plot to the lazy project before the operator ran
 *           this script. The main plot doc IS stamped to the lazy project's id.
 *      In both windows: if the main-keyed plot doc (claimed-legacy marker)
 *      exists with project_id absent or equal to the candidate project's id,
 *      AND the adopted project is titled "Screenplay" with no other stamped
 *      data, it is RENAMED from the real plot title rather than staying generic
 *      (and rather than creating a duplicate project).
 *   2. Stamp project_id on plots/characters/messages/storyboards/dialogs docs
 *      and metadata.project_id on images/attachments GridFS files; ensure the
 *      plots {project_id:1} partial unique index (same as startup creates in
 *      src/mongo/client.js).
 *   3. Re-key the three prompts singletons to composite _ids
 *      (<projectId>:character_template etc.) via insert-new + delete-old
 *      (_id is immutable in Mongo; a rename is impossible). While the legacy
 *      singleton still exists it is AUTHORITATIVE: any composite doc already
 *      present (a freshly-seeded default from a premature restart, or a
 *      half-finished previous run) is overwritten by the legacy content —
 *      the user's customized templates always win over seeded defaults.
 *   4. Rename the three yjs_docs singleton rows (plot/notes/library ->
 *      <name>:<projectId>) preserving the CRDT binary state bytes. Entity rooms
 *      (beat:/character:/storyboards:/dialogs:<hex>) are untouched.
 *      Existence-wins policy is DELIBERATE: if a composite room (e.g.
 *      notes:<pid>) already exists from a post-restart write, it may carry
 *      newer user edits than the legacy singleton — the composite survives and
 *      the legacy is deleted; content is preserved via Mongo; only the legacy
 *      CRDT history is sacrificed.
 *   5. Swap the characters unique index: drop {name_lower:1}, create
 *      {project_id:1, name_lower:1}. Guarded behind a dropIndex capability
 *      check so the in-memory test fake skips it.
 *   6. Point channel_state.current_project_id at the default project for the
 *      configured channel (only when unset — never clobbers a later switch).
 *   7. Print a reminder to run scripts/reindex-rag.js (full Chroma reindex
 *      with the new project_id metadata).
 *
 * Properties:
 *   - Idempotent. Every step is guarded ($exists filters / lookup-before-insert),
 *     so re-running is a no-op.
 *   - Run BEFORE the restarted bot serves traffic (see the Multi-project
 *     runbook in CLAUDE.md).
 *
 * Usage (inside the bot container):
 *   docker compose exec bot node scripts/migrate-multi-project.js
 */

import { ObjectId } from 'mongodb';
import { pathToFileURL } from 'node:url';
import { connectMongo, closeMongo } from '../src/mongo/client.js';
import { stripMarkdown } from '../src/util/markdown.js';

const STAMPED_COLLECTIONS = ['plots', 'characters', 'messages', 'storyboards', 'dialogs'];
const GRIDFS_FILE_COLLECTIONS = ['images.files', 'attachments.files'];
const PROMPT_KEYS = ['character_template', 'plot_template', 'director_notes'];
const SINGLETON_ROOMS = ['plot', 'notes', 'library'];

// Project titles are plain text: trimmed, non-empty, max 120 chars, no '/'.
// Guards '.' and '..' (file-system sentinels) by falling back to 'Screenplay',
// matching normalizeProjectTitle's rules.
function deriveProjectTitle(plot) {
  const raw = stripMarkdown(String(plot?.title || '')).replace(/\//g, ' ').trim();
  const title = raw.slice(0, 120).trim();
  if (!title || title === '.' || title === '..') return 'Screenplay';
  return title;
}

// True when any content doc / GridFS file is already stamped with this
// project id — i.e. the project genuinely owns data and must not be renamed.
// Prompts composites, yjs rooms, and channel_state are deliberately excluded:
// they may exist as freshly-seeded/empty defaults and should not block a rename
// that replaces them with the real legacy content.
// The main plot doc (_id 'main') is also excluded from the plots check: being
// stamped there is exactly the restart-first trigger marker, not independent
// evidence of user data.
async function projectHasStampedData(db, projectId) {
  const plotStamped = await db
    .collection('plots')
    .findOne({ project_id: projectId, _id: { $ne: 'main' } });
  if (plotStamped) return true;
  for (const name of STAMPED_COLLECTIONS.filter((n) => n !== 'plots')) {
    if (await db.collection(name).findOne({ project_id: projectId })) return true;
  }
  for (const name of GRIDFS_FILE_COLLECTIONS) {
    if (await db.collection(name).findOne({ 'metadata.project_id': projectId })) return true;
  }
  return false;
}

export async function migrate(db, { channelId = null } = {}) {
  const summary = {
    createdProject: false,
    renamedProject: false,
    projectId: null,
    title: null,
    stamped: {},
    promptsRekeyed: 0,
    yjsRenamed: 0,
    channelStateSet: false,
  };

  // --- 1. Default project (idempotency anchor: oldest existing project wins).
  const projects = db.collection('projects');
  const plot = await db.collection('plots').findOne({ _id: 'main' });
  const existing = await projects.find({}).sort({ created_at: 1 }).limit(1).toArray();
  let project = existing[0] || null;
  if (!project) {
    const title = deriveProjectTitle(plot);
    project = {
      _id: new ObjectId(),
      title,
      title_lower: title.toLowerCase(),
      created_at: new Date(),
    };
    await projects.insertOne(project);
    summary.createdProject = true;
    console.log(`Created default project "${title}" (${project._id})`);
  } else {
    // Rename hardening: check whether the main-keyed plot doc is the
    // claimed-legacy marker for either timing window (see file-level comment).
    // Eligible if: _id 'main' plot exists, its project_id is absent (crash-
    // mid-seed) or equals the candidate project id (restart-first), the
    // adopted project is still titled "Screenplay", and no content has been
    // stamped yet.
    const candidatePid = project._id.toString();
    const claimedLegacyPlot =
      plot && (!plot.project_id || plot.project_id === candidatePid) ? plot : null;
    if (
      claimedLegacyPlot &&
      project.title === 'Screenplay' &&
      !(await projectHasStampedData(db, candidatePid))
    ) {
      const title = deriveProjectTitle(claimedLegacyPlot);
      const collides =
        title.toLowerCase() !== 'screenplay' &&
        (await projects.findOne({ title_lower: title.toLowerCase() }));
      if (title !== 'Screenplay' && !collides) {
        await projects.updateOne(
          { _id: project._id },
          { $set: { title, title_lower: title.toLowerCase() } },
        );
        project = { ...project, title, title_lower: title.toLowerCase() };
        summary.renamedProject = true;
        console.log(
          `Renamed lazily-created default project "Screenplay" -> "${title}" (${project._id})`,
        );
      } else {
        console.log(`Default project already present: "${project.title}" (${project._id})`);
      }
    } else {
      console.log(`Default project already present: "${project.title}" (${project._id})`);
    }
  }
  const projectId = project._id.toString();
  summary.projectId = projectId;
  summary.title = project.title;

  // --- 2. Stamp project_id on content docs + GridFS file metadata.
  for (const name of STAMPED_COLLECTIONS) {
    const res = await db
      .collection(name)
      .updateMany({ project_id: { $exists: false } }, { $set: { project_id: projectId } });
    summary.stamped[name] = res.modifiedCount ?? 0;
    console.log(`Stamped ${name}: ${summary.stamped[name]} docs`);
  }
  for (const name of GRIDFS_FILE_COLLECTIONS) {
    const res = await db
      .collection(name)
      .updateMany(
        { 'metadata.project_id': { $exists: false } },
        { $set: { 'metadata.project_id': projectId } },
      );
    summary.stamped[name] = res.modifiedCount ?? 0;
    console.log(`Stamped ${name}: ${summary.stamped[name]} files`);
  }

  // Plots are one-doc-per-project post-migration. Ensure the same partial
  // unique index startup creates (src/mongo/client.js), so a restored
  // pre-migration dump converges without waiting for the next restart. The
  // partialFilterExpression skips any doc still missing the string stamp.
  await db
    .collection('plots')
    .createIndex(
      { project_id: 1 },
      { unique: true, partialFilterExpression: { project_id: { $type: 'string' } } },
    );
  console.log('plots index: {project_id:1} unique (partial) ensured');

  // Ensure projects title_lower unique index alongside plots/characters (same
  // restored-dump rationale: startup may not have run yet after a dump restore).
  await db.collection('projects').createIndex({ title_lower: 1 }, { unique: true });
  console.log('projects index: {title_lower:1} unique ensured');

  // --- 3. Re-key prompts singletons to composite ids (insert-new + delete-old).
  // The legacy singleton is AUTHORITATIVE while it exists: if a composite doc
  // is already present, it is either a freshly-seeded default (the new code
  // restarted and seedProjectDefaults ran before this script) or the leftover
  // of a run that died between insert and delete-legacy. In both cases the
  // legacy content — which carries the user's customizations — wins, so we
  // OVERWRITE (delete composite, re-insert from legacy) and only then delete
  // the legacy doc. Re-running from any crash point converges: as long as the
  // legacy doc exists the composite is rebuilt from it; once the legacy doc is
  // gone the composite is the live document and is never touched again.
  const prompts = db.collection('prompts');
  for (const key of PROMPT_KEYS) {
    const legacy = await prompts.findOne({ _id: key });
    if (!legacy) continue;
    const newId = `${projectId}:${key}`;
    await prompts.deleteOne({ _id: newId });
    await prompts.insertOne({ ...legacy, _id: newId, project_id: projectId });
    await prompts.deleteOne({ _id: key });
    summary.promptsRekeyed++;
    console.log(`Re-keyed prompts/${key} -> ${newId} (legacy content wins over any seeded default)`);
  }

  // --- 4. Rename the three yjs singleton rows preserving CRDT state bytes.
  // Existence-wins: if a composite room (e.g. notes:<pid>) already exists from
  // a post-restart write, it may carry newer user edits — the composite
  // survives and the legacy is deleted; content is preserved via Mongo; only
  // the legacy CRDT history is sacrificed. This is DELIBERATE.
  const yjs = db.collection('yjs_docs');
  for (const room of SINGLETON_ROOMS) {
    const legacy = await yjs.findOne({ _id: room });
    if (!legacy) continue;
    const newId = `${room}:${projectId}`;
    const already = await yjs.findOne({ _id: newId });
    if (!already) {
      await yjs.insertOne({ ...legacy, _id: newId });
    }
    await yjs.deleteOne({ _id: room });
    summary.yjsRenamed++;
    console.log(`Renamed yjs_docs/${room} -> ${newId}`);
  }

  // --- 5. Swap the characters unique index. dropIndex is guarded behind a
  // capability check so the in-memory test fake (no dropIndex) skips it; on
  // real Mongo a missing legacy index is a warning, not a failure (code 27/26).
  const characters = db.collection('characters');
  if (typeof characters.dropIndex === 'function') {
    await characters.dropIndex('name_lower_1').catch((e) => {
      if (e?.code === 27 || e?.code === 26 || /index not found/i.test(e?.message || '')) {
        console.warn(`dropIndex name_lower_1 skipped (already absent): ${e.message}`);
      } else {
        throw e;
      }
    });
  }
  await characters.createIndex({ project_id: 1, name_lower: 1 }, { unique: true });
  console.log('characters index: {project_id:1, name_lower:1} unique ensured');

  // --- 6. Point the agent channel at the default project (only when unset).
  if (channelId) {
    const channelState = db.collection('channel_state');
    const doc = await channelState.findOne({ _id: channelId });
    if (!doc?.current_project_id) {
      await channelState.updateOne(
        { _id: channelId },
        { $set: { current_project_id: projectId, updated_at: new Date() } },
        { upsert: true },
      );
      summary.channelStateSet = true;
      console.log(`channel_state/${channelId}.current_project_id -> ${projectId}`);
    } else {
      console.log(
        `channel_state/${channelId} already points at ${doc.current_project_id}; left untouched`,
      );
    }
  }

  // --- 7. Operator reminder.
  console.log(
    'Reminder: run `node scripts/reindex-rag.js` next — full Chroma reindex with project_id metadata.',
  );

  return summary;
}

async function main() {
  const { config } = await import('../src/config.js');
  const db = await connectMongo();
  const summary = await migrate(db, { channelId: config.discord.movieChannelId });
  console.log(JSON.stringify(summary, null, 2));
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .catch((e) => {
      console.error('Migration failed:', e);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeMongo();
    });
} else if (process.argv[1] && process.argv[1].includes('migrate-multi-project')) {
  // Module was loaded via a path containing our script name (e.g. a symlink or
  // wrapper that changed argv[1] so the URL guard rejected it). Log a warning
  // so the operator knows the migration did not run; do not exit non-zero.
  console.warn(
    `[migrate-multi-project] Loaded via ${process.argv[1]} but import.meta.url did not match — ` +
      'running as a library import. Call migrate() directly or invoke the canonical script path.',
  );
}
