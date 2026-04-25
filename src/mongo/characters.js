import { ObjectId } from 'mongodb';
import { getDb } from './client.js';

const col = () => getDb().collection('characters');

function maybeId(s) {
  return /^[a-f0-9]{24}$/i.test(s) ? new ObjectId(s) : null;
}

export async function listCharacters() {
  return col()
    .find({}, { projection: { name: 1 } })
    .sort({ name: 1 })
    .toArray();
}

export async function findAllCharacters() {
  return col().find({}).sort({ name: 1 }).toArray();
}

export async function getCharacter(identifier) {
  const c = col();
  const id = maybeId(identifier);
  if (id) {
    const byId = await c.findOne({ _id: id });
    if (byId) return byId;
  }
  return c.findOne({ name_lower: String(identifier).toLowerCase() });
}

export async function createCharacter({ name, plays_self, hollywood_actor, own_voice, fields = {} }) {
  const now = new Date();
  const doc = {
    name,
    name_lower: name.toLowerCase(),
    plays_self: !!plays_self,
    hollywood_actor: hollywood_actor || null,
    own_voice: !!own_voice,
    fields,
    created_at: now,
    updated_at: now,
  };
  const res = await col().insertOne(doc);
  return { _id: res.insertedId, ...doc };
}

export async function updateCharacter(identifier, patch) {
  const existing = await getCharacter(identifier);
  if (!existing) throw new Error(`Character not found: ${identifier}`);
  const set = { updated_at: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'name') {
      set.name = v;
      set.name_lower = v.toLowerCase();
    } else if (k === 'fields' && v && typeof v === 'object') {
      for (const [fk, fv] of Object.entries(v)) set[`fields.${fk}`] = fv;
    } else if (k.startsWith('fields.')) {
      set[k] = v;
    } else if (['plays_self', 'hollywood_actor', 'own_voice'].includes(k)) {
      set[k] = v;
    }
  }
  await col().updateOne({ _id: existing._id }, { $set: set });
  return getCharacter(existing._id.toString());
}

export async function searchCharacters(query) {
  const q = String(query).toLowerCase();
  const all = await col().find({}).toArray();
  return all.filter((c) => JSON.stringify(c).toLowerCase().includes(q));
}
