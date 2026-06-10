// Project-scoped semantic search over the Chroma screenplay index.
//
// searchScreenplay(projectId, query, opts) is the single query entry point:
// the screenplay_search agent handler (and any future REST search endpoint)
// calls this instead of talking to chromaClient directly. It never throws —
// failures come back as { ok: false, reason, message } with a user-facing
// message string the handler can return verbatim.
//
//   searchScreenplay(projectId, query, { k, entityTypes } = {})
//     → { ok: true,  hits: [{ id, score, entity_type, entity_id, entity_label, field, text }] }
//     → { ok: false, reason: 'disabled' | 'unreachable' | 'embedding_error' | 'query_error', message }
//
// projectId is a 24-hex string; falsy → default project (transitional
// resolveProjectId semantics, strict after the Phase F flip).

import { config } from '../config.js';
import { isRagEnabled, getCollection } from './chromaClient.js';
import { embedTexts } from './embeddings.js';
import { resolveProjectId } from '../mongo/projects.js';

export async function searchScreenplay(projectId, query, { k, entityTypes } = {}) {
  if (!isRagEnabled()) {
    return {
      ok: false,
      reason: 'disabled',
      message:
        'Semantic search is unavailable: VOYAGE_API_KEY is not configured. Use `search_beats` / `search_characters` / `search_message_history` as alternatives.',
    };
  }
  const col = await getCollection();
  if (!col) {
    return {
      ok: false,
      reason: 'unreachable',
      message:
        'Semantic search is temporarily unavailable: ChromaDB not reachable (run `docker compose up -d chroma`). Falling back: try `search_beats` / `search_characters` / `search_message_history`.',
    };
  }
  const pid = await resolveProjectId(projectId);
  const topK = Math.min(20, Math.max(1, Number(k) || config.rag.defaultK));
  const clauses = [{ project_id: pid }];
  if (Array.isArray(entityTypes) && entityTypes.length) {
    clauses.push(
      entityTypes.length === 1
        ? { entity_type: entityTypes[0] }
        : { entity_type: { $in: entityTypes } },
    );
  }
  const where = clauses.length === 1 ? clauses[0] : { $and: clauses };
  let queryVec;
  try {
    [queryVec] = await embedTexts([query], { inputType: 'query' });
  } catch (e) {
    return {
      ok: false,
      reason: 'embedding_error',
      message: `Semantic search failed (embedding error): ${e.message}`,
    };
  }
  let res;
  try {
    res = await col.query({ queryEmbeddings: [queryVec], nResults: topK, where });
  } catch (e) {
    return {
      ok: false,
      reason: 'query_error',
      message: `Semantic search failed (chroma query error): ${e.message}`,
    };
  }
  const ids = res?.ids?.[0] || [];
  const distances = res?.distances?.[0] || [];
  const metadatas = res?.metadatas?.[0] || [];
  const documents = res?.documents?.[0] || [];
  const hits = ids.map((id, i) => {
    const m = metadatas[i] || {};
    const dist = typeof distances[i] === 'number' ? distances[i] : null;
    const score = dist == null ? null : Math.max(0, Math.min(1, 1 - dist));
    return {
      id,
      score: score == null ? null : Number(score.toFixed(4)),
      entity_type: m.entity_type || null,
      entity_id: m.entity_id || null,
      entity_label: m.entity_label || null,
      field: m.field || null,
      text: m.text_md || documents[i] || '',
    };
  });
  return { ok: true, hits };
}
