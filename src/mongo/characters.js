import { ObjectId } from 'mongodb';
import { getDb } from './client.js';
import { logger } from '../log.js';

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
  logger.info(`mongo: character create name=${name}`);
  return { _id: res.insertedId, ...doc };
}

export async function updateCharacter(identifier, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error(
      `update_character: \`patch\` must be an object like {name: "..."} or {fields: {...}}, got ${
        Array.isArray(patch) ? 'array' : typeof patch
      }.`,
    );
  }
  const hasRecognized = Object.keys(patch).some(
    (k) =>
      k === 'name' ||
      k === 'fields' ||
      k.startsWith('fields.') ||
      k === 'plays_self' ||
      k === 'hollywood_actor' ||
      k === 'own_voice',
  );
  if (!hasRecognized) {
    throw new Error(
      `update_character: \`patch\` has no recognized fields. Expected name, fields, fields.<key>, plays_self, hollywood_actor, or own_voice. Got keys: [${Object.keys(patch).join(', ')}].`,
    );
  }
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
  const result = await col().updateOne({ _id: existing._id }, { $set: set });
  if (!result || result.matchedCount === 0) {
    const msg = `updateCharacter: doc id=${existing._id} not found — write did not apply.`;
    logger.error(msg);
    throw new Error(msg);
  }
  const fieldList = Object.keys(set).filter((k) => k !== 'updated_at');
  logger.info(
    `mongo: character update name=${existing.name} fields=[${fieldList.join(',')}]`,
  );
  return getCharacter(existing._id.toString());
}

export async function searchCharacters(query) {
  const q = String(query).toLowerCase();
  const all = await col().find({}).toArray();
  return all.filter((c) => JSON.stringify(c).toLowerCase().includes(q));
}

export async function deleteCharacter(identifier) {
  const c = await getCharacter(identifier);
  if (!c) throw new Error(`Character not found: ${identifier}`);
  await col().deleteOne({ _id: c._id });
  logger.info(`mongo: character delete id=${c._id} name="${c.name}"`);
  return {
    _id: c._id,
    name: c.name,
    image_ids: (c.images || []).map((i) => i._id).filter(Boolean),
    attachment_ids: (c.attachments || []).map((a) => a._id).filter(Boolean),
  };
}

export async function pushCharacterImage(identifier, imageMeta, setAsMain = false) {
  const c = await getCharacter(identifier);
  if (!c) throw new Error(`Character not found: ${identifier}`);
  const promote = !!setAsMain || !c.images || c.images.length === 0;
  const update = {
    $push: { images: imageMeta },
    $set: {
      updated_at: new Date(),
      ...(promote ? { main_image_id: imageMeta._id } : {}),
    },
  };
  await col().updateOne({ _id: c._id }, update);
  logger.info(
    `mongo: character image push id=${c._id} image=${imageMeta._id}${promote ? ' (main)' : ''}`,
  );
  return { character: c.name, _id: c._id, is_main: promote };
}
