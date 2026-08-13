// Sets — reusable settings/locations linked to beats by name (beat.sets[]),
// mirroring the characters module. Fixed schema: name + description, plus the
// standard media arrays (images[]/main_image_id, attachments[], artworks[]).

import { ObjectId } from 'mongodb';
import { getDb } from './client.js';
import { logger } from '../log.js';
import { stripMarkdown } from '../util/markdown.js';
import { resolveProjectId } from './projects.js';

const col = () => getDb().collection('sets');

function maybeId(s) {
  return /^[a-f0-9]{24}$/i.test(s) ? new ObjectId(s) : null;
}

function inProject(doc, projectId) {
  return !doc.project_id || doc.project_id === projectId;
}

export async function listSets(projectId) {
  projectId = await resolveProjectId(projectId);
  const all = await col()
    .find({}, { projection: { name: 1, description: 1, main_image_id: 1, project_id: 1 } })
    .sort({ name: 1 })
    .toArray();
  return all.filter((s) => inProject(s, projectId));
}

export async function findAllSets(projectId) {
  projectId = await resolveProjectId(projectId);
  const all = await col().find({}).sort({ name: 1 }).toArray();
  return all.filter((s) => inProject(s, projectId));
}

export async function getSet(projectId, identifier) {
  projectId = await resolveProjectId(projectId);
  const c = col();
  const id = maybeId(identifier);
  if (id) {
    const byId = await c.findOne({ _id: id });
    // Locate by globally-unique id, then VERIFY project — a stale id from
    // another project's chat history must fail as not-found, not leak.
    if (byId && inProject(byId, projectId)) return byId;
    if (byId) return null;
  }
  const lc = String(identifier).toLowerCase();
  const direct = await c.findOne({ project_id: projectId, name_lower: lc });
  if (direct) return direct;
  // Tolerate markdown/whitespace drift in the stored `name_lower` the same
  // way getCharacter does: scan for a stripped-name match inside the project.
  const stripped = stripMarkdown(String(identifier)).toLowerCase();
  if (!stripped) return null;
  const all = await c.find({}).toArray();
  return (
    all.find(
      (d) => inProject(d, projectId) && stripMarkdown(d.name || '').toLowerCase() === stripped,
    ) || null
  );
}

export async function createSet({ projectId, name, description = '' }) {
  projectId = await resolveProjectId(projectId);
  const now = new Date();
  const doc = {
    project_id: projectId,
    name,
    name_lower: stripMarkdown(name).toLowerCase(),
    description: description || '',
    images: [],
    main_image_id: null,
    attachments: [],
    artworks: [],
    created_at: now,
    updated_at: now,
  };
  const res = await col().insertOne(doc);
  logger.info(`mongo: set create name=${name}`);
  return { _id: res.insertedId, ...doc };
}

export async function updateSet(projectId, identifier, patch) {
  projectId = await resolveProjectId(projectId);
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error(
      `update_set: \`patch\` must be an object like {name: "..."} or {description: "..."}, got ${
        Array.isArray(patch) ? 'array' : typeof patch
      }.`,
    );
  }
  const hasRecognized = Object.keys(patch).some((k) => k === 'name' || k === 'description');
  if (!hasRecognized) {
    throw new Error(
      `update_set: \`patch\` has no recognized fields. Expected name or description. Got keys: [${Object.keys(patch).join(', ')}].`,
    );
  }
  const existing = await getSet(projectId, identifier);
  if (!existing) throw new Error(`Set not found: ${identifier}`);
  const set = { updated_at: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'name') {
      set.name = v;
      set.name_lower = stripMarkdown(v).toLowerCase();
    } else if (k === 'description') {
      set.description = v;
    }
  }
  const result = await col().updateOne({ _id: existing._id }, { $set: set });
  if (!result || result.matchedCount === 0) {
    const msg = `updateSet: doc id=${existing._id} not found — write did not apply.`;
    logger.error(msg);
    throw new Error(msg);
  }
  logger.info(
    `mongo: set update name=${existing.name} fields=[${Object.keys(set)
      .filter((k) => k !== 'updated_at')
      .join(',')}]`,
  );
  return getSet(projectId, existing._id.toString());
}

const SEARCHABLE_FIELDS = ['name', 'description'];

export async function searchSets(projectId, query) {
  projectId = await resolveProjectId(projectId);
  const q = String(query).toLowerCase();
  const all = (await col().find({}).toArray()).filter((s) => inProject(s, projectId));
  const out = [];
  for (const s of all) {
    const matched_fields = [];
    let firstHit = null;
    for (const k of SEARCHABLE_FIELDS) {
      const v = s[k];
      if (typeof v === 'string' && v.toLowerCase().includes(q)) {
        matched_fields.push(k);
        if (firstHit === null) firstHit = v;
      }
    }
    if (matched_fields.length) {
      out.push({
        _id: s._id,
        name: s.name,
        matched_fields,
        preview: String(firstHit).slice(0, 200),
      });
    }
  }
  return out;
}

export async function deleteSet(projectId, identifier) {
  projectId = await resolveProjectId(projectId);
  const s = await getSet(projectId, identifier);
  if (!s) throw new Error(`Set not found: ${identifier}`);
  await col().deleteOne({ _id: s._id });
  logger.info(`mongo: set delete id=${s._id} name="${s.name}"`);
  // Artwork result images live in GridFS under this set — include them in
  // image_ids so the caller's byte cleanup catches them (characters predate
  // artworks and leak these; don't copy that gap).
  const artworkImageIds = (s.artworks || []).flatMap((a) =>
    [a.result_image_id, a.previous_result_image_id].filter(Boolean),
  );
  return {
    _id: s._id,
    name: s.name,
    image_ids: [
      ...(s.images || []).map((i) => i._id).filter(Boolean),
      ...artworkImageIds,
    ],
    attachment_ids: (s.attachments || []).map((a) => a._id).filter(Boolean),
  };
}

export async function pushSetImage(projectId, identifier, imageMeta, setAsMain = false) {
  projectId = await resolveProjectId(projectId);
  const s = await getSet(projectId, identifier);
  if (!s) throw new Error(`Set not found: ${identifier}`);
  const promote = !!setAsMain || !s.images || s.images.length === 0;
  await col().updateOne(
    { _id: s._id },
    {
      $push: { images: imageMeta },
      $set: {
        updated_at: new Date(),
        ...(promote ? { main_image_id: imageMeta._id } : {}),
      },
    },
  );
  logger.info(`mongo: set image push id=${s._id} image=${imageMeta._id}${promote ? ' (main)' : ''}`);
  return { set: s.name, _id: s._id, is_main: promote };
}

// Replace one image meta in the set's embedded images[] array, preserving the
// slot position and carrying main status over. Does NOT touch GridFS.
export async function replaceSetImage(projectId, identifier, oldImageId, newImageMeta) {
  projectId = await resolveProjectId(projectId);
  const s = await getSet(projectId, identifier);
  if (!s) throw new Error(`Set not found: ${identifier}`);
  const oldOid = oldImageId instanceof ObjectId ? oldImageId : new ObjectId(String(oldImageId));
  const images = s.images || [];
  const idx = images.findIndex((i) => i._id && i._id.equals(oldOid));
  if (idx < 0) throw new Error(`Image ${oldImageId} is not attached to ${s.name}`);
  const wasMain = s.main_image_id && s.main_image_id.equals(oldOid);
  const newImages = [...images];
  newImages[idx] = newImageMeta;
  await col().updateOne(
    { _id: s._id },
    {
      $set: {
        images: newImages,
        main_image_id: wasMain ? newImageMeta._id : s.main_image_id || null,
        updated_at: new Date(),
      },
    },
  );
  logger.info(
    `mongo: set image replace id=${s._id} old=${oldOid} new=${newImageMeta._id}${wasMain ? ' (main)' : ''}`,
  );
  return {
    set: s.name,
    _id: s._id,
    replaced: oldOid,
    new_image_id: newImageMeta._id,
    was_main: !!wasMain,
  };
}

// Remove an image from the embedded images[] array WITHOUT deleting the
// GridFS file (move-on-attach path; full deletion goes through files.js).
export async function pullSetImage(projectId, identifier, imageId) {
  projectId = await resolveProjectId(projectId);
  const s = await getSet(projectId, identifier);
  if (!s) throw new Error(`Set not found: ${identifier}`);
  const oid = imageId instanceof ObjectId ? imageId : new ObjectId(String(imageId));
  const images = s.images || [];
  if (!images.some((i) => i._id && i._id.equals(oid))) {
    throw new Error(`Image ${imageId} is not attached to ${s.name}`);
  }
  const remaining = images.filter((i) => !i._id.equals(oid));
  const wasMain = s.main_image_id && s.main_image_id.equals(oid);
  const newMain = wasMain ? remaining[0]?._id || null : s.main_image_id || null;
  await col().updateOne(
    { _id: s._id },
    {
      $pull: { images: { _id: oid } },
      $set: { main_image_id: newMain, updated_at: new Date() },
    },
  );
  logger.info(`mongo: set image pull id=${s._id} image=${oid}`);
  return { set: s.name, _id: s._id, removed: oid, main_image_id: newMain };
}

export async function pushSetAttachment(projectId, identifier, attachmentMeta) {
  projectId = await resolveProjectId(projectId);
  const s = await getSet(projectId, identifier);
  if (!s) throw new Error(`Set not found: ${identifier}`);
  await col().updateOne(
    { _id: s._id },
    { $push: { attachments: attachmentMeta }, $set: { updated_at: new Date() } },
  );
  logger.info(`mongo: set attachment push id=${s._id} attach=${attachmentMeta?._id || '-'}`);
  return { set: s.name, _id: s._id };
}

export async function pullSetAttachment(projectId, identifier, attachmentId) {
  projectId = await resolveProjectId(projectId);
  const s = await getSet(projectId, identifier);
  if (!s) throw new Error(`Set not found: ${identifier}`);
  const oid = attachmentId instanceof ObjectId ? attachmentId : new ObjectId(String(attachmentId));
  if (!(s.attachments || []).some((a) => a._id && a._id.equals(oid))) {
    throw new Error(`Attachment ${attachmentId} is not attached to ${s.name}`);
  }
  await col().updateOne(
    { _id: s._id },
    { $pull: { attachments: { _id: oid } }, $set: { updated_at: new Date() } },
  );
  logger.info(`mongo: set attachment pull id=${s._id} attach=${oid}`);
  return { set: s.name, _id: s._id, removed: oid };
}

export async function pushSetArtwork(projectId, identifier, artworkMeta) {
  projectId = await resolveProjectId(projectId);
  const s = await getSet(projectId, identifier);
  if (!s) throw new Error(`Set not found: ${identifier}`);
  await col().updateOne(
    { _id: s._id },
    { $push: { artworks: artworkMeta }, $set: { updated_at: new Date() } },
  );
  logger.info(`mongo: set artwork push id=${s._id} artwork=${artworkMeta?._id || '-'}`);
  return { set: s.name, _id: s._id, artwork_id: artworkMeta._id };
}

export async function replaceSetArtwork(projectId, identifier, artworkId, patch) {
  projectId = await resolveProjectId(projectId);
  const s = await getSet(projectId, identifier);
  if (!s) throw new Error(`Set not found: ${identifier}`);
  const oid = artworkId instanceof ObjectId ? artworkId : new ObjectId(String(artworkId));
  const artworks = s.artworks || [];
  const idx = artworks.findIndex((a) => a._id && a._id.equals(oid));
  if (idx < 0) throw new Error(`Artwork ${artworkId} is not attached to ${s.name}`);
  const next = { ...artworks[idx], ...patch, updated_at: new Date() };
  const newArtworks = [...artworks];
  newArtworks[idx] = next;
  await col().updateOne(
    { _id: s._id },
    { $set: { artworks: newArtworks, updated_at: new Date() } },
  );
  logger.info(`mongo: set artwork replace id=${s._id} artwork=${oid}`);
  return next;
}

export async function pullSetArtwork(projectId, identifier, artworkId) {
  projectId = await resolveProjectId(projectId);
  const s = await getSet(projectId, identifier);
  if (!s) throw new Error(`Set not found: ${identifier}`);
  const oid = artworkId instanceof ObjectId ? artworkId : new ObjectId(String(artworkId));
  const found = (s.artworks || []).find((a) => a._id && a._id.equals(oid));
  if (!found) throw new Error(`Artwork ${artworkId} is not attached to ${s.name}`);
  await col().updateOne(
    { _id: s._id },
    { $pull: { artworks: { _id: oid } }, $set: { updated_at: new Date() } },
  );
  logger.info(`mongo: set artwork pull id=${s._id} artwork=${oid}`);
  return {
    set: s.name,
    _id: s._id,
    removed: oid,
    result_image_id: found.result_image_id || null,
  };
}
