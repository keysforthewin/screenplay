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

describe('planned durations (the model chooses; the code only bounds)', () => {
  const row = (over = {}) => ({
    camera: camera(), in_frame: [{ character: 'Sarah', position: 'booth', facing: 'door', acts: true }], action_by: 'Sarah', reaction: false,
    eyeline: '', action: 'waits', others: '', last_frame: 'her hands on the cup', sound: '', sound_on_action: false, crossing: false, contact: false,
    dialog_lines: [], sets_in_scene: ['Diner'], primary_spend: 'world', felt_intent: 'f', ...over,
  });
  const scene = { order: 1, title: 'A', character_names: ['Sarah', 'Tom'], set_names: ['Diner'], dialog_lines: [1] };
  const dialogs = [{ _id: new ObjectId(), character: 'Sarah', body: 'I waited for you for an hour and you did not even call me once' }];

  it('keeps the model\'s length in half-second steps, bounds it, and falls back to the estimate when there is none', () => {
    expect(P.clampPlannedDuration(1.5)).toBe(1.5);
    expect(P.clampPlannedDuration(1.7)).toBe(1.5);
    expect(P.clampPlannedDuration(0.2)).toBe(1);
    expect(P.clampPlannedDuration(40)).toBe(15);
    expect(P.clampPlannedDuration(undefined, { fallback: 5 })).toBe(5);
    expect(P.clampPlannedDuration(2, { floor: 4.2 })).toBe(4.5);
    const { cuts } = P.normalizeCuts([
      row({ camera: camera({ size: 'insert' }), duration_seconds: 1.5 }),
      row({ camera: camera({ movement: 'pan', travel: 'from the door to the booth', travel_widths: 1 }), duration_seconds: 9 }),
      row(),
    ], { scene: { ...scene, dialog_lines: [] }, dialogs });
    expect(cuts.map((c) => c.duration_seconds)).toEqual([1.5, 9, 3]);
    expect(cuts[1].camera).toMatchObject({ travel: 'from the door to the booth', travel_widths: 1 });
  });

  it('raises a cut to the speech it covers and warns', () => {
    const { cuts, warnings } = P.normalizeCuts([row({ dialog_lines: [1], duration_seconds: 2 })], { scene, dialogs });
    expect(cuts[0].duration_seconds).toBeGreaterThan(5);
    expect(warnings).toEqual(expect.arrayContaining([expect.stringMatching(/shorter than the .* of speech it covers/)]));
  });

  it('warns when a quick cut carries more action than its length can render', () => {
    const overloaded = row({
      in_frame: [{ character: 'Sarah', position: 'booth', facing: 'door', acts: true }, { character: 'Tom', position: 'aisle', facing: 'her', acts: false }],
      camera: camera({ movement: 'truck' }), contact: true, crossing: true, duration_seconds: 1.5,
    });
    const { warnings } = P.normalizeCuts([overloaded, row({ camera: camera({ size: 'insert' }), duration_seconds: 1.5 })], { scene: { ...scene, dialog_lines: [] }, dialogs });
    expect(warnings.filter((w) => /too much to render at that length/.test(w))).toHaveLength(1);
  });

  it('plan_cuts asks for the tempo, each length and the travel; the prompts carry the new rules', () => {
    const schema = P.PLAN_CUTS_TOOL.input_schema;
    expect(schema.required).toEqual(['tempo', 'cuts']);
    expect(Object.keys(schema.properties)[0]).toBe('tempo');
    expect(schema.properties.cuts.items.required).toContain('duration_seconds');
    expect(schema.properties.cuts.items.properties.camera.required).toEqual(expect.arrayContaining(['travel', 'travel_widths']));
    expect(JSON.stringify(P.PLAN_CUTS_TOOL)).not.toMatch(/"minimum"|"maximum"|load_notes/);
    expect(P.CUTS_SYSTEM_PROMPT).toMatch(/Tempo — the length of a cut is the editor's choice/);
    expect(P.CUTS_SYSTEM_PROMPT).toMatch(/Camera travel —/);
    expect(P.PROSE_SYSTEM_PROMPT).toMatch(/INATTENTION \+ PHYSICS/);
    expect(P.PROSE_SYSTEM_PROMPT).not.toMatch(/settles on the marquee"\)/);
    expect(P.START_FRAMES_SYSTEM_PROMPT).toMatch(/The pair — the two stills of a cut are ONE place/);
  });

  it('shows the tempo and the travel to the later passes, and the earlier scenes\' lengths to the next one', () => {
    const brief = P.formatSceneBrief({ order: 2, title: 'Lobby', tempo: 'quick inserts between two slow wides', directors_read: {}, scope: {} }, []);
    expect(brief).toContain('Tempo: quick inserts between two slow wides');
    const text = P.formatCutRow({ camera: camera({ movement: 'pan', motivation: 'finds the counter', travel: 'from the box office to the counter', travel_widths: 1 }), duration_seconds: 8 }, 0, []);
    expect(text).toContain('pan (finds the counter); travel: from the box office to the counter — 1 frame-width');
    expect(text).toContain('duration: 8 s');
    const user = P.buildCutsUserText({ scene: { order: 2, title: 'Lobby', directors_read: {}, scope: {} }, sceneIndex: 1, sceneCount: 2, priorDurations: [{ order: 1, title: 'Street', durations: [8, 1.5, 1.5, 2] }] });
    expect(user).toContain('Cut lengths so far in this beat');
    expect(user).toContain('- Scene 1 (Street): 8, 1.5, 1.5, 2 s');
    expect(P.buildCutsUserText({ scene: { order: 1, title: 'Street', directors_read: {}, scope: {} }, sceneIndex: 0, sceneCount: 2 })).not.toContain('Cut lengths so far');
  });
});

describe('applyReview (the editor + script supervisor pass)', () => {
  const LOCK = 'Same light: blue flicker from the screen. The boy: ten, red windbreaker, third seat from the aisle, facing the screen. Camera in the aisle.';
  const block = (action) => `Medium shot from the aisle at seated eye level, 50mm, the camera holding: ${action} ${LOCK} End with the bucket on its side at his shoe.`;
  const planned = () => [
    {
      cut_index: 1, duration_seconds: 4, camera: camera(), in_frame: [{ character: 'Kid', position: 'third seat', facing: 'the screen', acts: true }],
      dialog_lines: [], prompt: block('he lowers his hand and the popcorn pours out.'), lock_line: LOCK, exclusions: [],
      start_frame: { prompt: 'The boy in the red windbreaker holds the bucket.' }, end_frame: { prompt: 'Same frame. His hand is empty.', derive: true },
    },
    {
      cut_index: 2, duration_seconds: 4, camera: camera({ size: 'insert' }), in_frame: [], dialog_lines: [],
      prompt: 'Insert of two hands and a paper bucket crossing the counter.', lock_line: '', exclusions: [],
      start_frame: { prompt: 'The bucket half across the counter.' }, end_frame: { prompt: 'Same frame. The bucket in the far hands.', derive: true },
    },
  ];

  it('is a no-op when the model returned nothing', () => {
    const cuts = planned();
    const before = JSON.parse(JSON.stringify(cuts));
    expect(P.applyReview(null, cuts)).toEqual({ notes: [], warnings: [], changed: 0 });
    expect(P.applyReview([], cuts).changed).toBe(0);
    expect(cuts).toEqual(before);
  });

  it('applies new lengths and rewritten texts, keeps an empty string as "keep", and reports the issues', () => {
    const cuts = planned();
    const rewrite = block('the boy has forgotten the bucket in his hand — his eyes are fixed on the screen; his fingers loosen and the bucket tips out of his hand by accident, landing on its side on the carpet by his left shoe.');
    const { notes, warnings, changed } = P.applyReview([
      {
        cut_index: 1, duration_seconds: 3,
        issues: [{ kind: 'intent', note: 'The pour read as deliberate; rewritten as an accident.' }, { kind: 'frame_pair', note: 'The bucket vanished; the end still now shows it on the carpet.' }],
        prompt: rewrite, start_frame_prompt: '', end_frame_prompt: 'Same frame. The bucket lies on its side on the carpet by his left shoe; his empty hand hangs open.',
      },
      { cut_index: 2, duration_seconds: 1.5, issues: [{ kind: 'tempo', note: 'A handover is connective: quick.' }], prompt: '', start_frame_prompt: '', end_frame_prompt: '' },
    ], cuts, { sceneLabel: 'Scene 3' });
    expect(changed).toBe(2);
    expect(warnings).toEqual([]);
    expect(cuts[0].duration_seconds).toBe(3);
    expect(cuts[0].prompt).toBe(rewrite);
    expect(cuts[0].start_frame.prompt).toBe('The boy in the red windbreaker holds the bucket.');
    expect(cuts[0].end_frame.prompt).toMatch(/lies on its side on the carpet/);
    expect(cuts[0].end_frame.derive).toBe(true);
    expect(Array.isArray(cuts[0].lint)).toBe(true); // re-linted
    expect(cuts[1].duration_seconds).toBe(1.5);
    expect(cuts[1].prompt).toBe('Insert of two hands and a paper bucket crossing the counter.');
    expect(notes).toEqual([
      'Scene 3 cut 1: length 4 s → 3 s.',
      'Scene 3 cut 1 (intent): The pour read as deliberate; rewritten as an accident.',
      'Scene 3 cut 1 (frame pair): The bucket vanished; the end still now shows it on the carpet.',
      'Scene 3 cut 2: length 4 s → 1.5 s.',
      'Scene 3 cut 2 (tempo): A handover is connective: quick.',
    ]);
  });

  it('refuses a block rewrite that lost the lock line, and never shortens a cut below its speech', () => {
    const cuts = planned();
    const original = cuts[0].prompt;
    cuts[0].dialog_lines = [1];
    const dialogs = [{ _id: new ObjectId(), character: 'Kid', body: 'I waited for you for an hour and you did not even call me once' }];
    const { warnings } = P.applyReview([
      { cut_index: 1, duration_seconds: 1, issues: [], prompt: 'Medium shot: the bucket falls. End with the bucket on the floor.', start_frame_prompt: '', end_frame_prompt: '' },
    ], cuts, { dialogs });
    expect(cuts[0].prompt).toBe(original);
    expect(warnings).toEqual([expect.stringMatching(/rewrote the block without its lock line/)]);
    expect(cuts[0].duration_seconds).toBeGreaterThan(4);
  });

  it('the review tool is strict with no nullable or bounded fields, and the user text shows both stills', () => {
    expect(P.REVIEW_CUTS_TOOL.strict).toBe(true);
    expect(JSON.stringify(P.REVIEW_CUTS_TOOL)).not.toMatch(/"minimum"|"maximum"|"null"/);
    expect(P.REVIEW_CUTS_TOOL.input_schema.properties.cuts.items.required).toEqual(['cut_index', 'duration_seconds', 'issues', 'prompt', 'start_frame_prompt', 'end_frame_prompt']);
    expect(P.REVIEW_SYSTEM_PROMPT).toMatch(/# 4\. The pair/);
    const text = P.buildReviewUserText({ scene: { order: 3, title: 'Seats', tempo: 'quick', directors_read: {}, scope: {} }, cuts: planned(), priorDurations: [{ order: 1, title: 'Lobby', durations: [8, 1.5] }] });
    expect(text).toContain("This scene's cut lengths as planned: 4, 4 s");
    expect(text).toContain('- Scene 1 (Lobby): 8, 1.5 s');
    expect(text).toContain('start still: The boy in the red windbreaker holds the bucket.');
    expect(text).toContain('end still (held camera — a change list applied to the start still): Same frame. His hand is empty.');
  });
});

describe('applyProse / applyStartFrames', () => {
  it('binds a character in both stills to the start still\'s artwork', () => {
    const jacket = 'a'.repeat(24);
    const tshirt = 'b'.repeat(24);
    const d = 'd'.repeat(24);
    const groups = P.groupCatalogBySubject([
      { image_id: jacket, owner_type: 'character', owner_name: 'Kid', label: 'Kid — jacket', description: '' },
      { image_id: tshirt, owner_type: 'character', owner_name: 'Kid', label: 'Kid — t-shirt photo', description: '' },
      { image_id: d, owner_type: 'set', owner_name: 'Theatre', label: 'Theatre — interior', description: '' },
    ]);
    const cuts = [{ cut_index: 1, prompt: 'x', last_frame: 'y' }];
    const { warnings } = P.applyStartFrames([{
      cut_index: 1,
      start_frame_prompt: 'start', reference_picks: [{ subject: 'Kid', artwork_index: 1, use: 'look' }, { subject: 'Theatre', artwork_index: 1, use: 'look' }],
      end_frame_prompt: 'end', end_reference_picks: [{ subject: 'Kid', artwork_index: 2, use: 'look' }, { subject: 'Theatre', artwork_index: 1, use: 'look' }],
    }], cuts, { catalogGroups: groups });
    expect(cuts[0].start_frame.reference_ids).toEqual([jacket, d]);
    expect(cuts[0].end_frame.reference_ids).toEqual([jacket, d]);
    // No camera move on this row: the end frame is derived from the start frame.
    expect(cuts[0].end_frame.derive).toBe(true);
    expect(cuts[0].start_frame.derive).toBeUndefined();
    const moving = [{ cut_index: 1, prompt: 'x', last_frame: 'y', camera: camera({ movement: 'pan' }) }, { cut_index: 2, prompt: 'x', last_frame: 'y', camera: camera({ movement: 'handheld' }) }];
    P.applyStartFrames([
      { cut_index: 1, start_frame_prompt: 's', reference_picks: [], end_frame_prompt: 'e', end_reference_picks: [] },
      { cut_index: 2, start_frame_prompt: 's', reference_picks: [], end_frame_prompt: 'Same frame. Her hand is flat on the table.', end_reference_picks: [] },
    ], moving, { catalogGroups: groups });
    expect(moving.map((c) => c.end_frame.derive)).toEqual([false, true]);
    expect(warnings).toEqual([expect.stringMatching(/different artwork of Kid than the start frame/)]);
  });

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
    expect(calls).toEqual(['scenes', 'cuts', 'prose', 'start_frames', 'review', 'cuts', 'prose', 'start_frames', 'review']);
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

describe('startCutReplanJob (regenerate one cut)', () => {
  it('replans the one row with the scene as context, replaces it in place and leaves its neighbours alone', async () => {
    const { beat } = await seed();
    const s1 = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'One', setNames: ['Diner'], characterNames: ['Sarah'], floorPlan: 'plan' });
    const a = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: s1._id, cutIndex: 1, title: 'first', order: 1, prompt: 'Block one.' });
    const b = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: s1._id, cutIndex: 2, title: 'old middle', order: 2, durationSeconds: 5 });
    const c = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: s1._id, cutIndex: 3, title: 'last', order: 3 });
    const texts = {};
    P._setCutPlannerCallsForTests(async ({ pass, userText, cuts }) => {
      texts[pass] = userText;
      if (pass === 'cuts') return { cuts: [{ camera: camera(), in_frame: [{ character: 'Sarah', position: 'booth', facing: 'door', acts: true }], action_by: 'Sarah', reaction: false, eyeline: 'on the door', action: 'hurries', others: '', last_frame: 'x', sound: '', sound_on_action: false, crossing: false, contact: false, dialog_lines: [], sets_in_scene: ['Diner'], primary_spend: 'world', felt_intent: 'in a hurry', duration_seconds: 4 }] };
      expect(cuts).toHaveLength(1);
      expect(cuts[0].cut_index).toBe(2);
      if (pass === 'prose') return { cuts: [{ cut_index: 2, title: 'new middle', prompt: 'Wide shot. Same light: tubes. Sarah: coat, booth, facing the door. Camera at the counter end. End with her hands.', lock_line: 'Same light: tubes. Sarah: coat, booth, facing the door. Camera at the counter end.', reference_binding: '', exclusions: ['Do not show her face.'] }] };
      if (pass === 'start_frames') return { cuts: [{ cut_index: 2, start_frame_prompt: 'new still', end_frame_prompt: 'Same frame. Her hands open.', reference_picks: [] }] };
      return null;
    });
    const job = await waitJob(await P.startCutReplanJob({ projectId, cutId: String(b._id), note: 'She should be hurrying toward the door.' }));
    expect(job.status).toBe('done');
    expect(job.kind).toBe('recut');
    // The first pass sees the whole table, which row to replace, and the note.
    expect(texts.cuts).toContain('Replan ONE row');
    expect(texts.cuts).toContain('# The row to replace: cut 2');
    expect(texts.cuts).toContain('She should be hurrying toward the door.');
    expect(texts.cuts).toContain('Return exactly ONE row');
    // The later passes see the neighbours as fixed context.
    expect(texts.prose).toContain('cut 2 (return it with cut_index 2)');
    expect(texts.prose).toContain('block: Block one.');
    expect(texts.start_frames).toContain('The cuts around it (fixed');
    const rows = await VP.listVideoPrompts({ projectId, beatId: beat._id });
    expect(rows.map((r) => r.title)).toEqual(['first', 'new middle', 'last']);
    expect(rows.map((r) => r.order)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.cut_index)).toEqual([1, 2, 3]);
    expect(String(rows[0]._id)).toBe(String(a._id));
    expect(String(rows[2]._id)).toBe(String(c._id));
    expect(String(rows[1]._id)).not.toBe(String(b._id));
    expect(String(job.cut_id)).toBe(String(rows[1]._id));
    expect(rows[1]).toMatchObject({ duration_seconds: 4, felt_intent: 'in a hurry', exclusions: ['Do not show her face.'] });
    expect(rows[1].start_frame.prompt).toBe('new still');
    expect(rows[1].end_frame.prompt).toBe('Same frame. Her hands open.');
  });

  it('keeps the cut when the model returns no row, and refuses an unsorted cut or a busy beat', async () => {
    const { beat } = await seed();
    const s1 = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'One', setNames: ['Diner'], characterNames: ['Sarah'], floorPlan: 'plan' });
    const b = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: s1._id, cutIndex: 1, title: 'kept', order: 1 });
    const loose = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'loose', order: 2 });
    P._setCutPlannerCallsForTests(async () => ({ cuts: [] }));
    const job = await waitJob(await P.startCutReplanJob({ projectId, cutId: String(b._id) }));
    expect(job.status).toBe('done');
    expect(job.warnings.join(' ')).toMatch(/kept as it was/);
    expect((await VP.listVideoPrompts({ projectId, beatId: beat._id })).map((r) => String(r._id))).toContain(String(b._id));
    await expect(P.startCutReplanJob({ projectId, cutId: String(loose._id) })).rejects.toThrow(/no scene/);
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
      'cuts:1/2', 'prose:1/2', 'start_frame_prompts:1/2', 'review:1/2',
      'cuts:2/2', 'prose:2/2', 'start_frame_prompts:2/2', 'review:2/2',
      'writing',
    ]);
    // The seam returned no review: the plan is kept as written.
    expect(job.steps.find((s) => s.key === 'review:1/2').detail).toMatch(/no review returned/);
    expect(job.steps.every((s) => s.status === 'done')).toBe(true);
    expect(job.steps.find((s) => s.key === 'scenes').detail).toMatch(/2 scene/);
    expect(job.events.some((e) => /Shot table · scene 1\/2 — 2 cut/.test(e.text))).toBe(true);
    expect(job.events.at(-1).text).toMatch(/^✓ Done in \d+s — 2 scene/);
    expect(job.live).toBeNull();
    const last = snaps.at(-1);
    expect(last.status).toBe('done');
    expect(last).not.toHaveProperty('_notify');
    expect(JSON.parse(JSON.stringify(P.serializeCutPlanJob(job))).steps.length).toBe(11);
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

describe('coverage, continuation and montage', () => {
  const dialogs = [];
  const scene = { order: 1, title: 'Row', character_names: ['Sarah', 'Tom'], set_names: ['Diner'], dialog_lines: [] };
  const row = (over = {}) => ({
    camera: camera({ size: 'close_up', lens_mm: 85, side: 'from the aisle, on Sarah' }), in_frame: [{ character: 'Sarah', position: 'in the booth', facing: 'the door', acts: true }], action_by: 'Sarah',
    reaction: false, eyeline: 'the door', action: 'lifts the cup', others: '', last_frame: 'the cup at her mouth', sound: 'rain', sound_on_action: false, crossing: false, contact: false,
    dialog_lines: [], sets_in_scene: ['Diner'], primary_spend: 'identity', felt_intent: 'waiting', hook: 'her thumb whitens on the cup', continues_previous: false, duration_seconds: 3, ...over,
  });
  const reverse = () => row({ camera: camera({ size: 'wide', side: 'from her seat, looking at the door' }), in_frame: [{ character: 'Tom', position: 'in the doorway', facing: 'her', acts: true }], action_by: 'Tom', hook: 'rain runs off his sleeve onto the mat' });

  it('the schemas ask for the hook, the continuation flag, the scene kind and the montage subjects; the prompts carry the rules', () => {
    expect(P.PLAN_CUTS_TOOL.input_schema.properties.cuts.items.required).toEqual(expect.arrayContaining(['hook', 'continues_previous']));
    expect(P.BREAK_SCENES_TOOL.input_schema.properties.scenes.items.required).toEqual(expect.arrayContaining(['kind', 'montage_subjects']));
    expect(P.REVIEW_ISSUE_KINDS).toEqual(expect.arrayContaining(['coverage', 'continuity', 'hook']));
    expect(P.CUTS_SYSTEM_PROMPT).toMatch(/Coverage — every cut is a NEW camera setup/);
    expect(P.CUTS_SYSTEM_PROMPT).toMatch(/The hook — every cut has ONE thing the eye goes to/);
    expect(P.SCENES_SYSTEM_PROMPT).toMatch(/A montage has a JOB/);
    expect(P.REVIEW_SYSTEM_PROMPT).toMatch(/# 5\. From cut to cut/);
    expect(P.REVIEW_SYSTEM_PROMPT).toMatch(/# 6\. The hook/);
    expect(P.START_FRAMES_SYSTEM_PROMPT).toMatch(/IS the previous cut's end still/);
  });

  it('keeps the hook; a continuation is only kept on the same setup, never on the first row', () => {
    const { cuts, warnings } = P.normalizeCuts([row({ continues_previous: true }), row({ continues_previous: true }), { ...reverse(), continues_previous: true }], { scene, dialogs });
    expect(cuts.map((c) => c.continues_previous)).toEqual([false, true, false]);
    expect(cuts[0].hook).toBe('her thumb whitens on the cup');
    expect(warnings).toEqual(expect.arrayContaining([expect.stringMatching(/cut 3: marked as continuing the previous cut but it is a different camera setup/)]));
    // A single-cut replan judges the row against the fixed row before it.
    expect(P.normalizeCuts([row({ continues_previous: true })], { scene, dialogs, previous: cuts[0] }).cuts[0].continues_previous).toBe(true);
    expect(P.formatCutRow(cuts[1], 1, dialogs)).toContain('continues previous cut');
    expect(P.formatCutRow(cuts[1], 1, dialogs)).toContain('hook: her thumb whitens on the cup');
  });

  it('a montage: kind and subjects are kept and shown to the later passes; a blank or repeated hook is a warning', () => {
    const { scenes, warnings } = P.normalizeScenes(
      [
        { title: 'Summer', slug: 'EXT. TOWN — DAY', set_names: [], character_names: [], text_span: {}, directors_read: read('nowhere → 1994'), kind: 'montage', montage_subjects: ['three boys sharing one skateboard', ' '], intention: 'we are in 1994', scope, floor_plan: 'Main street.', dialog_lines: [] },
        { title: 'Empty', slug: '', set_names: [], character_names: [], text_span: {}, directors_read: read('x'), kind: 'montage', montage_subjects: [], intention: 'i', scope, floor_plan: 'f', dialog_lines: [] },
        { title: 'Diner', slug: '', set_names: [], character_names: [], text_span: {}, directors_read: read('x'), kind: 'whatever', montage_subjects: ['ignored'], intention: 'i', scope, floor_plan: 'f', dialog_lines: [] },
      ],
      { characters: [], sets: [], dialogs: [] },
    );
    expect(scenes.map((s) => s.kind)).toEqual(['montage', 'montage', 'scene']);
    expect(scenes[0].montage_subjects).toEqual(['three boys sharing one skateboard']);
    expect(scenes[2].montage_subjects).toEqual([]);
    expect(warnings).toEqual(expect.arrayContaining([expect.stringMatching(/Scene 2: a montage with no subjects listed/)]));
    const brief = P.formatSceneBrief(scenes[0], []);
    expect(brief).toContain('Kind: MONTAGE');
    expect(brief).toContain('three boys sharing one skateboard');
    expect(brief).toContain("Intention (the montage's job): we are in 1994");
    expect(P.sceneStillBrief(scenes[0])).toContain('Kind: MONTAGE');
    const m = P.normalizeCuts([row({ hook: '' }), { ...reverse(), hook: 'A dog takes the hot dog' }, row({ camera: camera({ size: 'insert', side: 'on the counter' }), hook: 'a dog takes the hot dog' })], { scene: { ...scene, kind: 'montage' }, dialogs });
    expect(m.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/cut 1: a montage cut with no hook/), expect.stringMatching(/cut 3: repeats an earlier cut's hook/)]));
  });

  it('a continuing cut takes the previous cut\'s end still as its start still (not a held camera\'s change list)', () => {
    const cuts = [
      { cut_index: 1, camera: camera({ movement: 'push_in' }), prompt: 'One.' },
      { cut_index: 2, camera: camera({ movement: 'push_in' }), prompt: 'Two.', continues_previous: true },
      { cut_index: 3, camera: camera(), prompt: 'Three.' },
      { cut_index: 4, camera: camera(), prompt: 'Four.', continues_previous: true },
    ];
    P.applyStartFrames(
      [1, 2, 3, 4].map((n) => ({ cut_index: n, start_frame_prompt: `Start ${n}.`, reference_picks: [], end_frame_prompt: n >= 3 ? `Same frame. Change ${n}.` : `End ${n}.`, end_reference_picks: [] })),
      cuts,
    );
    expect(cuts[1].start_frame.prompt).toBe('End 1.');
    expect(cuts[3].start_frame.prompt).toBe('Start 4.');
    // The review rewrote cut 1's end still: the chain follows it.
    cuts[0].end_frame.prompt = 'End 1, rewritten.';
    P.chainContinuationPrompts(cuts);
    expect(cuts[1].start_frame.prompt).toBe('End 1, rewritten.');
  });

  it('a table with two rows in a row on one setup is asked for once more, with the pair named; a table that still repeats is a warning', async () => {
    const { beat } = await seed();
    const sceneRaw = { title: 'Waiting', slug: 'INT. DINER — NIGHT', set_names: ['Diner'], character_names: ['Sarah', 'Tom'], text_span: { starts_with: 'Sarah waits', ends_with: 'dripping.' }, directors_read: read('waiting → leaving'), kind: 'scene', montage_subjects: [], intention: 'crack', scope, floor_plan: 'Booth left.', dialog_lines: [1, 2] };
    const calls = [];
    let fixed = true;
    P._setCutPlannerCallsForTests(async (args) => {
      calls.push(args);
      if (args.pass === 'scenes') return { scenes: [sceneRaw] };
      if (args.pass === 'cuts') return { tempo: 't', cuts: args.retry && fixed ? [row(), reverse()] : [row(), row({ action: 'drops the cup' })] };
      if (args.pass === 'prose') return { cuts: [] };
      if (args.pass === 'start_frames') return { cuts: [] };
      return null;
    });
    let job = await waitJob(await P.startCutPlanJob({ projectId, beatId: beat._id.toString() }));
    expect(job.status).toBe('done');
    expect(calls.map((c) => c.pass)).toEqual(['scenes', 'cuts', 'cuts', 'prose', 'start_frames', 'review']);
    expect(calls[2].userText).toContain('# Your first table was refused');
    expect(calls[2].userText).toContain('cuts 1 and 2 are the same camera setup');
    expect(job.warnings.filter((w) => /same camera setup/.test(w))).toEqual([]);
    let rows = await VP.listVideoPrompts({ projectId, beatId: beat._id });
    expect(rows.map((r) => r.action_by)).toEqual(['Sarah', 'Tom']);
    expect(rows[1].hook).toBe('rain runs off his sleeve onto the mat');
    // The retry did not fix it: the first table is kept and the job warns.
    fixed = false;
    calls.length = 0;
    job = await waitJob(await P.startCutPlanJob({ projectId, beatId: beat._id.toString() }));
    expect(calls.filter((c) => c.pass === 'cuts')).toHaveLength(2);
    expect(job.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/Scene 1 cut 2: the same camera setup as cut 1/)]));
    rows = await VP.listVideoPrompts({ projectId, beatId: beat._id });
    expect(rows).toHaveLength(2);
  });

  it('a deliberate continuation is saved on the cut and is not re-asked', async () => {
    const { beat } = await seed();
    const sceneRaw = { title: 'Waiting', slug: '', set_names: ['Diner'], character_names: ['Sarah', 'Tom'], text_span: {}, directors_read: read('x'), kind: 'montage', montage_subjects: ['the undrunk cup'], intention: 'crack', scope, floor_plan: 'Booth left.', dialog_lines: [1, 2] };
    const passes = [];
    P._setCutPlannerCallsForTests(async (args) => {
      passes.push(args.pass);
      if (args.pass === 'scenes') return { scenes: [sceneRaw] };
      if (args.pass === 'cuts') return { tempo: 't', cuts: [row(), row({ continues_previous: true, hook: 'the cup tips' })] };
      return args.pass === 'review' ? null : { cuts: [] };
    });
    const job = await waitJob(await P.startCutPlanJob({ projectId, beatId: beat._id.toString() }));
    expect(job.status).toBe('done');
    expect(passes.filter((p) => p === 'cuts')).toHaveLength(1);
    const rows = await VP.listVideoPrompts({ projectId, beatId: beat._id });
    expect(rows.map((r) => r.continues_previous)).toEqual([false, true]);
    const [stored] = await VS.listVideoScenes({ projectId, beatId: beat._id });
    expect(stored).toMatchObject({ kind: 'montage', montage_subjects: ['the undrunk cup'] });
  });
});
