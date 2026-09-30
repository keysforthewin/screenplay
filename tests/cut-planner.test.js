// The scene/cut planner: pure normalizers, then the whole job through the
// LLM seam and the gateway fallback (no Hocuspocus).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({ getDb: () => fakeDb, connectMongo: async () => fakeDb }));
vi.mock('../src/log.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/web/hocuspocus.js', () => ({
  getRoomDocument: () => null, withDirectDocument: vi.fn(), broadcastRoomStateless: vi.fn(), isHocuspocusRunning: () => false,
}));
const imageMeta = new Map();
vi.mock('../src/mongo/images.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    findImageFile: vi.fn(async (id) => {
      const m = imageMeta.get(String(id));
      if (!m) return null;
      return { _id: new ObjectId(String(id)), filename: 'x.png', contentType: 'image/png', length: 1, metadata: m };
    }),
    deleteImages: vi.fn(async () => {}),
    deleteImage: vi.fn(async () => {}),
  };
});

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Dialogs = await import('../src/mongo/dialogs.js');
const VS = await import('../src/mongo/videoScenes.js');
const VP = await import('../src/mongo/videoPrompts.js');
const BeatLocks = await import('../src/web/beatLocks.js');
const P = await import('../src/web/cutPlanner.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  imageMeta.clear();
  projectId = (await createProject('Planner'))._id.toString();
  BeatLocks._clearBeatLocksForTests();
  P._setCutPlannerCallsForTests(null);
  P._setStartFramesRendererForTests(null);
  P._clearCutPlanJobsForTests();
});

function art(desc) {
  const id = new ObjectId();
  imageMeta.set(id.toString(), { description: desc, name: '' });
  return id;
}

async function seed() {
  const sarahArt = art('Sarah full body, grey wool coat');
  const tomArt = art('Tom, black raincoat, wet');
  const dinerArt = art('Diner interior, night, sodium light through the window');
  for (const [name, a, look] of [['Sarah', sarahArt, 'thirties, dark hair tied back'], ['Tom', tomArt, 'thirties, short beard']]) {
    await fakeDb.collection('characters').insertOne({
      _id: new ObjectId(), project_id: projectId, name, name_lower: name.toLowerCase(), hollywood_actor: '',
      fields: { description: look }, artworks: [{ _id: new ObjectId(), status: 'done', result_image_id: a, name: `${name} plate`, description: '' }],
      created_at: new Date(), updated_at: new Date(),
    });
  }
  await fakeDb.collection('sets').insertOne({
    _id: new ObjectId(), project_id: projectId, name: 'Diner', name_lower: 'diner', description: 'A night diner.',
    artworks: [{ _id: new ObjectId(), status: 'done', result_image_id: dinerArt, name: 'Interior', description: '' }],
    created_at: new Date(), updated_at: new Date(),
  });
  const beat = await Plots.createBeat({
    projectId, name: 'Diner', desc: 'Sarah waits; Tom arrives soaked.',
    body: 'INT. DINER — NIGHT\n\nSarah waits in the booth.\n\nTom enters, dripping.\n\nEXT. STREET — LATER\n\nSarah walks away.',
    characters: ['Sarah', 'Tom'], sets: ['Diner'],
  });
  const d1 = await Dialogs.createDialog({ projectId, beatId: beat._id, character: 'Tom', body: 'I am sorry I am late' });
  const d2 = await Dialogs.createDialog({ projectId, beatId: beat._id, character: 'Sarah', body: 'Do not.' });
  return { beat, d1, d2, sarahArt, tomArt, dinerArt };
}

const read = (turn) => ({
  dramatic_function: 'turn', turn, pov: 'hers', power_shift: 'he loses the table', hidden_want: 'a reason not to go',
  obstacle_tactic: 'his explanation; not looking', subtext: 'seated while leaving', suppressed_behavior: 'pushes the cup one inch',
  non_transferable_detail: 'the undrunk cup', stock_solution_refused: 'no tears, no music',
});
const scope = { already_happened: ['they fought'], this_scene_only: ['he arrives'], reserved_for_later: ['she leaves'], do_not_show_yet: ['the street'] };

function camera(over = {}) {
  return { size: 'wide', angle: 'eye_level', height: 'seated eye level', lens_mm: 24, side: 'from the counter end', movement: 'static', motivation: '', depth_of_field: 'deep', lighting: 'warm tubes inside, sodium through the window', ...over };
}

function seamFor({ scenes, cutsByScene, proseByScene, framesByScene }) {
  return async ({ pass, scene }) => {
    if (pass === 'scenes') return { scenes };
    const key = scene?.title;
    if (pass === 'cuts') return { cuts: cutsByScene[key] || [], load_notes: 'n' };
    if (pass === 'prose') return { cuts: proseByScene[key] || [] };
    if (pass === 'start_frames') return { cuts: framesByScene[key] || [] };
    return null;
  };
}

async function waitJob(id) {
  for (let i = 0; i < 500; i++) {
    const j = P.getCutPlanJob(id);
    if (j && ['done', 'partial', 'error'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job never finished');
}

describe('normalizeScenes', () => {
  it('verifies names, flags blank read fields, and repairs the dialogue partition', () => {
    const dialogs = [{ _id: new ObjectId() }, { _id: new ObjectId() }, { _id: new ObjectId() }];
    const { scenes, warnings } = P.normalizeScenes(
      [
        { title: 'A', slug: 'INT. DINER — NIGHT', set_names: ['diner', 'Moon'], character_names: ['SARAH', 'Bob'], text_span: { starts_with: 'Sarah waits', ends_with: 'dripping.' }, directors_read: { ...read('x'), pov: '' }, intention: 'i', scope, floor_plan: 'plan', dialog_lines: [1, 1, 9] },
        { title: '', slug: '', set_names: [], character_names: [], text_span: {}, directors_read: read('y'), intention: '', scope: {}, floor_plan: '', dialog_lines: [3] },
      ],
      { characters: [{ name: 'Sarah' }, { name: 'Tom' }], sets: [{ name: 'Diner' }], dialogs },
    );
    expect(scenes.length).toBe(2);
    expect(scenes[0].set_names).toEqual(['Diner']);
    expect(scenes[0].character_names).toEqual(['Sarah']);
    expect(scenes[1].title).toBe('Scene 2');
    expect(scenes[0].dialog_lines).toEqual([1, 2]);
    expect(scenes[1].dialog_lines).toEqual([3]);
    expect(scenes[0].dialog_ids).toEqual([dialogs[0]._id, dialogs[1]._id]);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/unknown set "Moon"/),
      expect.stringMatching(/unknown character "Bob"/),
      expect.stringMatching(/"pov" is blank/),
      expect.stringMatching(/line 9 \(not in range\)/),
      expect.stringMatching(/assigned twice/),
      expect.stringMatching(/line 2 was unassigned/),
      expect.stringMatching(/Scene 2: floor plan is blank/),
    ]));
  });
});

describe('normalizeCuts', () => {
  it('filters in_frame to the scene roster, picks the actor, covers every line, estimates durations', () => {
    const dialogs = [{ _id: new ObjectId(), character: 'Tom', body: 'I am sorry I am late' }, { _id: new ObjectId(), character: 'Sarah', body: 'Do not.' }];
    const scene = { order: 1, title: 'A', character_names: ['Sarah', 'Tom'], set_names: ['Diner'], dialog_lines: [1, 2] };
    const { cuts, warnings } = P.normalizeCuts(
      [
        { camera: camera({ size: 'nonsense' }), in_frame: [{ character: 'sarah', position: 'booth', facing: 'door', acts: false }, { character: 'Bob', position: 'x', facing: 'y', acts: true }], action_by: 'Bob', reaction: false, eyeline: '', action: 'waits', others: '', last_frame: 'her hands on the cup', sound: '', sound_on_action: false, crossing: false, contact: false, dialog_lines: [], sets_in_scene: ['nowhere'], primary_spend: 'world', felt_intent: 'f' },
        { camera: camera({ size: 'close_up', lens_mm: 85 }), in_frame: [{ character: 'Tom', position: 'opposite her', facing: 'her', acts: true }], action_by: 'Tom', reaction: false, eyeline: '', action: 'speaks', others: '', last_frame: 'his hands open', sound: 'rain', sound_on_action: false, crossing: false, contact: false, dialog_lines: [1], sets_in_scene: ['Diner'], primary_spend: 'identity', felt_intent: 'f' },
      ],
      { scene, dialogs },
    );
    expect(cuts.length).toBe(2);
    expect(cuts[0].camera.size).toBeNull();
    expect(cuts[0].in_frame).toEqual([{ character: 'Sarah', position: 'booth', facing: 'door', acts: true }]);
    expect(cuts[0].action_by).toBe('Sarah');
    expect(cuts[0].sets_in_scene).toEqual(['Diner']);
    expect(cuts[0].characters_in_scene).toEqual(['Sarah']);
    // Line 2 (Sarah) was unassigned: it lands in the cut after the one covering line 1.
    expect(cuts[1].dialog_lines).toEqual([1, 2]);
    expect(cuts[1].dialog_ids).toEqual([dialogs[0]._id, dialogs[1]._id]);
    expect(cuts[0].duration_seconds).toBeGreaterThanOrEqual(3);
    expect(cuts[1].duration_seconds).toBeGreaterThan(cuts[0].duration_seconds);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/"Bob" is not in this scene/),
      expect.stringMatching(/camera size missing/),
      expect.stringMatching(/line 2 was unassigned/),
      expect.stringMatching(/spoken by Sarah who is not in frame/),
    ]));
  });
});

describe('applyProse / applyStartFrames', () => {
  it('strips "Cut N." labels, falls back for missing blocks, lints, and maps artwork picks', () => {
    const cuts = [
      { cut_index: 1, camera: camera(), in_frame: [{ character: 'Sarah', position: 'booth', facing: 'door', acts: true }], action_by: 'Sarah', action: 'waits', others: '', last_frame: 'x', sound: '', dialog_lines: [], characters_in_scene: ['Sarah'], sets_in_scene: ['Diner'] },
      { cut_index: 2, camera: camera(), in_frame: [], action_by: '', action: 'the cup', others: '', last_frame: 'the cup', sound: '', dialog_lines: [], characters_in_scene: [], sets_in_scene: ['Diner'] },
    ];
    const { warnings } = P.applyProse(
      [{ cut_index: 1, title: 'Sarah waits', prompt: 'Cut 1. Wide shot from the counter end: her face fell. Same light: warm tubes. Sarah: thirties, seated in the booth, facing the door. Camera at the counter end. End with her hands on the cup.', lock_line: 'Same light: warm tubes. Sarah: thirties, seated in the booth, facing the door. Camera at the counter end.', reference_binding: '@Image1 controls Sarah', exclusions: [] }],
      cuts, { dialogs: [] },
    );
    expect(cuts[0].prompt.startsWith('Wide shot')).toBe(true);
    expect(cuts[0].title).toBe('Sarah waits');
    expect(cuts[0].lint.map((f) => f.code)).toContain('trap_phrase');
    expect(cuts[1].prompt).toMatch(/Light:/);
    expect(cuts[1].title).toBe('Cut 2');
    expect(warnings).toEqual([expect.stringMatching(/Cut 2: the model wrote no block/)]);

    const a = 'a'.repeat(24);
    const d = 'd'.repeat(24);
    const groups = P.groupCatalogBySubject([
      { image_id: a, owner_type: 'character', owner_name: 'Sarah', label: 'Sarah — artwork: plate', description: 'full body' },
      { image_id: d, owner_type: 'set', owner_name: 'Diner', label: 'Diner — artwork: interior', description: '' },
    ]);
    expect(P.formatCatalogBySubject(groups)).toContain('Sarah (character):\n  1. Sarah — artwork: plate — full body');
    const r = P.applyStartFrames(
      [{ cut_index: 1, start_frame_prompt: 'Wide frontal, 24mm…', reference_picks: [{ subject: 'sarah', artwork_index: 1 }, { subject: 'Diner', artwork_index: 7 }, { subject: 'Bob', artwork_index: 1 }] }],
      cuts, { catalogGroups: groups },
    );
    expect(cuts[0].start_frame.prompt).toBe('Wide frontal, 24mm…');
    expect(cuts[0].start_frame.reference_ids).toEqual([a]);
    expect(cuts[1].start_frame.prompt.length).toBeGreaterThan(0);
    expect(r.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/Diner has no artwork #7/),
      expect.stringMatching(/unknown subject "Bob"/),
      expect.stringMatching(/Cut 2: no start-frame prompt/),
    ]));
    // Planned lists are marked so the renderer never auto-fills them — an
    // empty one included (cut 2 had no entry at all).
    expect(cuts[0].start_frame.references_planned).toBe(true);
    expect(cuts[1].start_frame.reference_ids).toEqual([]);
    expect(cuts[1].start_frame.references_planned).toBe(true);
  });

  it('fills the end frame from its own prompt and picks, falls back to the last-frame cell, and reuses the start picks when the end picks are absent', () => {
    const a = 'a'.repeat(24);
    const d = 'd'.repeat(24);
    const groups = P.groupCatalogBySubject([
      { image_id: a, owner_type: 'character', owner_name: 'Sarah', label: 'Sarah — artwork', description: '' },
      { image_id: d, owner_type: 'set', owner_name: 'Theatre', label: 'Theatre — exterior', description: '' },
    ]);
    const cuts = [
      { cut_index: 1, prompt: 'x', last_frame: 'the marquee' },
      { cut_index: 2, prompt: 'y', last_frame: 'Sarah at the door' },
      { cut_index: 3, prompt: 'z', last_frame: '' },
    ];
    const { warnings } = P.applyStartFrames([
      // A tilt from the sky: no set pick at the start, the exterior at the end.
      { cut_index: 1, start_frame_prompt: 'Sky over the roofline.', reference_picks: [], end_frame_prompt: 'The curved stucco front under the marquee.', end_reference_picks: [{ subject: 'Theatre', artwork_index: 1, use: 'framing' }, { subject: 'Nobody', artwork_index: 1, use: 'look' }] },
      { cut_index: 2, start_frame_prompt: 'Sarah in the lobby.', reference_picks: [{ subject: 'Sarah', artwork_index: 1, use: 'look' }] },
      { cut_index: 3, start_frame_prompt: 'z start', reference_picks: [] },
    ], cuts, { catalogGroups: groups });
    expect(cuts[0].start_frame.reference_ids).toEqual([]);
    expect(cuts[0].end_frame).toMatchObject({ prompt: 'The curved stucco front under the marquee.', reference_ids: [d], reference_uses: { [d]: 'framing' }, references_planned: true, image_id: null });
    expect(cuts[1].end_frame.prompt).toBe('Sarah at the door');
    expect(cuts[1].end_frame.reference_ids).toEqual([a]);
    expect(cuts[2].end_frame).toBeNull();
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/Cut 1: end reference pick for unknown subject "Nobody"/),
      expect.stringMatching(/Cut 2: no end-frame prompt returned; using the last-frame cell/),
    ]));
  });

  it('the pass-4 tool asks for both frames and carries no numeric bounds', () => {
    const item = P.DERIVE_START_FRAMES_TOOL.input_schema.properties.cuts.items;
    expect(item.required).toEqual(expect.arrayContaining(['start_frame_prompt', 'reference_picks', 'end_frame_prompt', 'end_reference_picks']));
    expect(JSON.stringify(P.DERIVE_START_FRAMES_TOOL)).not.toMatch(/"minimum"|"maximum"/);
    expect(P.START_FRAMES_SYSTEM_PROMPT).toMatch(/End frame — the still/);
  });

  it('records a set pick\'s "framing" use and ignores it on characters', () => {
    const a = 'a'.repeat(24);
    const d = 'd'.repeat(24);
    const groups = P.groupCatalogBySubject([
      { image_id: a, owner_type: 'character', owner_name: 'Sarah', label: 'Sarah — artwork', description: '' },
      { image_id: d, owner_type: 'set', owner_name: 'Diner', label: 'Diner — artwork', description: '' },
    ]);
    const cuts = [{ cut_index: 1, prompt: 'x' }, { cut_index: 2, prompt: 'y' }];
    P.applyStartFrames([
      { cut_index: 1, start_frame_prompt: 'p1', reference_picks: [{ subject: 'Sarah', artwork_index: 1, use: 'framing' }, { subject: 'Diner', artwork_index: 1, use: 'framing' }] },
      { cut_index: 2, start_frame_prompt: 'p2', reference_picks: [{ subject: 'Diner', artwork_index: 1, use: 'look' }] },
    ], cuts, { catalogGroups: groups });
    expect(cuts[0].start_frame.reference_uses).toEqual({ [d]: 'framing' });
    expect(cuts[1].start_frame.reference_uses).toEqual({});
  });

  it('shows the picker enough of an artwork description to read its viewpoint', () => {
    const long = `Wide exterior seen from the parking lot. ${'x'.repeat(500)}`;
    const groups = P.groupCatalogBySubject([{ image_id: 'd'.repeat(24), owner_type: 'set', owner_name: 'Theater', label: 'Theater — artwork', description: long }]);
    expect(P.formatCatalogBySubject(groups)).toContain(long.slice(0, 540));
  });
});

// The full four-pass seam used by the job tests: two scenes, three cuts.
function fullSeam() {
  return seamFor({
        scenes: [
          { title: 'Waiting', slug: 'INT. DINER — NIGHT', set_names: ['Diner'], character_names: ['Sarah', 'Tom'], text_span: { starts_with: 'Sarah waits', ends_with: 'dripping.' }, directors_read: read('waiting → leaving'), intention: 'crack', scope, floor_plan: 'Door far end, counter right, booth left. Sodium through the window. Axis booth→door.', dialog_lines: [1, 2] },
          { title: 'Street', slug: 'EXT. STREET — LATER', set_names: [], character_names: ['Sarah'], text_span: { starts_with: 'Sarah walks', ends_with: 'away.' }, directors_read: read('gone'), intention: 'she is gone', scope, floor_plan: 'A wet street.', dialog_lines: [] },
        ],
        cutsByScene: {
          Waiting: [
            { camera: camera(), in_frame: [{ character: 'Sarah', position: 'in the booth', facing: 'the door', acts: true }, { character: 'Tom', position: 'in the doorway', facing: 'the booth', acts: false }], action_by: 'Sarah', reaction: false, eyeline: '', action: 'both hands around the cup', others: 'Tom drips', last_frame: 'Tom in the doorway', sound: 'rain', sound_on_action: false, crossing: false, contact: false, dialog_lines: [], sets_in_scene: ['Diner'], primary_spend: 'world', felt_intent: 'waiting' },
            { camera: camera({ size: 'close_up', lens_mm: 85, side: "from Sarah's side" }), in_frame: [{ character: 'Tom', position: 'opposite her', facing: 'her', acts: true }], action_by: 'Tom', reaction: false, eyeline: 'past the lens to her', action: 'speaks quiet and fast', others: '', last_frame: 'his hands open', sound: 'no music during the line', sound_on_action: false, crossing: false, contact: false, dialog_lines: [1, 2], sets_in_scene: ['Diner'], primary_spend: 'identity', felt_intent: 'caught out' },
          ],
          Street: [
            { camera: camera({ size: 'wide', movement: 'track', motivation: 'follows her' }), in_frame: [{ character: 'Sarah', position: 'on the pavement', facing: 'away', acts: true }], action_by: 'Sarah', reaction: false, eyeline: '', action: 'walks', others: '', last_frame: 'her back', sound: 'rain', sound_on_action: false, crossing: true, contact: false, dialog_lines: [], sets_in_scene: [], primary_spend: 'motion', felt_intent: 'gone' },
          ],
        },
        proseByScene: {
          Waiting: [
            { cut_index: 1, title: 'Sarah waits', prompt: 'Wide shot from the counter end, 24mm, the camera holding: Sarah sits with both hands around the cup as Tom drips in the doorway. Sound: rain. Light: warm tubes inside, sodium through the window. Sarah: thirties, dark hair tied back, grey wool coat, in the booth, facing the door. Tom: thirties, short beard, black raincoat, in the doorway, facing the booth. Camera at the counter end. End with Tom in the doorway.', lock_line: 'Light: warm tubes inside, sodium through the window. Sarah: thirties, dark hair tied back, grey wool coat, in the booth, facing the door. Tom: thirties, short beard, black raincoat, in the doorway, facing the booth. Camera at the counter end.', reference_binding: '@Image1 controls Sarah\'s identity and wardrobe only; ignore the room from it.', exclusions: [] },
            { cut_index: 2, title: 'Tom explains', prompt: 'Cut 2. Close shot of Tom from Sarah\'s side, 85mm, the camera holding: his face fell as he speaks. Same light: warm tubes. Tom: thirties, short beard, black raincoat, opposite her, facing her. Camera on Sarah\'s side. Stop when his hands open.', lock_line: 'Same light: warm tubes. Tom: thirties, short beard, black raincoat, opposite her, facing her. Camera on Sarah\'s side.', reference_binding: '', exclusions: ['Do not show the street yet.'] },
          ],
          Street: [{ cut_index: 1, title: 'Gone', prompt: 'Wide shot tracking her down the wet street from behind, 24mm. Sound: rain. Same light: sodium streetlight. Sarah: grey wool coat, on the pavement, facing away. Camera behind her. Hold on her back as she goes.', lock_line: 'Same light: sodium streetlight. Sarah: grey wool coat, on the pavement, facing away. Camera behind her.', reference_binding: '', exclusions: [] }],
        },
        framesByScene: {
          Waiting: [
            { cut_index: 1, start_frame_prompt: 'Frontal wide, 24mm, deep focus: a woman in a grey coat in the window booth…', reference_picks: [{ subject: 'Sarah', artwork_index: 1 }, { subject: 'Diner', artwork_index: 1 }] },
            { cut_index: 2, start_frame_prompt: 'Close shot, 85mm…', reference_picks: [{ subject: 'Tom', artwork_index: 1 }] },
          ],
          Street: [{ cut_index: 1, start_frame_prompt: 'Wide from behind…', reference_picks: [{ subject: 'Sarah', artwork_index: 1 }] }],
        },
  });
}

describe('startCutPlanJob', () => {
  it('runs every pass, wipes and recreates scenes + cuts with all fields, then renders start frames', async () => {
    const { beat, d1, d2, sarahArt, dinerArt } = await seed();
    // A pre-existing row must be replaced.
    await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'old' });
    const calls = [];
    P._setCutPlannerCallsForTests(async (args) => {
      calls.push(args.pass);
      expect(args.contextText).toContain('Tom enters, dripping.');
      return fullSeam()(args);
    });
    const rendered = [];
    let renderedFrames = null;
    P._setStartFramesRendererForTests(async ({ cutIds, frames, onProgress }) => {
      rendered.push(...cutIds);
      renderedFrames = frames;
      onProgress({ planned: cutIds.length, rendered: cutIds.length, failed: 0 });
    });

    const jobId = await P.startCutPlanJob({ projectId, beatId: beat._id.toString(), renderStartFrames: true });
    const job = await waitJob(jobId);
    expect(job.status).toBe('done');
    expect(job.error).toBeNull();
    expect(calls).toEqual(['scenes', 'cuts', 'prose', 'start_frames', 'cuts', 'prose', 'start_frames']);
    expect(job.scenes_done).toBe(2);
    expect(job.cuts_done).toBe(3);
    expect(job.lint_count).toBeGreaterThan(0);

    const scenes = await VS.listVideoScenes({ projectId, beatId: beat._id });
    expect(scenes.map((s) => s.title)).toEqual(['Waiting', 'Street']);
    expect(scenes[0].directors_read.turn).toBe('waiting → leaving');
    expect(scenes[0].floor_plan).toMatch(/Axis booth→door/);
    expect(scenes[0].dialog_ids.map(String)).toEqual([String(d1._id), String(d2._id)]);
    expect(scenes[0].load.verdict).toBeDefined();

    const rows = await VP.listVideoPrompts({ projectId, beatId: beat._id });
    expect(rows.map((r) => r.title)).toEqual(['Sarah waits', 'Tom explains', 'Gone']);
    expect(rows.map((r) => r.order)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.cut_index)).toEqual([1, 2, 1]);
    expect(String(rows[0].scene_id)).toBe(String(scenes[0]._id));
    expect(String(rows[2].scene_id)).toBe(String(scenes[1]._id));
    expect(rows[0].camera.size).toBe('wide');
    expect(rows[0].in_frame.map((p) => p.character)).toEqual(['Sarah', 'Tom']);
    expect(rows[0].characters_in_scene).toEqual(['Sarah', 'Tom']);
    expect(rows[1].dialog_ids.map(String)).toEqual([String(d1._id), String(d2._id)]);
    expect(rows[1].prompt.startsWith('Close shot')).toBe(true);
    expect(rows[1].exclusions).toEqual(['Do not show the street yet.']);
    expect(rows[1].lint.map((f) => f.code)).toContain('trap_phrase');
    expect(rows[0].start_frame.prompt).toMatch(/Frontal wide/);
    expect(rows[0].start_frame.reference_ids.map(String)).toEqual([String(sarahArt), String(dinerArt)]);
    expect(rows[0].reference_binding).toMatch(/@Image1 controls/);
    expect(typeof rows[1].duration_seconds).toBe('number');
    // No end-frame prompt in the fixture → the last-frame cell stands in, and
    // the fragment is seeded; the planner job renders both frames.
    expect(rows[0].end_frame.prompt).toBe(rows[0].last_frame);
    expect(rows[0].end_frame.references_planned).toBe(true);
    expect(renderedFrames).toEqual(['start', 'end']);
    expect(rendered.length).toBe(3);
    expect(job.start_frames).toMatchObject({ planned: 3, rendered: 3, failed: 0 });
  });

  it('keeps existing rows when the model returns no scenes, and refuses while the beat is busy', async () => {
    const { beat } = await seed();
    const keep = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'keep' });
    P._setCutPlannerCallsForTests(async () => ({ scenes: [] }));
    const job = await waitJob(await P.startCutPlanJob({ projectId, beatId: beat._id.toString() }));
    expect(job.status).toBe('done');
    expect(job.warnings).toEqual([expect.stringMatching(/no scenes/)]);
    expect((await VP.listVideoPrompts({ projectId, beatId: beat._id })).map((r) => String(r._id))).toEqual([String(keep._id)]);

    let release;
    BeatLocks.withBeatLock(beat._id, () => new Promise((r) => { release = r; }));
    await expect(P.startCutPlanJob({ projectId, beatId: beat._id.toString() })).rejects.toBeInstanceOf(P.BeatBusyError);
    release();
  });

  it('startSceneReplanJob replaces one scene\'s cuts and leaves the others alone', async () => {
    const { beat } = await seed();
    const s1 = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'One', setNames: ['Diner'], characterNames: ['Sarah'], floorPlan: 'plan' });
    const s2 = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'Two', setNames: ['Diner'], characterNames: ['Tom'], floorPlan: 'plan' });
    const oldA = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: s1._id, cutIndex: 1, title: 'oldA', order: 1 });
    const oldB = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: s1._id, cutIndex: 2, title: 'oldB', order: 2 });
    const keep = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: s2._id, cutIndex: 1, title: 'keep', order: 3 });
    P._setCutPlannerCallsForTests(async ({ pass, scene }) => {
      expect(scene.title).toBe('One');
      if (pass === 'cuts') return { cuts: [{ camera: camera(), in_frame: [{ character: 'Sarah', position: 'booth', facing: 'door', acts: true }], action_by: 'Sarah', reaction: false, eyeline: '', action: 'waits', others: '', last_frame: 'x', sound: '', sound_on_action: false, crossing: false, contact: false, dialog_lines: [], sets_in_scene: ['Diner'], primary_spend: 'world', felt_intent: 'f' }], load_notes: '' };
      if (pass === 'prose') return { cuts: [{ cut_index: 1, title: 'newA', prompt: 'Wide shot. Same light: tubes. Sarah: coat, booth, facing the door. Camera at the counter end. End with her hands.', lock_line: 'Same light: tubes. Sarah: coat, booth, facing the door. Camera at the counter end.', reference_binding: '', exclusions: [] }] };
      if (pass === 'start_frames') return { cuts: [{ cut_index: 1, start_frame_prompt: 'still', reference_picks: [] }] };
      return null;
    });
    const job = await waitJob(await P.startSceneReplanJob({ projectId, sceneId: String(s1._id) }));
    expect(job.status).toBe('done');
    const rows = await VP.listVideoPrompts({ projectId, beatId: beat._id });
    expect(rows.map((r) => r.title)).toEqual(['newA', 'keep']);
    expect(rows.map((r) => r.order)).toEqual([1, 2]);
    expect(rows.map((r) => String(r._id))).not.toContain(String(oldA._id));
    expect(rows.map((r) => String(r._id))).not.toContain(String(oldB._id));
    expect(String(rows[1]._id)).toBe(String(keep._id));
    expect((await VS.listVideoScenes({ projectId, beatId: beat._id })).length).toBe(2);
  });
});

describe('live progress', () => {
  it('records steps, an activity log, and notifies subscribers through to the terminal snapshot', async () => {
    const { beat } = await seed();
    P._setCutPlannerCallsForTests(fullSeam());
    const id = await P.startCutPlanJob({ projectId, beatId: beat._id.toString(), direction: '' });
    const snaps = [];
    P.subscribeToCutPlanJob(id, (s) => snaps.push(s));
    const job = await waitJob(id);
    await new Promise((r) => setTimeout(r, 20));
    expect(job.status).toBe('done');
    const keys = job.steps.map((s) => s.key);
    expect(keys).toEqual([
      'context', 'scenes',
      'cuts:1/2', 'prose:1/2', 'start_frame_prompts:1/2',
      'cuts:2/2', 'prose:2/2', 'start_frame_prompts:2/2',
      'writing',
    ]);
    expect(job.steps.every((s) => s.status === 'done')).toBe(true);
    expect(job.steps.find((s) => s.key === 'scenes').detail).toMatch(/2 scene/);
    expect(job.events.some((e) => /Shot table · scene 1\/2 — 2 cut/.test(e.text))).toBe(true);
    expect(job.events.at(-1).text).toMatch(/^✓ Done in \d+s — 2 scene/);
    expect(job.live).toBeNull();
    const last = snaps.at(-1);
    expect(last.status).toBe('done');
    expect(last).not.toHaveProperty('_notify');
    expect(JSON.parse(JSON.stringify(P.serializeCutPlanJob(job))).steps.length).toBe(9);
  });

  it('warnings also land in the activity log', async () => {
    const { beat } = await seed();
    P._setCutPlannerCallsForTests(() => null);
    const id = await P.startCutPlanJob({ projectId, beatId: beat._id.toString(), direction: '' });
    const job = await waitJob(id);
    expect(job.warnings).toEqual([expect.stringMatching(/no scenes/)]);
    expect(job.events.some((e) => /^⚠ .*no scenes/.test(e.text))).toBe(true);
    expect(job.steps.map((s) => s.key)).toEqual(['context', 'scenes']);
  });
});
