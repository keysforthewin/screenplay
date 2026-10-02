// Pure load-score tests for scene → cut planning (docs/video-prompting-notes.md
// §1 Step 5). No Mongo, no LLM.
import { describe, it, expect } from 'vitest';
import {
  LOAD_POINTS,
  LOAD_VERDICTS,
  cutBeats,
  cutLoadPoints,
  estimateCutDuration,
  sceneLoad,
  loadVerdict,
  speechFloorSeconds,
} from '../src/web/cutLoad.js';

const sixWords = (character) => ({ character, body: 'One two three four five six.' });

function cut(overrides = {}) {
  return {
    camera: { size: 'medium', movement: 'static' },
    in_frame: [{ character: 'Sarah', position: 'in the booth', facing: 'the door' }],
    action_by: 'Sarah',
    reaction: false,
    crossing: false,
    contact: false,
    sound_on_action: false,
    duration_seconds: null,
    ...overrides,
  };
}

describe('cutBeats', () => {
  it('is one beat for an ordinary cut', () => {
    expect(cutBeats(cut())).toBe(1);
  });
  it('counts reactions and inserts as half a beat', () => {
    expect(cutBeats(cut({ reaction: true }))).toBe(0.5);
    expect(cutBeats(cut({ camera: { size: 'insert', movement: 'static' } }))).toBe(0.5);
  });
});

describe('cutLoadPoints', () => {
  it('adds nothing for a static one-person cut with no lines', () => {
    const r = cutLoadPoints(cut());
    expect(r).toEqual({ beats: 1, load: 0, breakdown: [] });
  });

  it('charges half a point for a camera move and nothing for static', () => {
    const moving = cutLoadPoints(cut({ camera: { size: 'medium', movement: 'push_in' } }));
    expect(moving.load).toBe(LOAD_POINTS.camera_move);
    expect(moving.breakdown[0].code).toBe('camera_move');
    expect(cutLoadPoints(cut({ camera: { size: 'medium', movement: 'static' } })).load).toBe(0);
  });

  it('charges one point per 8 words per line, minimum one', () => {
    const short = cutLoadPoints(cut(), { coveredDialogs: [{ character: 'Tom', body: 'Go.' }] });
    expect(short.load).toBe(1);
    const long = cutLoadPoints(cut(), {
      coveredDialogs: [{ character: 'Tom', body: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen' }],
    });
    expect(long.load).toBe(3); // 17 words → ceil(17/8)
    expect(long.breakdown[0]).toMatchObject({ code: 'line', points: 3 });
  });

  it('charges a held second person half and an acting principal one', () => {
    const held = cutLoadPoints(
      cut({ in_frame: [{ character: 'Sarah' }, { character: 'Tom' }], action_by: 'Sarah' }),
    );
    expect(held.load).toBe(LOAD_POINTS.held_principal);
    expect(held.breakdown[0]).toMatchObject({ code: 'held_principal', note: 'Tom holds or reacts' });
    const acting = cutLoadPoints(
      cut({ in_frame: [{ character: 'Sarah' }, { character: 'Tom', acts: true }], action_by: 'Sarah' }),
    );
    expect(acting.load).toBe(LOAD_POINTS.acting_principal);
    expect(acting.breakdown[0].code).toBe('acting_principal');
  });

  it('treats the first principal as the actor when action_by is blank or unknown', () => {
    const r = cutLoadPoints(cut({ in_frame: [{ character: 'Sarah' }, { character: 'Tom' }], action_by: '' }));
    expect(r.breakdown.map((b) => b.note)).toEqual(['Tom holds or reacts']);
    const unknown = cutLoadPoints(
      cut({ in_frame: [{ character: 'Sarah' }, { character: 'Tom' }], action_by: 'Waitress' }),
    );
    expect(unknown.breakdown.map((b) => b.note)).toEqual(['Tom holds or reacts']);
  });

  it('charges contact, a crossing and a sound cue on an action', () => {
    const r = cutLoadPoints(cut({ contact: true, crossing: true, sound_on_action: true }));
    expect(r.load).toBe(1 + 2 + 0.5);
    expect(r.breakdown.map((b) => b.code)).toEqual(['contact', 'location_change', 'sound_on_action']);
  });
});

describe('estimateCutDuration', () => {
  it('gives a static one-person cut with no dialogue 3 seconds', () => {
    expect(estimateCutDuration(cut())).toBe(3);
  });

  it('derives seconds from beats + load at 3 s per unit', () => {
    // one line (1) + held second person (0.5) → (1 + 1.5) × 3 = 7.5 → 8
    const c = cut({ in_frame: [{ character: 'Sarah' }, { character: 'Tom' }], action_by: 'Sarah' });
    expect(estimateCutDuration(c, { coveredDialogs: [sixWords('Sarah')] })).toBe(8);
  });

  it('lets a recorded line win over the word estimate', () => {
    const twentyWords = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');
    const unrecorded = estimateCutDuration(cut(), { coveredDialogs: [{ character: 'Tom', body: twentyWords }] });
    expect(unrecorded).toBe(12); // ceil(20/8) = 3 load → (1 + 3) × 3
    const recorded = estimateCutDuration(cut(), {
      coveredDialogs: [{ character: 'Tom', body: twentyWords, audio_file_id: 'f1', audio_duration_seconds: 4.2 }],
    });
    expect(recorded).toBe(5); // ceil(4.2 + 0.6)
  });

  it('adds the speech estimate for unrecorded lines next to a recorded one', () => {
    const r = estimateCutDuration(cut(), {
      coveredDialogs: [
        { character: 'Tom', body: 'Let it go, Tom, please.', audio_file_id: 'f1', audio_duration_seconds: 4.2 },
        { character: 'Sarah', body: 'One two three four five.' }, // 5/2.5 + 0.35 + 0.5 = 2.85
      ],
    });
    expect(r).toBe(Math.ceil(4.2 + 2.85 + 0.6));
  });

  it('clamps to the min and max', () => {
    const heavy = cut({
      camera: { size: 'wide', movement: 'track' },
      in_frame: [{ character: 'A' }, { character: 'B' }, { character: 'C' }, { character: 'D' }],
      action_by: 'A',
      crossing: true,
      contact: true,
    });
    expect(estimateCutDuration(heavy)).toBe(15);
    expect(estimateCutDuration(cut({ reaction: true }))).toBe(3);
    expect(estimateCutDuration(heavy, { max: 30 })).toBe(Math.ceil(3 * (1 + 0.5 + 1.5 + 2 + 1)));
  });
});

describe('sceneLoad', () => {
  it("reproduces the notes' worked case: 15 s, two people, two six-word lines, one hold → beats 3, load 3, S 2.5", () => {
    const two = [{ character: 'A' }, { character: 'B' }];
    const cuts = [
      { _id: 'c1', ...cut({ in_frame: two, action_by: 'A', duration_seconds: 6 }) },
      { _id: 'c2', ...cut({ in_frame: two, action_by: 'B', duration_seconds: 6 }) },
      // The hold on whoever lost — a full beat. (A cut flagged reaction: true
      // counts half a beat; see cutBeats.)
      { _id: 'c3', ...cut({ in_frame: [{ character: 'A' }], action_by: 'A', duration_seconds: 3 }) },
    ];
    const byCut = new Map([
      ['c1', [sixWords('A')]],
      ['c2', [sixWords('B')]],
    ]);
    const r = sceneLoad(cuts, { coveredDialogsByCut: byCut });
    expect(r.beats).toBe(3);
    expect(r.load_points).toBe(3);
    expect(r.total_seconds).toBe(15);
    expect(r.s).toBeCloseTo(2.5, 5);
    expect(r.verdict).toBe('stretch');
  });

  it("reproduces the diner example: 5 beats, one line, two held seconds → S ≈ 2.1 stretch", () => {
    const cuts = [
      cut({ camera: { size: 'wide', movement: 'static' }, in_frame: [{ character: 'Tom' }], action_by: 'Tom', duration_seconds: 3 }),
      cut({ in_frame: [{ character: 'Tom' }, { character: 'Sarah' }], action_by: 'Tom', duration_seconds: 3 }),
      cut({ camera: { size: 'close_up', movement: 'static' }, in_frame: [{ character: 'Sarah' }, { character: 'Tom' }], action_by: 'Sarah', duration_seconds: 3 }),
      cut({ camera: { size: 'close_up', movement: 'static' }, in_frame: [{ character: 'Tom' }], action_by: 'Tom', duration_seconds: 3 }),
      cut({ camera: { size: 'wide', movement: 'static' }, in_frame: [{ character: 'Sarah' }], action_by: 'Sarah', duration_seconds: 3 }),
    ];
    // Cuts without _id are keyed by array index.
    const byCut = new Map([[1, [{ character: 'Tom', body: 'I am so sorry I got held up' }]]]);
    const r = sceneLoad(cuts, { coveredDialogsByCut: byCut });
    expect(r.beats).toBe(5);
    expect(r.load_points).toBe(2);
    expect(r.total_seconds).toBe(15);
    expect(r.s).toBeCloseTo(15 / 7, 2);
    expect(r.verdict).toBe('stretch');
  });

  it('falls back to the estimated duration when a cut has none, and returns 0 for an empty scene', () => {
    const r = sceneLoad([cut()]);
    expect(r.total_seconds).toBe(3);
    expect(r.s).toBe(3);
    expect(r.verdict).toBe('safe');
    expect(sceneLoad([])).toEqual({ beats: 0, load_points: 0, total_seconds: 0, s: 0, verdict: 'ambitious' });
  });

  it('classifies verdicts at the 3 and 2 second boundaries', () => {
    expect(loadVerdict(3)).toBe('safe');
    expect(loadVerdict(2.99)).toBe('stretch');
    expect(loadVerdict(2)).toBe('stretch');
    expect(loadVerdict(1.99)).toBe('ambitious');
    expect(LOAD_VERDICTS).toEqual(['safe', 'stretch', 'ambitious']);
  });
});

describe('speechFloorSeconds', () => {
  it('is 0 for a cut that covers no line', () => {
    expect(speechFloorSeconds([])).toBe(0);
    expect(speechFloorSeconds(undefined)).toBe(0);
  });

  it('is the recorded speech plus the tail, rounded up to half a second', () => {
    const recorded = { character: 'Sarah', body: 'Do not.', audio_file_id: 'a'.repeat(24), audio_duration_seconds: 2.1 };
    const floor = speechFloorSeconds([recorded]);
    expect(floor * 2).toBe(Math.round(floor * 2)); // a half-second step
    expect(floor).toBeGreaterThanOrEqual(2.7);
    expect(floor).toBeLessThanOrEqual(3.5);
  });

  it('estimates an unrecorded line', () => {
    expect(speechFloorSeconds([sixWords('Tom')])).toBeGreaterThan(2);
  });
});
