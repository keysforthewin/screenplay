// In-memory fake of the chromadb Collection surface used by src/rag/*.
// Supports the subset we actually call: get, upsert, query, delete, with
// minimal $and / $in / $eq where-clause handling.

function matchWhere(where, meta) {
  if (!where || typeof where !== 'object') return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === '$and') {
      for (const sub of v) {
        if (!matchWhere(sub, meta)) return false;
      }
      continue;
    }
    if (k === '$or') {
      let any = false;
      for (const sub of v) {
        if (matchWhere(sub, meta)) { any = true; break; }
      }
      if (!any) return false;
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (Array.isArray(v.$in)) {
        if (!v.$in.includes(meta[k])) return false;
        continue;
      }
      if ('$eq' in v) {
        if (meta[k] !== v.$eq) return false;
        continue;
      }
      // fallthrough — unsupported operator
      return false;
    }
    if (meta[k] !== v) return false;
  }
  return true;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function createFakeChroma() {
  const store = new Map(); // id -> { id, embedding, metadata, document }

  const collection = {
    async upsert({ ids, embeddings, metadatas, documents }) {
      for (let i = 0; i < ids.length; i++) {
        store.set(ids[i], {
          id: ids[i],
          embedding: embeddings[i],
          metadata: metadatas?.[i] || {},
          document: documents?.[i] || '',
        });
      }
    },
    async get({ ids, where, include } = {}) {
      let rows;
      if (Array.isArray(ids) && ids.length) {
        rows = ids.map((id) => store.get(id)).filter(Boolean);
      } else {
        rows = [...store.values()];
      }
      if (where) rows = rows.filter((r) => matchWhere(where, r.metadata));
      const out = { ids: rows.map((r) => r.id) };
      const wantMeta = !include || include.includes('metadatas');
      const wantDoc = !include || include.includes('documents');
      if (wantMeta) out.metadatas = rows.map((r) => r.metadata);
      if (wantDoc) out.documents = rows.map((r) => r.document);
      return out;
    },
    async delete({ ids, where } = {}) {
      if (Array.isArray(ids) && ids.length) {
        for (const id of ids) store.delete(id);
        return;
      }
      if (where) {
        const toDel = [];
        for (const [id, row] of store.entries()) {
          if (matchWhere(where, row.metadata)) toDel.push(id);
        }
        for (const id of toDel) store.delete(id);
      }
    },
    async query({ queryEmbeddings, nResults = 8, where } = {}) {
      const ids = [];
      const distances = [];
      const metadatas = [];
      const documents = [];
      for (const qv of queryEmbeddings) {
        let rows = [...store.values()];
        if (where) rows = rows.filter((r) => matchWhere(where, r.metadata));
        const scored = rows.map((r) => ({ ...r, sim: cosine(qv, r.embedding) }));
        scored.sort((a, b) => b.sim - a.sim);
        const top = scored.slice(0, nResults);
        ids.push(top.map((r) => r.id));
        distances.push(top.map((r) => 1 - r.sim));
        metadatas.push(top.map((r) => r.metadata));
        documents.push(top.map((r) => r.document));
      }
      return { ids, distances, metadatas, documents };
    },
    _store: store,
  };
  return collection;
}
