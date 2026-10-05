// tools.js
//
// The MCP tool surface: a coding agent reads the story (beats, dialogue,
// cast, reference images) and plans a beat's Scenes tab — scenes, cuts, frame
// prompts, frame images, clips. Storage only: nothing here calls a model or
// renders anything.

import sharp from 'sharp';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from '../log.js';
import { countDialogsByBeat, listDialogs } from '../mongo/dialogs.js';
import { getCharacter, listCharacters } from '../mongo/characters.js';
import { getDirectorNotes } from '../mongo/directorNotes.js';
import { readImageBuffer } from '../mongo/images.js';
import { getPlot, listBeats } from '../mongo/plots.js';
import { listProjects } from '../mongo/projects.js';
import { getSet, listSets } from '../mongo/sets.js';
import { MAX_REFERENCE_IMAGES, countVideoPromptsByBeat } from '../mongo/videoPrompts.js';
import { listVideoScenes } from '../mongo/videoScenes.js';
import { findCharactersInBeat, findSetsInBeat } from '../web/beatPlanShared.js';
import { cleanIdList, isOidHex } from '../web/cutValidation.js';
import {
  deleteVideoPromptViaGateway,
  deleteVideoSceneViaGateway,
  reorderCutsInSceneViaGateway,
  reorderVideoScenesViaGateway,
} from '../web/gateway.js';
import { buildReferenceCatalog } from '../web/referenceCatalog.js';
import { hardBreaksToLines, stripMarkdown } from '../util/markdown.js';
import { McpInputError, resolveBeat, resolveCut, resolveProject, resolveScene } from './resolve.js';
import {
  imageUrl,
  serializeBeat,
  serializeBeatSummary,
  serializeCharacter,
  serializeDialog,
  serializeImageFile,
  serializeOwnerImages,
  serializeProject,
  serializeSet,
} from './serialize.js';
import {
  beatTree,
  clearCutVideo,
  clearFrameImage,
  createCut,
  createScene,
  frameName,
  setCutVideoFromUrl,
  setFrameImageFrom,
  undoFrameImage,
  updateCut,
  updateScene,
} from './store.js';

export const MCP_SERVER_NAME = 'screenplay';

export function buildInstructions(uploadBase = 'http://localhost:3002') {
  return [
    'Storage for a screenplay project: read the story, then plan and store a beat\'s Scenes tab. Nothing here generates text, images or video — you do the planning and bring the media.',
    '',
    'Model: a project has beats (numbered story sections). In the Scenes tab a beat has scenes, a scene has cuts (labelled "<scene>.<cut>", e.g. 2.3). A cut has a title, a length in seconds, a video prompt, and a start frame and an end frame — each with its own image prompt, an ordered list of reference image ids, and one image — plus the rendered clip.',
    '',
    'Reading: list_beats → get_beat (the page text and its dialogue lines) → get_cast (who and where) → get_scenes (what is already planned). Artwork: list_artwork gives every picture of one character or set, list_reference_images the whole beat\'s pool; their image_id values are what a frame\'s reference list takes, their URLs are the files. view_image shows you any image.',
    'Writing: create_scene (pass `cuts` to create a whole scene in one call), create_cut, update_scene, update_cut, reorder_*, delete_*. Edits appear live in open browsers.',
    `Media: set_frame_image takes an image URL (or the id of an image already in the project, which is copied). A local file goes over plain HTTP instead: curl -T frame.png "${uploadBase}/upload?cut_id=<cut id>&target=start_frame" (targets: start_frame, end_frame, video). Replacing a frame image keeps the previous one for a one-step undo_frame_image.`,
    '',
    'Every beat-addressed tool takes an optional `project` (title or id; the default project when omitted) and a `beat` (its number, id or name). Scene and cut tools take the id alone.',
  ].join('\n');
}

const project = z.string().optional().describe('Project title or id. Omit for the default project.');
const beat = z.union([z.string(), z.number()]).describe('The beat: its number (order), id or name.');
const sceneId = z.string().describe('Scene id (from get_scenes / create_scene).');
const cutId = z.string().describe('Cut id (from get_scenes / create_cut).');
const frame = z.enum(['start', 'end']).describe('Which frame of the cut.');
const refIds = z
  .array(z.string())
  .max(MAX_REFERENCE_IMAGES)
  .describe(`Ordered reference image ids for rendering this frame (at most ${MAX_REFERENCE_IMAGES}); take them from list_artwork / list_reference_images, or use the cut's own start-frame image_id on the end frame. Replaces the list.`);

// The fields of a cut, shared by create_scene.cuts[], create_cut and update_cut.
const cutFields = {
  title: z.string().optional().describe('Short name of the cut.'),
  prompt: z.string().optional().describe('The video prompt: what happens in the shot, camera included. Markdown.'),
  duration_seconds: z.number().positive().max(600).nullable().optional().describe('Length of the cut in seconds (rounded to 0.5). null clears it.'),
  start_frame_prompt: z.string().optional().describe('Image prompt for the first frame of the shot.'),
  end_frame_prompt: z.string().optional().describe('Image prompt for the last frame of the shot.'),
  start_frame_reference_ids: refIds.optional(),
  end_frame_reference_ids: refIds.optional(),
};
const position = (what) => z.number().int().min(1).optional().describe(`1-based position among ${what}.`);

const READ = { readOnlyHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false };
const DESTROY = { readOnlyHint: false, destructiveHint: true };

function json(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function idList(raw) {
  const ids = cleanIdList(raw);
  if (!ids) throw new McpInputError('ordered_ids must be a list of ids');
  return ids;
}

export function buildMcpServer({ uploadBase } = {}) {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '1.0.0' }, { instructions: buildInstructions(uploadBase) });

  // A thrown error becomes the tool's error text — the agent reads it and
  // corrects itself; nothing here should take the connection down.
  function tool(name, description, inputSchema, annotations, handler) {
    server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
      try {
        const out = await handler(args || {});
        return out?.content ? out : json(out);
      } catch (e) {
        if (!(e instanceof McpInputError)) logger.warn(`mcp: ${name} failed: ${e?.stack || e}`);
        return { isError: true, content: [{ type: 'text', text: e?.message || String(e) }] };
      }
    });
  }

  // ─── Reading ──────────────────────────────────────────────────────────────

  tool('list_projects', 'List the screenplay projects.', {}, READ, async () => ({
    projects: (await listProjects()).map(serializeProject),
  }));

  tool(
    'get_story',
    'The story as a whole: title, synopsis, dialogue style, directorial voice and the director\'s notes. Read once for tone before planning shots.',
    { project },
    READ,
    async (a) => {
      const p = await resolveProject(a.project);
      const projectId = p._id.toString();
      const [plot, notes] = await Promise.all([getPlot(projectId), getDirectorNotes(projectId)]);
      const page = (v) => hardBreaksToLines(v || '').trim();
      return {
        project: serializeProject(p),
        title: page(plot.title),
        synopsis: page(plot.synopsis),
        dialogue_style: page(plot.dialogue_style),
        directorial_voice: page(plot.directorial_voice),
        director_notes: (notes.notes || []).map((n) => page(n.text)).filter(Boolean),
        beat_count: (plot.beats || []).length,
      };
    },
  );

  tool(
    'list_beats',
    'The project\'s beats in order: number, name, one-line description, characters, sets, and how many scenes / cuts / dialogue lines each already has.',
    { project },
    READ,
    async (a) => {
      const p = await resolveProject(a.project);
      const projectId = p._id.toString();
      const [beats, cuts, dialogs, scenes] = await Promise.all([
        listBeats(projectId),
        countVideoPromptsByBeat(projectId),
        countDialogsByBeat(projectId),
        listVideoScenes({ projectId }),
      ]);
      const sceneCount = new Map();
      for (const s of scenes) sceneCount.set(String(s.beat_id), (sceneCount.get(String(s.beat_id)) || 0) + 1);
      return {
        project: serializeProject(p),
        beats: beats.map((b) =>
          serializeBeatSummary(b, {
            scenes: sceneCount.get(String(b._id)) || 0,
            cuts: cuts.get(String(b._id)) || 0,
            dialogue_lines: dialogs.get(String(b._id)) || 0,
          }),
        ),
      };
    },
  );

  tool(
    'get_beat',
    'One beat\'s text: name, description, the full body as written (screenplay lines kept), its characters and sets, and — unless include_dialogue is false — the Dialog tab\'s lines.',
    { project, beat, include_dialogue: z.boolean().optional().describe('Default true.') },
    READ,
    async (a) => {
      const { projectId, beat: b } = await resolveBeat(a.project, a.beat);
      const dialogs = a.include_dialogue === false ? null : await listDialogs({ projectId, beatId: String(b._id) });
      return serializeBeat(b, dialogs);
    },
  );

  tool(
    'get_dialogue',
    'The Dialog tab of one beat: every line in order with its speaker, direction, text and — when recorded — the audio length and URL. Read-only.',
    { project, beat },
    READ,
    async (a) => {
      const { projectId, beat: b } = await resolveBeat(a.project, a.beat);
      const dialogs = await listDialogs({ projectId, beatId: String(b._id) });
      return { beat: { order: b.order, id: String(b._id), name: b.name }, dialogue: dialogs.map(serializeDialog) };
    },
  );

  tool(
    'get_cast',
    'Who and where a beat is: each character on its roster (profile fields, the wardrobe for this beat, portrait and wardrobe-plate image ids) and each set (description, main image).',
    { project, beat },
    READ,
    async (a) => {
      const { projectId, beat: b } = await resolveBeat(a.project, a.beat);
      const [characters, sets] = await Promise.all([findCharactersInBeat(projectId, b), findSetsInBeat(projectId, b)]);
      return {
        characters: characters.map((c) => serializeCharacter(c, b)),
        sets: sets.map(serializeSet),
      };
    },
  );

  tool(
    'list_characters',
    'Every character in the project (name, actor, portrait). Use a name or id with list_artwork.',
    { project },
    READ,
    async (a) => {
      const p = await resolveProject(a.project);
      return {
        characters: (await listCharacters(p._id.toString())).map((c) => ({
          id: String(c._id),
          name: stripMarkdown(c.name || ''),
          hollywood_actor: stripMarkdown(c.hollywood_actor || '') || null,
          portrait_image_id: c.main_image_id ? String(c.main_image_id) : null,
          portrait_url: imageUrl(c.main_image_id),
        })),
      };
    },
  );

  tool(
    'list_sets',
    'Every set (location) in the project (name, description, main image). Use a name or id with list_artwork.',
    { project },
    READ,
    async (a) => {
      const p = await resolveProject(a.project);
      return { sets: (await listSets(p._id.toString())).map(serializeSet) };
    },
  );

  tool(
    'list_artwork',
    'ALL the pictures of one character or one set: every finished artwork (name, description, the prompt that made it) and every gallery upload, with roles marking the portrait / main image and a character\'s wardrobe plate. Each has an image_id — pass those as start/end_frame_reference_ids — and a URL to download the file when you hand it to an image generator yourself. view_image shows one.',
    {
      project,
      character: z.string().optional().describe('Character name or id.'),
      set: z.string().optional().describe('Set name or id.'),
    },
    READ,
    async (a) => {
      if (!!a.character === !!a.set) throw new McpInputError('give exactly one of character and set');
      const p = await resolveProject(a.project);
      const projectId = p._id.toString();
      if (a.character) {
        const c = await getCharacter(projectId, a.character);
        if (!c) throw new McpInputError(`Character "${a.character}" not found — call list_characters`);
        return { character: serializeCharacter(c), images: serializeOwnerImages(c, 'character') };
      }
      const s = await getSet(projectId, a.set);
      if (!s) throw new McpInputError(`Set "${a.set}" not found — call list_sets`);
      return { set: serializeSet(s), images: serializeOwnerImages(s, 'set') };
    },
  );

  tool(
    'list_reference_images',
    'One beat\'s reference pool in a single call: the finished artwork of every character and set on the beat\'s roster, plus wardrobe plates (what the Scenes tab\'s own picker offers). For everything one character or set has, use list_artwork.',
    { project, beat },
    READ,
    async (a) => {
      const { projectId, beat: b } = await resolveBeat(a.project, a.beat);
      const catalog = await buildReferenceCatalog(projectId, b);
      return {
        images: catalog.map((e) => ({
          image_id: e.image_id,
          owner_type: e.owner_type,
          owner_name: e.owner_name,
          label: e.label,
          description: e.description,
          ...(e.wardrobe ? { wardrobe_plate: true } : {}),
          url: imageUrl(e.image_id),
        })),
      };
    },
  );

  tool(
    'get_scenes',
    'The beat\'s Scenes tab as stored: every scene with its cuts — label, title, length, video prompt, both frames (prompt, reference ids, image id + URL) and the clip.',
    { project, beat },
    READ,
    async (a) => {
      const { projectId, beat: b } = await resolveBeat(a.project, a.beat);
      return { beat: { order: b.order, id: String(b._id), name: b.name }, scenes: await beatTree(projectId, b) };
    },
  );

  tool(
    'view_image',
    'Look at an image stored in the project (a frame, artwork, a portrait): returns the picture itself, downscaled, with what is known about it.',
    {
      image_id: z.string().describe('Image id.'),
      max_px: z.number().int().min(256).max(2048).optional().describe('Longest side in pixels. Default 1024.'),
    },
    READ,
    async (a) => {
      if (!isOidHex(String(a.image_id))) throw new McpInputError(`"${a.image_id}" is not an image id`);
      const read = await readImageBuffer(String(a.image_id));
      if (!read) throw new McpInputError(`image ${a.image_id} not found`);
      const side = a.max_px || 1024;
      const jpeg = await sharp(read.buffer)
        .rotate()
        .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      return {
        content: [
          { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' },
          { type: 'text', text: JSON.stringify(serializeImageFile(read.file), null, 2) },
        ],
      };
    },
  );

  // ─── Scenes ───────────────────────────────────────────────────────────────

  tool(
    'create_scene',
    'Add a scene to a beat. Pass `cuts` to create the scene with all of its cuts in one call (in the order given).',
    {
      project,
      beat,
      title: z.string().optional().describe('Name of the scene.'),
      position: position('the beat\'s scenes'),
      cuts: z.array(z.object(cutFields)).max(60).optional().describe('The scene\'s cuts, first to last.'),
    },
    WRITE,
    async (a) => {
      const { projectId, beat: b } = await resolveBeat(a.project, a.beat);
      return { scene: await createScene({ projectId, beat: b, title: a.title, position: a.position, cuts: a.cuts || [] }) };
    },
  );

  tool(
    'update_scene',
    'Rename a scene and/or move it to another position in its beat.',
    { scene_id: sceneId, title: z.string().optional(), position: position('the beat\'s scenes') },
    WRITE,
    async (a) => {
      const { projectId, scene } = await resolveScene(a.scene_id);
      return { scene: await updateScene({ projectId, scene, title: a.title, position: a.position }) };
    },
  );

  tool(
    'delete_scene',
    'Delete a scene with every cut in it, their frame images and clips. The remaining scenes and cuts renumber. Cannot be undone.',
    { scene_id: sceneId },
    DESTROY,
    async (a) => {
      const { projectId, scene } = await resolveScene(a.scene_id);
      const out = await deleteVideoSceneViaGateway({ projectId, sceneId: String(scene._id) });
      return { deleted: true, cuts_removed: out.cuts_removed };
    },
  );

  tool(
    'reorder_scenes',
    'Put a beat\'s scenes in a new order: ordered_ids must list every scene of the beat exactly once.',
    { project, beat, ordered_ids: z.array(z.string()) },
    WRITE,
    async (a) => {
      const { projectId, beat: b } = await resolveBeat(a.project, a.beat);
      await reorderVideoScenesViaGateway({ projectId, beatId: String(b._id), orderedIds: idList(a.ordered_ids) });
      return { scenes: await beatTree(projectId, b) };
    },
  );

  // ─── Cuts ─────────────────────────────────────────────────────────────────

  tool(
    'create_cut',
    'Add a cut to a scene (appended unless `position` is given).',
    { scene_id: sceneId, ...cutFields, position: position('the scene\'s cuts') },
    WRITE,
    async (a) => {
      const { projectId, scene } = await resolveScene(a.scene_id);
      return { cut: await createCut({ projectId, scene, spec: a }) };
    },
  );

  tool(
    'update_cut',
    'Change a cut: only the fields you pass are written. A reference id list replaces the frame\'s list; `position` moves the cut inside its scene.',
    { cut_id: cutId, ...cutFields, position: position('the scene\'s cuts') },
    WRITE,
    async (a) => {
      const { projectId, cut } = await resolveCut(a.cut_id);
      const { cut_id: _id, ...patch } = a;
      return { cut: await updateCut({ projectId, cut, patch }) };
    },
  );

  tool(
    'delete_cut',
    'Delete a cut with its frame images and clip. The scene\'s remaining cuts renumber. Cannot be undone.',
    { cut_id: cutId },
    DESTROY,
    async (a) => {
      const { projectId, cut } = await resolveCut(a.cut_id);
      await deleteVideoPromptViaGateway({ projectId, promptId: String(cut._id) });
      return { deleted: true };
    },
  );

  tool(
    'reorder_cuts',
    'Put a scene\'s cuts in a new order: ordered_ids must list every cut of the scene exactly once.',
    { scene_id: sceneId, ordered_ids: z.array(z.string()) },
    WRITE,
    async (a) => {
      const { projectId, scene } = await resolveScene(a.scene_id);
      await reorderCutsInSceneViaGateway({ projectId, sceneId: String(scene._id), orderedIds: idList(a.ordered_ids) });
      const { beat: b } = await resolveBeat(projectId, String(scene.beat_id));
      return { scene: (await beatTree(projectId, b)).find((s) => s.id === String(scene._id)) };
    },
  );

  // ─── Frame images and clips ───────────────────────────────────────────────

  tool(
    'set_frame_image',
    'Store a picture as a cut\'s start or end frame, from a URL (png, jpeg or webp) or as a copy of an image already in the project. The image it replaces is kept for one undo. For a local file use the HTTP upload endpoint described in the server instructions.',
    {
      cut_id: cutId,
      frame,
      image_url: z.string().optional().describe('http(s) URL of the image to fetch.'),
      image_id: z.string().optional().describe('Id of an image already in the project; its bytes are copied.'),
      model: z.string().optional().describe('What generated the image (shown with the frame).'),
    },
    WRITE,
    async (a) => {
      const { projectId, cut } = await resolveCut(a.cut_id);
      return {
        cut: await setFrameImageFrom({
          projectId,
          cut,
          frame: frameName(a.frame),
          imageUrl: a.image_url,
          imageId: a.image_id,
          model: a.model,
        }),
      };
    },
  );

  tool(
    'clear_frame_image',
    'Remove a frame\'s image (and its undo image). The frame\'s prompt and reference list stay.',
    { cut_id: cutId, frame },
    DESTROY,
    async (a) => {
      const { projectId, cut } = await resolveCut(a.cut_id);
      return { cut: await clearFrameImage({ projectId, cut, frame: frameName(a.frame) }) };
    },
  );

  tool(
    'undo_frame_image',
    'Put back the image a frame had before the last set_frame_image / render (one step).',
    { cut_id: cutId, frame },
    WRITE,
    async (a) => {
      const { projectId, cut } = await resolveCut(a.cut_id);
      return { cut: await undoFrameImage({ projectId, cut, frame: frameName(a.frame) }) };
    },
  );

  tool(
    'set_cut_video',
    'Store a rendered clip on a cut from a URL (mp4, mov or webm); the clip it replaces is deleted. For a local file use the HTTP upload endpoint with target=video.',
    {
      cut_id: cutId,
      video_url: z.string().describe('http(s) URL of the video to fetch.'),
      duration_seconds: z.number().positive().optional().describe('Length of the clip.'),
      model: z.string().optional().describe('What generated the clip (shown with it).'),
    },
    WRITE,
    async (a) => {
      const { projectId, cut } = await resolveCut(a.cut_id);
      return {
        cut: await setCutVideoFromUrl({ projectId, cut, videoUrl: a.video_url, durationSeconds: a.duration_seconds, model: a.model }),
      };
    },
  );

  tool('clear_cut_video', 'Delete a cut\'s clip.', { cut_id: cutId }, DESTROY, async (a) => {
    const { projectId, cut } = await resolveCut(a.cut_id);
    return { cut: await clearCutVideo({ projectId, cut }) };
  });

  return server;
}
