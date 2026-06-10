import { ObjectId } from 'mongodb';
import { getDb } from './client.js';
import { logger } from '../log.js';
import { stripMarkdown } from '../util/markdown.js';
import { resolveProjectId } from './projects.js';

const col = () => getDb().collection('characters');

function maybeId(s) {
  return /^[a-f0-9]{24}$/i.test(s) ? new ObjectId(s) : null;
}

function inProject(doc, projectId) {
  return !doc.project_id || doc.project_id === projectId;
}

export async function listCharacters(projectId) {
  projectId = await resolveProjectId(projectId);
  const all = await col()
    .find({}, { projection: { name: 1, hollywood_actor: 1, main_image_id: 1, project_id: 1 } })
    .sort({ name: 1 })
    .toArray();
  return all.filter((c) => inProject(c, projectId));
}

export async function findAllCharacters(projectId) {
  projectId = await resolveProjectId(projectId);
  const all = await col().find({}).sort({ name: 1 }).toArray();
  return all.filter((c) => inProject(c, projectId));
}

// Synthesize `character_sheet_image_ids: ObjectId[]` on legacy docs that only
// have the scalar `character_sheet_image_id`. In-memory only — the next
// successful write through the multi-sheet helpers persists the array form
// and unsets the scalar.
function backfillSheetIds(doc) {
  if (!doc) return doc;
  if (Array.isArray(doc.character_sheet_image_ids)) return doc;
  doc.character_sheet_image_ids = doc.character_sheet_image_id ? [doc.character_sheet_image_id] : [];
  return doc;
}

export async function getCharacter(projectId, identifier) {
  projectId = await resolveProjectId(projectId);
  const c = col();
  const id = maybeId(identifier);
  if (id) {
    const byId = await c.findOne({ _id: id });
    // Locate by globally-unique id, then VERIFY project — a stale id from
    // another project's chat history must fail as not-found, not leak.
    if (byId && inProject(byId, projectId)) return backfillSheetIds(byId);
    if (byId) return null;
  }
  const lc = String(identifier).toLowerCase();
  const direct = await c.findOne({ project_id: projectId, name_lower: lc });
  if (direct) return backfillSheetIds(direct);
  const legacy = await c.findOne({ name_lower: lc, project_id: { $exists: false } });
  if (legacy) return backfillSheetIds(legacy);
  // Tolerate markdown/whitespace drift in the stored `name_lower`: legacy
  // createCharacter wrote raw `name.toLowerCase()` (preserving newlines and
  // markdown chars), but URLs and most callers use the stripped plain text.
  // If the direct lookup misses, scan for a record whose `stripMarkdown(name)`
  // matches the stripped identifier — but stay inside the project.
  const stripped = stripMarkdown(String(identifier)).toLowerCase();
  if (!stripped) return null;
  const all = await c.find({}).toArray();
  const match = all.find(
    (d) => inProject(d, projectId) && stripMarkdown(d.name || '').toLowerCase() === stripped,
  );
  return match ? backfillSheetIds(match) : null;
}

export async function createCharacter({ projectId, name, hollywood_actor, fields = {} }) {
  projectId = await resolveProjectId(projectId);
  const now = new Date();
  const doc = {
    project_id: projectId,
    name,
    name_lower: stripMarkdown(name).toLowerCase(),
    hollywood_actor: hollywood_actor || null,
    fields,
    created_at: now,
    updated_at: now,
  };
  const res = await col().insertOne(doc);
  logger.info(`mongo: character create name=${name}`);
  return { _id: res.insertedId, ...doc };
}

export async function updateCharacter(projectId, identifier, patch) {
  projectId = await resolveProjectId(projectId);
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
      k === 'hollywood_actor' ||
      k === 'character_sheet_image_id' ||
      k === 'fal_character_id' ||
      k === 'fal_character_image_hash' ||
      k === 'unset',
  );
  if (!hasRecognized) {
    throw new Error(
      `update_character: \`patch\` has no recognized fields. Expected name, fields, fields.<key>, hollywood_actor, character_sheet_image_id, fal_character_id, fal_character_image_hash, or unset. Got keys: [${Object.keys(patch).join(', ')}].`,
    );
  }
  const existing = await getCharacter(projectId, identifier);
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
    } else if (k === 'character_sheet_image_id') {
      // Allow null (clear) or an ObjectId / 24-hex string.
      if (v === null) {
        set.character_sheet_image_id = null;
      } else if (v instanceof ObjectId) {
        set.character_sheet_image_id = v;
      } else if (typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v)) {
        set.character_sheet_image_id = new ObjectId(v);
      } else {
        throw new Error(
          `update_character: character_sheet_image_id must be null or a 24-hex string, got ${typeof v}.`,
        );
      }
    } else if (k === 'hollywood_actor') {
      set[k] = v;
    } else if (k === 'fal_character_id') {
      if (v !== null && (typeof v !== 'string' || !v.trim())) {
        throw new Error(
          `update_character: fal_character_id must be null or a non-empty string, got ${typeof v}.`,
        );
      }
      set.fal_character_id = v === null ? null : v;
    } else if (k === 'fal_character_image_hash') {
      if (v !== null && (typeof v !== 'string' || !v.trim())) {
        throw new Error(
          `update_character: fal_character_image_hash must be null or a non-empty string, got ${typeof v}.`,
        );
      }
      set.fal_character_image_hash = v === null ? null : v;
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
  return getCharacter(projectId, existing._id.toString());
}

const SEARCHABLE_CORE_FIELDS = ['name', 'hollywood_actor'];

export async function searchCharacters(projectId, query) {
  projectId = await resolveProjectId(projectId);
  const q = String(query).toLowerCase();
  const all = (await col().find({}).toArray()).filter((c) => inProject(c, projectId));
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

export async function deleteCharacter(projectId, identifier) {
  projectId = await resolveProjectId(projectId);
  const c = await getCharacter(projectId, identifier);
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

export async function pushCharacterImage(projectId, identifier, imageMeta, setAsMain = false) {
  projectId = await resolveProjectId(projectId);
  const c = await getCharacter(projectId, identifier);
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

// Replace one image meta in the character's embedded images[] array,
// preserving the slot position. If the replaced image was the main image,
// the new image becomes the main image. Throws if the old image isn't
// attached. Does NOT touch GridFS — the caller is responsible for deleting
// the old bytes.
export async function replaceCharacterImage(projectId, identifier, oldImageId, newImageMeta) {
  projectId = await resolveProjectId(projectId);
  const c = await getCharacter(projectId, identifier);
  if (!c) throw new Error(`Character not found: ${identifier}`);
  const oldOid = oldImageId instanceof ObjectId ? oldImageId : new ObjectId(String(oldImageId));
  const images = c.images || [];
  const idx = images.findIndex((i) => i._id && i._id.equals(oldOid));
  if (idx < 0) throw new Error(`Image ${oldImageId} is not attached to ${c.name}`);
  const wasMain = c.main_image_id && c.main_image_id.equals(oldOid);
  const newImages = [...images];
  newImages[idx] = newImageMeta;
  const newMain = wasMain ? newImageMeta._id : c.main_image_id || null;
  await col().updateOne(
    { _id: c._id },
    {
      $set: {
        images: newImages,
        main_image_id: newMain,
        updated_at: new Date(),
      },
    },
  );
  logger.info(
    `mongo: character image replace id=${c._id} old=${oldOid} new=${newImageMeta._id}${wasMain ? ' (main)' : ''}`,
  );
  return {
    character: c.name,
    _id: c._id,
    replaced: oldOid,
    new_image_id: newImageMeta._id,
    was_main: !!wasMain,
  };
}

// Remove an image from a character's embedded images[] array WITHOUT deleting
// the GridFS file. Used by the move-on-attach path; callers that want full
// deletion should use Files.removeCharacterImage instead.
export async function pullCharacterImage(projectId, identifier, imageId) {
  projectId = await resolveProjectId(projectId);
  const c = await getCharacter(projectId, identifier);
  if (!c) throw new Error(`Character not found: ${identifier}`);
  const oid = imageId instanceof ObjectId ? imageId : new ObjectId(String(imageId));
  const images = c.images || [];
  if (!images.some((i) => i._id && i._id.equals(oid))) {
    throw new Error(`Image ${imageId} is not attached to ${c.name}`);
  }
  const remaining = images.filter((i) => !i._id.equals(oid));
  const wasMain = c.main_image_id && c.main_image_id.equals(oid);
  const newMain = wasMain ? remaining[0]?._id || null : c.main_image_id || null;
  await col().updateOne(
    { _id: c._id },
    {
      $pull: { images: { _id: oid } },
      $set: { main_image_id: newMain, updated_at: new Date() },
    },
  );
  logger.info(`mongo: character image pull id=${c._id} image=${oid}`);
  return { character: c.name, _id: c._id, removed: oid, main_image_id: newMain };
}

export async function pushCharacterAttachment(projectId, identifier, attachmentMeta) {
  projectId = await resolveProjectId(projectId);
  const c = await getCharacter(projectId, identifier);
  if (!c) throw new Error(`Character not found: ${identifier}`);
  await col().updateOne(
    { _id: c._id },
    {
      $push: { attachments: attachmentMeta },
      $set: { updated_at: new Date() },
    },
  );
  logger.info(
    `mongo: character attachment push id=${c._id} attach=${attachmentMeta?._id || '-'}`,
  );
  return { character: c.name, _id: c._id };
}

// ── Artwork entity helpers ─────────────────────────────────────────────────
// An "artwork" is a generated image bundled with the prompt and reference
// images that produced it, so the user can come back, tweak either, and
// regenerate. Each artwork's result image lives in GridFS (owner_type=
// 'character', owner_id=this character) and is referenced by result_image_id.
// References come from this character's images[] array.

export async function pushCharacterArtwork(projectId, identifier, artworkMeta) {
  projectId = await resolveProjectId(projectId);
  const c = await getCharacter(projectId, identifier);
  if (!c) throw new Error(`Character not found: ${identifier}`);
  await col().updateOne(
    { _id: c._id },
    {
      $push: { artworks: artworkMeta },
      $set: { updated_at: new Date() },
    },
  );
  logger.info(
    `mongo: character artwork push id=${c._id} artwork=${artworkMeta?._id || '-'}`,
  );
  return { character: c.name, _id: c._id, artwork_id: artworkMeta._id };
}

export async function replaceCharacterArtwork(projectId, identifier, artworkId, patch) {
  projectId = await resolveProjectId(projectId);
  const c = await getCharacter(projectId, identifier);
  if (!c) throw new Error(`Character not found: ${identifier}`);
  const oid = artworkId instanceof ObjectId ? artworkId : new ObjectId(String(artworkId));
  const artworks = c.artworks || [];
  const idx = artworks.findIndex((a) => a._id && a._id.equals(oid));
  if (idx < 0) throw new Error(`Artwork ${artworkId} is not attached to ${c.name}`);
  const next = { ...artworks[idx], ...patch, updated_at: new Date() };
  const newArtworks = [...artworks];
  newArtworks[idx] = next;
  await col().updateOne(
    { _id: c._id },
    {
      $set: {
        artworks: newArtworks,
        updated_at: new Date(),
      },
    },
  );
  logger.info(`mongo: character artwork replace id=${c._id} artwork=${oid}`);
  return next;
}

export async function pullCharacterArtwork(projectId, identifier, artworkId) {
  projectId = await resolveProjectId(projectId);
  const c = await getCharacter(projectId, identifier);
  if (!c) throw new Error(`Character not found: ${identifier}`);
  const oid = artworkId instanceof ObjectId ? artworkId : new ObjectId(String(artworkId));
  const artworks = c.artworks || [];
  const found = artworks.find((a) => a._id && a._id.equals(oid));
  if (!found) throw new Error(`Artwork ${artworkId} is not attached to ${c.name}`);
  await col().updateOne(
    { _id: c._id },
    {
      $pull: { artworks: { _id: oid } },
      $set: { updated_at: new Date() },
    },
  );
  logger.info(`mongo: character artwork pull id=${c._id} artwork=${oid}`);
  return {
    character: c.name,
    _id: c._id,
    removed: oid,
    result_image_id: found.result_image_id || null,
  };
}

// Remove an attachment from a character's embedded attachments[] array WITHOUT
// deleting the GridFS file. Used by the move-on-attach path AND by the SPA's
// delete button (which expects the GridFS bytes to be cleaned up by the
// gateway wrapper).
export async function pullCharacterAttachment(projectId, identifier, attachmentId) {
  projectId = await resolveProjectId(projectId);
  const c = await getCharacter(projectId, identifier);
  if (!c) throw new Error(`Character not found: ${identifier}`);
  const oid = attachmentId instanceof ObjectId ? attachmentId : new ObjectId(String(attachmentId));
  const attachments = c.attachments || [];
  if (!attachments.some((a) => a._id && a._id.equals(oid))) {
    throw new Error(`Attachment ${attachmentId} is not attached to ${c.name}`);
  }
  await col().updateOne(
    { _id: c._id },
    {
      $pull: { attachments: { _id: oid } },
      $set: { updated_at: new Date() },
    },
  );
  logger.info(`mongo: character attachment pull id=${c._id} attach=${oid}`);
  return { character: c.name, _id: c._id, removed: oid };
}
