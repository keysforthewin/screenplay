// RAG indexer: shapes screenplay entities into Chroma chunks and keeps them
// in sync. Single source of truth for chunk IDs and metadata.
//
// Public surface:
//   indexBeat(beatId)
//   indexCharacter(characterId)
//   indexDirectorNote(noteId)
//   indexMessage(messageDoc)
//   deleteEntity(entityType, entityId)
//   pruneMessagesOlderThan(channelId, n)
//   reindexByKey(entityType, entityId)   -- queue dispatcher hook
//
// All public entry points are wrapped in try/catch and never throw — RAG
// failures must not block the underlying mutation. Use returned booleans to
// distinguish "ran" from "skipped".

import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../log.js';
import { stripMarkdown } from '../util/markdown.js';
import { chunkMarkdown } from './chunker.js';
import { embedTexts, RagDisabledError } from './embeddings.js';
import { getCollection, isRagEnabled } from './chromaClient.js';
import { setReindexRunner } from './queue.js';

import { getPlot } from '../mongo/plots.js';
import { getCharacter } from '../mongo/characters.js';
import { getDirectorNotes } from '../mongo/directorNotes.js';
import { extractSearchableText } from '../mongo/messages.js';
import { getDb } from '../mongo/client.js';

function idStr(id) {
  return id?.toString ? id.toString() : String(id);
}

function entityLabelOf(entityType, entity) {
  if (!entity) return '';
  if (entityType === 'beat') return stripMarkdown(entity.name || '').slice(0, 80);
  if (entityType === 'character') return stripMarkdown(entity.name || '').slice(0, 80);
  if (entityType === 'director_note') return 'note';
  if (entityType === 'message') return entity.author?.tag || entity.role || 'message';
  return '';
}

function buildChunksForField({ entityType, entityId, entityLabel, field, markdown }) {
  const md = String(markdown ?? '');
  if (!md.trim()) return [];
  // For short single-string fields (name, hollywood_actor, desc) we want one
  // chunk per field. For long fields (body, custom fields, note text) chunk.
  const oneChunkFields = new Set(['name', 'desc', 'hollywood_actor']);
  const useChunker = !oneChunkFields.has(field);
  const chunks = useChunker
    ? chunkMarkdown(md)
    : [{ text_md: md }];
  return chunks.map((c, i) => {
    const text_plain = stripMarkdown(c.text_md);
    const id = idForChunk({ entityType, entityId, field, chunkIndex: i });
    return {
      id,
      text_md: c.text_md,
      text_plain,
      metadata: {
        entity_type: entityType,
        entity_id: idStr(entityId),
        entity_label: entityLabel,
        field,
        chunk_index: i,
        text_md: c.text_md,
        updated_at: new Date().toISOString(),
      },
    };
  }).filter((c) => c.text_plain.trim().length > 0);
}

function idForChunk({ entityType, entityId, field, chunkIndex }) {
  const id = idStr(entityId);
  if (entityType === 'beat') {
    if (field === 'name') return `beat:${id}:name`;
    if (field === 'desc') return `beat:${id}:desc`;
    return `beat:${id}:body:${chunkIndex}`;
  }
  if (entityType === 'character') {
    if (field === 'name') return `character:${id}:name`;
    if (field === 'hollywood_actor') return `character:${id}:hollywood_actor`;
    if (field.startsWith('fields.')) {
      const key = field.slice('fields.'.length);
      return `character:${id}:field:${key}:${chunkIndex}`;
    }
    return `character:${id}:${field}:${chunkIndex}`;
  }
  if (entityType === 'director_note') return `director_note:${id}:text:${chunkIndex}`;
  if (entityType === 'message') return `message:${id}`;
  return `${entityType}:${id}:${field}:${chunkIndex}`;
}

async function existingIdsForEntity(col, entityType, entityId) {
  // Chroma's `get` with a where-filter returns matching docs; we only need
  // the ids.
  try {
    const res = await col.get({
      where: { $and: [{ entity_type: entityType }, { entity_id: idStr(entityId) }] },
      include: [],
    });
    return Array.isArray(res?.ids) ? res.ids : [];
  } catch (e) {
    logger.warn(`rag: get existing ids failed for ${entityType}:${entityId}: ${e.message}`);
    return [];
  }
}

async function upsertChunks(col, chunks) {
  if (!chunks.length) return;
  const texts = chunks.map((c) => c.text_plain);
  const embeddings = await embedTexts(texts, { inputType: 'document' });
  await col.upsert({
    ids: chunks.map((c) => c.id),
    embeddings,
    metadatas: chunks.map((c) => c.metadata),
    documents: chunks.map((c) => c.text_md),
  });
}

async function syncEntityChunks(col, entityType, entityId, freshChunks) {
  const fresh = new Set(freshChunks.map((c) => c.id));
  const prior = await existingIdsForEntity(col, entityType, entityId);
  const stale = prior.filter((id) => !fresh.has(id));
  if (stale.length) {
    try {
      await col.delete({ ids: stale });
    } catch (e) {
      logger.warn(`rag: delete stale (${entityType}:${entityId}) failed: ${e.message}`);
    }
  }
  await upsertChunks(col, freshChunks);
}

async function safeRun(label, fn) {
  if (!isRagEnabled()) return false;
  let col;
  try {
    col = await getCollection();
  } catch (e) {
    logger.warn(`rag: getCollection failed (${label}): ${e.message}`);
    return false;
  }
  if (!col) return false;
  try {
    await fn(col);
    return true;
  } catch (e) {
    if (e instanceof RagDisabledError) return false;
    throw e;
  }
}

// ─── Per-entity indexers ───────────────────────────────────────────────────

export async function indexBeat(beatId) {
  return safeRun(`beat:${beatId}`, async (col) => {
    const plot = await getPlot();
    const beat = (plot.beats || []).find((b) => b._id && idStr(b._id) === idStr(beatId));
    if (!beat) {
      // Entity gone — clean up any chunks for it.
      try { await col.delete({ where: { $and: [{ entity_type: 'beat' }, { entity_id: idStr(beatId) }] } }); } catch {}
      return;
    }
    const label = entityLabelOf('beat', beat);
    const chunks = [
      ...buildChunksForField({ entityType: 'beat', entityId: beat._id, entityLabel: label, field: 'name', markdown: beat.name }),
      ...buildChunksForField({ entityType: 'beat', entityId: beat._id, entityLabel: label, field: 'desc', markdown: beat.desc }),
      ...buildChunksForField({ entityType: 'beat', entityId: beat._id, entityLabel: label, field: 'body', markdown: beat.body }),
    ];
    await syncEntityChunks(col, 'beat', beat._id, chunks);
    // Stamp rag_indexed_at into the embedded beat for resumable backfill.
    try {
      await getDb().collection('plots').updateOne(
        { _id: 'main', 'beats._id': beat._id },
        { $set: { 'beats.$.rag_indexed_at': new Date() } },
      );
    } catch {}
  });
}

export async function indexCharacter(characterId) {
  return safeRun(`character:${characterId}`, async (col) => {
    const c = await getCharacter(idStr(characterId));
    if (!c) {
      try { await col.delete({ where: { $and: [{ entity_type: 'character' }, { entity_id: idStr(characterId) }] } }); } catch {}
      return;
    }
    const label = entityLabelOf('character', c);
    const chunks = [
      ...buildChunksForField({ entityType: 'character', entityId: c._id, entityLabel: label, field: 'name', markdown: c.name }),
      ...buildChunksForField({ entityType: 'character', entityId: c._id, entityLabel: label, field: 'hollywood_actor', markdown: c.hollywood_actor }),
    ];
    const fields = (c.fields && typeof c.fields === 'object') ? c.fields : {};
    for (const [k, v] of Object.entries(fields)) {
      const text = typeof v === 'string' ? v : (v == null ? '' : JSON.stringify(v));
      chunks.push(
        ...buildChunksForField({
          entityType: 'character',
          entityId: c._id,
          entityLabel: label,
          field: `fields.${k}`,
          markdown: text,
        }),
      );
    }
    await syncEntityChunks(col, 'character', c._id, chunks);
    try {
      await getDb().collection('characters').updateOne(
        { _id: c._id },
        { $set: { rag_indexed_at: new Date() } },
      );
    } catch {}
  });
}

export async function indexDirectorNote(noteId) {
  return safeRun(`director_note:${noteId}`, async (col) => {
    const doc = await getDirectorNotes();
    const note = (doc.notes || []).find((n) => n._id && idStr(n._id) === idStr(noteId));
    if (!note) {
      try { await col.delete({ where: { $and: [{ entity_type: 'director_note' }, { entity_id: idStr(noteId) }] } }); } catch {}
      return;
    }
    const chunks = buildChunksForField({
      entityType: 'director_note',
      entityId: note._id,
      entityLabel: 'note',
      field: 'text',
      markdown: note.text,
    });
    await syncEntityChunks(col, 'director_note', note._id, chunks);
  });
}

// indexMessage takes the inserted message doc (post-insert).
export async function indexMessage(messageDoc) {
  if (!messageDoc || !messageDoc._id) return false;
  return safeRun(`message:${idStr(messageDoc._id)}`, async (col) => {
    const text_md = extractSearchableText(messageDoc);
    const text_plain = stripMarkdown(text_md);
    if (!text_plain.trim()) return;
    const id = `message:${idStr(messageDoc._id)}`;
    const metadata = {
      entity_type: 'message',
      entity_id: idStr(messageDoc._id),
      entity_label: entityLabelOf('message', messageDoc),
      field: 'content',
      chunk_index: 0,
      text_md,
      channel_id: messageDoc.channel_id || null,
      role: messageDoc.role || null,
      created_at: messageDoc.created_at instanceof Date
        ? messageDoc.created_at.toISOString()
        : (messageDoc.created_at ? String(messageDoc.created_at) : null),
      updated_at: new Date().toISOString(),
    };
    const [embedding] = await embedTexts([text_plain], { inputType: 'document' });
    await col.upsert({
      ids: [id],
      embeddings: [embedding],
      metadatas: [metadata],
      documents: [text_md],
    });
  });
}

export async function deleteEntity(entityType, entityId) {
  return safeRun(`delete:${entityType}:${entityId}`, async (col) => {
    try {
      await col.delete({
        where: { $and: [{ entity_type: entityType }, { entity_id: idStr(entityId) }] },
      });
    } catch (e) {
      logger.warn(`rag: deleteEntity failed: ${e.message}`);
    }
  });
}

// Keep only the most recent N indexed messages per channel. Run occasionally,
// not on every insert.
export async function pruneMessagesOlderThan(channelId, keep) {
  if (!channelId) return false;
  return safeRun(`prune:${channelId}`, async (col) => {
    const res = await col.get({
      where: { $and: [{ entity_type: 'message' }, { channel_id: channelId }] },
      include: ['metadatas'],
    });
    const ids = Array.isArray(res?.ids) ? res.ids : [];
    const metas = Array.isArray(res?.metadatas) ? res.metadatas : [];
    if (ids.length <= keep) return;
    const rows = ids.map((id, i) => ({
      id,
      created_at: metas[i]?.created_at || '',
    }));
    rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const toDelete = rows.slice(keep).map((r) => r.id);
    if (toDelete.length) {
      try {
        await col.delete({ ids: toDelete });
        logger.info(`rag: pruned ${toDelete.length} messages for channel=${channelId}`);
      } catch (e) {
        logger.warn(`rag: prune delete failed: ${e.message}`);
      }
    }
  });
}

// Queue dispatch: "<entityType>:<entityId>" → matching indexer.
export async function reindexByKey(entityType, entityId) {
  if (entityType === 'beat') return indexBeat(entityId);
  if (entityType === 'character') return indexCharacter(entityId);
  if (entityType === 'director_note') return indexDirectorNote(entityId);
  if (entityType === 'message') {
    // Message reindex requires the doc — caller should pass the doc directly
    // via indexMessage. The queue path is best-effort lookup by id.
    try {
      const oid = /^[a-f0-9]{24}$/i.test(entityId) ? new ObjectId(entityId) : entityId;
      const doc = await getDb().collection('messages').findOne({ _id: oid });
      if (doc) return indexMessage(doc);
    } catch {}
    return false;
  }
  return false;
}

// Wire the queue's runner once, on import. Side effect at module load is
// intentional — we want enqueueReindex() to "just work" anywhere.
setReindexRunner(reindexByKey);

export const _internals = {
  buildChunksForField,
  idForChunk,
  entityLabelOf,
  syncEntityChunks,
};

// Re-export config-derived helpers for consumers that want to print stats.
export function ragMessageWindow() {
  return config.rag.messageWindow;
}
