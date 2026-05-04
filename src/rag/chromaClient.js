// ChromaDB client wrapper. Lazy connect, gracefully degrades to null when the
// integration is disabled or unreachable.
//
// Public surface:
//   isRagEnabled()  -> boolean (truthy when both VOYAGE_API_KEY and CHROMA_URL are set)
//   getCollection() -> Promise<Collection|null>
//   chromaHealthcheck() -> Promise<boolean>
//   resetForTests({ collection })
//
// We never let chromadb auto-embed — we precompute embeddings ourselves and
// pass them on every upsert/query. So no embedding function is registered.

import { config } from '../config.js';
import { logger } from '../log.js';

let _client = null;
let _collectionPromise = null;
let _healthLoggedFail = false;

export function isRagEnabled() {
  return !!config.voyage.apiKey;
}

async function importChroma() {
  try {
    return await import('chromadb');
  } catch (e) {
    logger.warn(`chroma: chromadb package not installed: ${e.message}`);
    return null;
  }
}

async function connect() {
  if (_client) return _client;
  if (!isRagEnabled()) return null;
  const mod = await importChroma();
  if (!mod) return null;
  const ChromaClient = mod.ChromaClient || mod.default?.ChromaClient;
  if (!ChromaClient) {
    logger.warn('chroma: ChromaClient export not found');
    return null;
  }
  _client = new ChromaClient({ path: config.chroma.url });
  return _client;
}

export async function getCollection() {
  if (!isRagEnabled()) return null;
  if (_collectionPromise) return _collectionPromise;
  _collectionPromise = (async () => {
    const client = await connect();
    if (!client) return null;
    try {
      const col = await client.getOrCreateCollection({
        name: config.chroma.collection,
        metadata: { 'hnsw:space': 'cosine' },
      });
      return col;
    } catch (e) {
      if (!_healthLoggedFail) {
        logger.warn(`chroma: getOrCreateCollection failed: ${e.message}`);
        _healthLoggedFail = true;
      }
      _collectionPromise = null;
      return null;
    }
  })();
  return _collectionPromise;
}

export async function chromaHealthcheck() {
  const client = await connect();
  if (!client) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const ok = await client.heartbeat();
    clearTimeout(t);
    return !!ok;
  } catch {
    return false;
  }
}

// Test hook — lets unit tests inject a fake collection.
export function resetForTests({ collection } = {}) {
  if (collection !== undefined) {
    _collectionPromise = Promise.resolve(collection);
  } else {
    _client = null;
    _collectionPromise = null;
    _healthLoggedFail = false;
  }
}
