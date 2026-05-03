import { Binary } from 'mongodb';
import { getDb } from './client.js';

const COL = 'yjs_docs';

const col = () => getDb().collection(COL);

export async function fetchYjsState(documentName) {
  const doc = await col().findOne({ _id: documentName });
  if (!doc?.state) return null;
  // mongodb driver returns Binary instances; .buffer gives a Uint8Array view
  if (doc.state instanceof Binary) return doc.state.buffer;
  return new Uint8Array(doc.state);
}

export async function storeYjsState(documentName, state) {
  const bin = state instanceof Uint8Array ? new Binary(Buffer.from(state)) : new Binary(state);
  await col().updateOne(
    { _id: documentName },
    { $set: { state: bin, updated_at: new Date() } },
    { upsert: true },
  );
}
