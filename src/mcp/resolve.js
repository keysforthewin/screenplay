// resolve.js
//
// Turning what an MCP caller names (a project title, a beat number, a scene
// or cut id) into verified docs. The data helpers underneath trust their
// caller — getPlot creates a plot for any well-formed project id, and the
// beat-addressed listers do not check the project — so every lookup here
// fails loudly instead.

import { ObjectId } from 'mongodb';
import { getDb } from '../mongo/client.js';
import { findImageFile } from '../mongo/images.js';
import { getBeat } from '../mongo/plots.js';
import { getDefaultProject, getProjectById, getProjectByTitle, listProjects } from '../mongo/projects.js';
import { MAX_REFERENCE_IMAGES, getVideoPrompt } from '../mongo/videoPrompts.js';
import { getVideoScene } from '../mongo/videoScenes.js';
import { isOidHex, isValidCutDuration, MAX_CUT_SECONDS } from '../web/cutValidation.js';

// A mistake in what the caller sent; its message goes back as the tool error.
export class McpInputError extends Error {}

export async function resolveProject(ref) {
  const name = ref == null ? '' : String(ref).trim();
  if (!name) return getDefaultProject();
  const project = (isOidHex(name) ? await getProjectById(name) : null) || (await getProjectByTitle(name));
  if (project) return project;
  const titles = (await listProjects()).map((p) => `"${p.title}"`).join(', ');
  throw new McpInputError(`Unknown project "${name}". Projects: ${titles || '(none)'}`);
}

// → { project, projectId, beat }. `beat` is an order number, an id or a name.
export async function resolveBeat(projectRef, beatRef) {
  const project = await resolveProject(projectRef);
  const projectId = project._id.toString();
  const ref = beatRef == null ? '' : String(beatRef).trim();
  if (!ref) throw new McpInputError('beat is required (its number, id or name)');
  const beat = await getBeat(projectId, ref);
  if (!beat) throw new McpInputError(`Beat "${ref}" not found in project "${project.title}" — call list_beats`);
  return { project, projectId, beat };
}

// Scene and cut ids are unique across projects, so id-addressed tools take no
// project: the row itself says which one it belongs to.
async function owningProjectId(collection, id, what) {
  if (!isOidHex(String(id || ''))) throw new McpInputError(`${what}_id must be a 24-character id`);
  const doc = await getDb().collection(collection).findOne({ _id: new ObjectId(String(id)) });
  if (!doc?.project_id) throw new McpInputError(`${what} ${id} not found`);
  return doc.project_id;
}

export async function resolveScene(sceneId) {
  const projectId = await owningProjectId('video_scenes', sceneId, 'scene');
  const scene = await getVideoScene(projectId, String(sceneId));
  if (!scene) throw new McpInputError(`scene ${sceneId} not found`);
  return { projectId, scene };
}

export async function resolveCut(cutId) {
  const projectId = await owningProjectId('video_prompts', cutId, 'cut');
  const cut = await getVideoPrompt(projectId, String(cutId));
  if (!cut) throw new McpInputError(`cut ${cutId} not found`);
  return { projectId, cut };
}

export function checkDuration(raw) {
  if (!isValidCutDuration(raw)) {
    throw new McpInputError(`duration_seconds must be more than 0 and at most ${MAX_CUT_SECONDS} (or null to clear it)`);
  }
  return raw === '' ? null : raw;
}

// A frame's reference list: existing images of this project, deduped, in the
// order given.
export async function checkReferenceIds(projectId, raw) {
  const ids = [...new Set((Array.isArray(raw) ? raw : []).map(String))];
  if (ids.length > MAX_REFERENCE_IMAGES) {
    throw new McpInputError(`a frame takes at most ${MAX_REFERENCE_IMAGES} reference images`);
  }
  for (const id of ids) {
    await requireProjectImage(projectId, id);
  }
  return ids;
}

// The GridFS file doc of an image that belongs to this project (rows from
// before projects existed carry no stamp and belong to all of them).
export async function requireProjectImage(projectId, imageId) {
  if (!isOidHex(String(imageId || ''))) throw new McpInputError(`"${imageId}" is not an image id`);
  const file = await findImageFile(String(imageId));
  if (!file) throw new McpInputError(`image ${imageId} not found`);
  const owner = file.metadata?.project_id;
  if (owner && owner !== projectId) throw new McpInputError(`image ${imageId} belongs to another project`);
  return file;
}
