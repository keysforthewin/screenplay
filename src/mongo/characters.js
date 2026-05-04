import { ObjectId } from 'mongodb';
import { getDb } from './client.js';
import { logger } from '../log.js';
import { stripMarkdown } from '../util/markdown.js';

const col = () => getDb().collection('characters');

function maybeId(s) {
  return /^[a-f0-9]{24}$/i.test(s) ? new ObjectId(s) : null;
}

export async function listCharacters() {
  return col()
    .find({}, { projection: { name: 1, plays_self: 1, hollywood_actor: 1 } })
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
  const lc = String(identifier).toLowerCase();
  const direct = await c.findOne({ name_lower: lc });
  if (direct) return direct;
  // Tolerate markdown/whitespace drift in the stored `name_lower`: legacy
  // createCharacter wrote raw `name.toLowerCase()` (preserving newlines and
  // markdown chars), but URLs and most callers use the stripped plain text.
  // If the direct lookup misses, scan for a record whose `stripMarkdown(name)`
  // matches the stripped identifier.
  const stripped = stripMarkdown(String(identifier)).toLowerCase();
  if (!stripped) return null;
  const all = await c.find({}).toArray();
  return all.find((d) => stripMarkdown(d.name || '').toLowerCase() === stripped) || null;
}

export async function createCharacter({ name, plays_self, hollywood_actor, own_voice, fields = {} }) {
  const now = new Date();
  const doc = {
    name,
    name_lower: stripMarkdown(name).toLowerCase(),
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
      k === 'own_voice' ||
      k === 'unset',
  );
  if (!hasRecognized) {
    throw new Error(
      `update_character: \`patch\` has no recognized fields. Expected name, fields, fields.<key>, plays_self, hollywood_actor, own_voice, or unset. Got keys: [${Object.keys(patch).join(', ')}].`,
    );
  }
  const existing = await getCharacter(identifier);
  if (!existing) throw new Error(`Character not found: ${identifier}`);
  const set = { updated_at: new Date() };
  const unset = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'name') {
      set.name = v;
      set.name_lower = stripMarkdown(v).toLowerCase();
    } else if (k === 'fields' && v && typeof v === 'object') {
      for (const [fk, fv] of Object.entries(v)) set[`fields.${fk}`] = fv;
    } else if (k.startsWith('fields.')) {
      set[k] = v;
    } else if (['plays_self', 'hollywood_actor', 'own_voice'].includes(k)) {
      set[k] = v;
    } else if (k === 'unset') {
      if (!Array.isArray(v)) {
        throw new Error(
          `update_character: \`unset\` must be an array of custom field name strings.`,
        );
      }
      for (const fieldName of v) {
        if (typeof fieldName !== 'string' || !fieldName.trim()) {
          throw new Error(
            `update_character: \`unset\` entries must be non-empty strings; got ${JSON.stringify(fieldName)}.`,
          );
        }
        unset[`fields.${fieldName}`] = '';
      }
    }
  }
  const setFieldNames = Object.keys(set).filter((k) => k !== 'updated_at');
  const unsetFieldNames = Object.keys(unset);
  if (setFieldNames.length === 0 && unsetFieldNames.length === 0) {
    throw new Error(
      `update_character: \`patch\` produced no field changes.`,
    );
  }
  const update = { $set: set };
  if (unsetFieldNames.length > 0) update.$unset = unset;
  const result = await col().updateOne({ _id: existing._id }, update);
  if (!result || result.matchedCount === 0) {
    const msg = `updateCharacter: doc id=${existing._id} not found — write did not apply.`;
    logger.error(msg);
    throw new Error(msg);
  }
  const fieldList = [...setFieldNames, ...unsetFieldNames.map((k) => `-${k}`)];
  logger.info(
    `mongo: character update name=${existing.name} fields=[${fieldList.join(',')}]`,
  );
  return getCharacter(existing._id.toString());
}

const SEARCHABLE_CORE_FIELDS = ['name', 'hollywood_actor'];

export async function searchCharacters(query) {
  const q = String(query).toLowerCase();
  const all = await col().find({}).toArray();
  const out = [];
  for (const c of all) {
    const matched_fields = [];
    let firstHit = null;
    for (const k of SEARCHABLE_CORE_FIELDS) {
      const v = c[k];
      if (typeof v === 'string' && v.toLowerCase().includes(q)) {
        matched_fields.push(k);
        if (firstHit === null) firstHit = v;
      }
    }
    for (const [k, v] of Object.entries(c.fields || {})) {
      const s = Array.isArray(v) ? v.join(', ') : v;
      if (typeof s === 'string' && s.toLowerCase().includes(q)) {
        matched_fields.push(`fields.${k}`);
        if (firstHit === null) firstHit = s;
      }
    }
    if (matched_fields.length) {
      out.push({
        _id: c._id,
        name: c.name,
        matched_fields,
        preview: String(firstHit).slice(0, 200),
      });
    }
  }
  return out;
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
