// store.js
//
// What the MCP tools (tools.js) and the upload endpoint (server.js) do to the
// Scenes tab. Every write goes through the mutation gateway, so open pages
// update live exactly as they do for an edit made in the browser.

import { logger } from '../log.js';
import { deleteAttachment, uploadAttachmentBuffer, uploadAttachmentFromUrl } from '../mongo/attachments.js';
import { fetchImageFromUrl } from '../mongo/imageBytes.js';
import { readImageBuffer } from '../mongo/images.js';
import { getVideoPrompt, listVideoPrompts } from '../mongo/videoPrompts.js';
import { getVideoScene, listVideoScenes } from '../mongo/videoScenes.js';
import {
  activeCutFrameJob,
  clearCutFrame,
  repointStartFrameReference,
  storeCutFrameImage,
} from '../web/cutFrames.js';
import { MAX_SCENE_TITLE } from '../web/cutValidation.js';
import {
  createVideoPromptViaGateway,
  createVideoSceneViaGateway,
  cutFrameKey,
  reorderCutsInSceneViaGateway,
  reorderVideoScenesViaGateway,
  setEntityFieldMarkdown,
  setVideoPromptDurationViaGateway,
  setVideoPromptStartFrameViaGateway,
  setVideoPromptTextFieldViaGateway,
  setVideoPromptVideoViaGateway,
  undoVideoPromptStartFrameViaGateway,
} from '../web/gateway.js';
import { McpInputError, checkDuration, checkReferenceIds, requireProjectImage } from './resolve.js';
import { serializeCut, serializeScene } from './serialize.js';

const CUT_TEXT_FIELDS = ['title', 'prompt', 'start_frame_prompt', 'end_frame_prompt'];
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
const text = (v) => (v == null ? '' : String(v));

export function frameName(raw) {
  const f = String(raw || '').toLowerCase().replace(/[_-]?frame$/, '');
  if (f === 'start' || f === 'end') return f;
  throw new McpInputError('frame must be "start" or "end"');
}

// A beat's scenes with their cuts, in order.
export async function beatTree(projectId, beat) {
  const beatId = String(beat._id);
  const [scenes, cuts] = await Promise.all([
    listVideoScenes({ projectId, beatId }),
    listVideoPrompts({ projectId, beatId }),
  ]);
  return scenes.map((s) => serializeScene(s, cuts.filter((c) => String(c.scene_id) === String(s._id))));
}

// Move one id to a 1-based position in its list.
function moved(ids, id, position) {
  const rest = ids.filter((x) => x !== id);
  const at = Math.min(Math.max(Math.round(Number(position)) || 1, 1), rest.length + 1);
  rest.splice(at - 1, 0, id);
  return rest;
}

async function placeScene(projectId, scene, position) {
  const ids = (await listVideoScenes({ projectId, beatId: String(scene.beat_id) })).map((s) => String(s._id));
  const next = moved(ids, String(scene._id), position);
  if (next.join() !== ids.join()) {
    await reorderVideoScenesViaGateway({ projectId, beatId: String(scene.beat_id), orderedIds: next });
  }
}

async function placeCut(projectId, cut, position) {
  const ids = (await listVideoPrompts({ projectId, sceneId: String(cut.scene_id) })).map((c) => String(c._id));
  const next = moved(ids, String(cut._id), position);
  if (next.join() !== ids.join()) {
    await reorderCutsInSceneViaGateway({ projectId, sceneId: String(cut.scene_id), orderedIds: next });
  }
}

// Everything about a cut spec that can be wrong, checked before any write.
async function checkCutSpec(projectId, spec) {
  const out = {};
  if (has(spec, 'duration_seconds')) out.duration = checkDuration(spec.duration_seconds);
  for (const frame of ['start', 'end']) {
    const key = `${frame}_frame_reference_ids`;
    if (has(spec, key)) out[frame] = await checkReferenceIds(projectId, spec[key]);
  }
  return out;
}

async function setReferences(projectId, cutId, frame, ids) {
  const cut = await getVideoPrompt(projectId, cutId);
  return setVideoPromptStartFrameViaGateway({
    projectId,
    promptId: cutId,
    frame,
    startFrame: { ...(cut?.[cutFrameKey(frame)] || {}), prompt: undefined, reference_ids: ids },
  });
}

async function readCut(projectId, cutId, texts = {}) {
  const cut = await getVideoPrompt(projectId, cutId);
  const scene = cut ? await getVideoScene(projectId, String(cut.scene_id)) : null;
  return serializeCut(cut, scene, texts);
}

export async function createScene({ projectId, beat, title = '', position = null, cuts = [] }) {
  const checked = [];
  for (const spec of cuts) checked.push(await checkCutSpec(projectId, spec));
  const scene = await createVideoSceneViaGateway({
    projectId,
    beatId: String(beat._id),
    title: text(title).slice(0, MAX_SCENE_TITLE),
  });
  for (let i = 0; i < cuts.length; i += 1) {
    await insertCut(projectId, scene, cuts[i], checked[i]);
  }
  if (position != null) await placeScene(projectId, scene, position);
  const fresh = (await getVideoScene(projectId, String(scene._id))) || scene;
  return serializeScene(fresh, await listVideoPrompts({ projectId, sceneId: String(scene._id) }), scene.title);
}

async function insertCut(projectId, scene, spec, checked) {
  const cut = await createVideoPromptViaGateway({
    projectId,
    sceneId: String(scene._id),
    title: text(spec.title),
    prompt: text(spec.prompt),
    durationSeconds: checked.duration ?? null,
    startFramePrompt: text(spec.start_frame_prompt),
    endFramePrompt: text(spec.end_frame_prompt),
  });
  const id = String(cut._id);
  for (const frame of ['start', 'end']) {
    if (checked[frame]?.length) await setReferences(projectId, id, frame, checked[frame]);
  }
  return cut;
}

export async function createCut({ projectId, scene, spec }) {
  const checked = await checkCutSpec(projectId, spec);
  const cut = await insertCut(projectId, scene, spec, checked);
  if (spec.position != null) await placeCut(projectId, cut, spec.position);
  return readCut(projectId, String(cut._id));
}

export async function updateScene({ projectId, scene, title, position }) {
  let written = null;
  if (title !== undefined) {
    written = text(title).slice(0, MAX_SCENE_TITLE);
    await setEntityFieldMarkdown({
      projectId,
      entityType: 'video_prompts',
      entityId: String(scene.beat_id),
      field: `scene:${scene._id}:title`,
      markdown: written,
    });
  }
  if (position != null) await placeScene(projectId, scene, position);
  const fresh = (await getVideoScene(projectId, String(scene._id))) || scene;
  return serializeScene(fresh, null, written);
}

// Scalars (length, reference lists) first, text last: a frame write carries
// the frame's stored prompt along, and must not run while a new prompt is on
// its way from the shared document to Mongo.
export async function updateCut({ projectId, cut, patch }) {
  const checked = await checkCutSpec(projectId, patch);
  const id = String(cut._id);
  if (has(patch, 'duration_seconds')) {
    await setVideoPromptDurationViaGateway({ projectId, promptId: id, durationSeconds: checked.duration });
  }
  for (const frame of ['start', 'end']) {
    if (checked[frame]) await setReferences(projectId, id, frame, checked[frame]);
  }
  if (patch.position != null) await placeCut(projectId, cut, patch.position);
  const texts = {};
  for (const field of CUT_TEXT_FIELDS) {
    if (!has(patch, field)) continue;
    texts[field] = text(patch[field]);
    await setVideoPromptTextFieldViaGateway({ projectId, promptId: id, field, text: texts[field] });
  }
  return readCut(projectId, id, texts);
}

// ─── Frames ─────────────────────────────────────────────────────────────────

function refuseWhileRendering(cut, frame) {
  if (activeCutFrameJob(cut._id, frame)) {
    throw new McpInputError(`This cut's ${frame} frame is being rendered from the Scenes tab right now — try again when it is done.`);
  }
}

export async function setFrameImage({ projectId, cut, frame, buffer, contentType = null, model = null }) {
  refuseWhileRendering(cut, frame);
  await storeCutFrameImage({ projectId, cut, frame, buffer, contentType, model: model ? String(model).slice(0, 200) : null });
  return readCut(projectId, String(cut._id));
}

// From a URL, or a copy of an image already in the project (the frame owns
// its picture and deletes it when replaced, so it never shares one).
export async function setFrameImageFrom({ projectId, cut, frame, imageUrl = null, imageId = null, model = null }) {
  if (!!imageUrl === !!imageId) throw new McpInputError('give exactly one of image_url and image_id');
  let buffer;
  let contentType;
  if (imageUrl) {
    ({ buffer, contentType } = await fetchImageFromUrl(String(imageUrl)));
  } else {
    await requireProjectImage(projectId, imageId);
    const read = await readImageBuffer(String(imageId));
    if (!read) throw new McpInputError(`image ${imageId} not found`);
    buffer = read.buffer;
    contentType = read.file.contentType || null;
  }
  return setFrameImage({ projectId, cut, frame, buffer, contentType, model });
}

export async function clearFrameImage({ projectId, cut, frame }) {
  refuseWhileRendering(cut, frame);
  await clearCutFrame({ projectId, cut, frame });
  return readCut(projectId, String(cut._id));
}

export async function undoFrameImage({ projectId, cut, frame }) {
  refuseWhileRendering(cut, frame);
  if (!cut[cutFrameKey(frame)]?.previous_image_id) throw new McpInputError(`This ${frame} frame has no earlier image to go back to.`);
  const updated = await undoVideoPromptStartFrameViaGateway({ projectId, promptId: String(cut._id), frame });
  if (frame === 'start') await repointStartFrameReference({ projectId, cut: updated, from: cut.start_frame.image_id });
  return readCut(projectId, String(cut._id));
}

// ─── Video ──────────────────────────────────────────────────────────────────

function sniffVideoType(buffer) {
  if (buffer.length > 12 && buffer.toString('latin1', 4, 8) === 'ftyp') {
    return buffer.toString('latin1', 8, 10) === 'qt' ? 'video/quicktime' : 'video/mp4';
  }
  if (buffer.length > 4 && buffer.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm';
  return null;
}

async function attachVideo({ projectId, cut, file, durationSeconds, model }) {
  const old = cut.video_file_id ? String(cut.video_file_id) : null;
  const label = model ? String(model).slice(0, 200) : 'Uploaded clip';
  await setVideoPromptVideoViaGateway({
    projectId,
    promptId: String(cut._id),
    videoFileId: file._id,
    durationSeconds: Number(durationSeconds) > 0 ? Number(durationSeconds) : null,
    modelId: label,
    modelLabel: label,
  });
  if (old && old !== String(file._id)) {
    try {
      await deleteAttachment(old);
    } catch (e) {
      logger.warn(`mcp: delete replaced clip ${old} failed: ${e?.message || e}`);
    }
  }
  return readCut(projectId, String(cut._id));
}

export async function setCutVideo({ projectId, cut, buffer, contentType = null, durationSeconds = null, model = null }) {
  const sniffed = sniffVideoType(buffer);
  const declared = /^video\//i.test(contentType || '') ? contentType : null;
  if (!sniffed && !declared) throw new McpInputError('That does not look like a video file (mp4, mov or webm).');
  const type = sniffed || declared;
  const ext = type === 'video/webm' ? 'webm' : type === 'video/quicktime' ? 'mov' : 'mp4';
  const file = await uploadAttachmentBuffer(projectId, {
    buffer,
    filename: `cut-${cut._id}-video-${Date.now()}.${ext}`,
    contentType: type,
    ownerType: 'beat',
    ownerId: cut.beat_id,
    generatedBy: model ? String(model).slice(0, 200) : null,
  });
  return attachVideo({ projectId, cut, file, durationSeconds, model });
}

export async function setCutVideoFromUrl({ projectId, cut, videoUrl, durationSeconds = null, model = null }) {
  const file = await uploadAttachmentFromUrl(projectId, {
    sourceUrl: String(videoUrl),
    ownerType: 'beat',
    ownerId: cut.beat_id,
  });
  if (!/^video\//i.test(file.content_type || '')) {
    await deleteAttachment(file._id).catch(() => {});
    throw new McpInputError(`That URL returned ${file.content_type || 'an unknown type'}, not a video.`);
  }
  return attachVideo({ projectId, cut, file, durationSeconds, model });
}

export async function clearCutVideo({ projectId, cut }) {
  const old = cut.video_file_id ? String(cut.video_file_id) : null;
  if (old) {
    await setVideoPromptVideoViaGateway({ projectId, promptId: String(cut._id), videoFileId: null });
    await deleteAttachment(old).catch((e) => logger.warn(`mcp: delete clip ${old} failed: ${e?.message || e}`));
  }
  return readCut(projectId, String(cut._id));
}
