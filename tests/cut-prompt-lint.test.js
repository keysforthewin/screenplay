// Pure lint tests for a cut's prose block (docs/video-prompting-notes.md §2,
// §3, §4, §7). No Mongo, no LLM.
import { describe, it, expect } from 'vitest';
import {
  TRAP_PHRASES,
  EMPTY_EVALUATORS,
  IMAGE_MODEL_TOKENS,
  FEELING_WORDS,
  ALLOWED_NEGATIONS,
  lintCut,
  summarizeLint,
} from '../src/web/cutPromptLint.js';

// Modelled on the notes' Shot 3 of the diner conversion.
const LOCK =
  'Same light: orange sodium light on her face through the window, warm tubes behind. ' +
  'Sarah: thirties, dark hair tied back, grey wool coat, seated in the window booth, facing the window. ' +
  'Tom: thirties, short beard, black raincoat, seated opposite her, facing her. Camera on Tom\'s side of the table.';

const CLEAN_PROMPT =
  "Close shot of Sarah from Tom's side of the table, at eye level, 85mm, his shoulder soft in the foreground; the camera holds. " +
  'Hurt and holding it, her eyes stay on the window; her thumb presses white against the cup; she pushes the full cup one inch toward him and lets go. ' +
  'Tom keeps both hands open on the table and the waitress keeps wiping the counter. ' +
  'Sound: rain on the glass, the hum of the ceiling tubes; no music. ' +
  `${LOCK} ` +
  'End with her hand flat on the table beside the cup.';

const IN_FRAME = [
  { character: 'Sarah', position: 'in the window booth', facing: 'the window' },
  { character: 'Tom', position: 'opposite her', facing: 'her' },
];

function cleanCut(overrides = {}) {
  return { prompt: CLEAN_PROMPT, lock_line: LOCK, exclusions: [], in_frame: IN_FRAME, ...overrides };
}

// Swap the sentence before the lock line for `extra` so length and structure
// stay valid while one rule is exercised.
function withSentence(extra) {
  return cleanCut({ prompt: CLEAN_PROMPT.replace('Tom keeps both hands open on the table and the waitress keeps wiping the counter.', extra) });
}

const codes = (findings) => findings.map((f) => f.code);

describe('lintCut — clean block', () => {
  it('returns no findings for a block with a full lock line and an ending', () => {
    expect(lintCut(cleanCut())).toEqual([]);
  });

  it('exports the notes\' lists verbatim', () => {
    expect(TRAP_PHRASES).toContain('his face fell');
    expect(TRAP_PHRASES).toContain('nobody moves');
    expect(TRAP_PHRASES).toHaveLength(14);
    expect(EMPTY_EVALUATORS).toContain('cinematic');
    expect(IMAGE_MODEL_TOKENS).toContain('8K');
    expect(FEELING_WORDS).toContain('furious');
    expect(ALLOWED_NEGATIONS).toContain('no music during the line');
  });
});

describe('lintCut — trap phrases and feelings', () => {
  it('flags each distinct trap phrase once, case-insensitively', () => {
    const r = lintCut(withSentence('His Face Fell and his face fell again; the air freezes.'));
    const traps = r.filter((f) => f.code === 'trap_phrase');
    expect(traps).toHaveLength(2);
    expect(traps[0].message).toMatch(/his face fell/);
    expect(traps[1].message).toMatch(/the air freezes/);
  });

  it('flags a bare feeling after a copula, before a mood noun, or as an adverb', () => {
    expect(codes(lintCut(withSentence('Tom is furious and looks at the cup.')))).toContain('bare_feeling');
    expect(codes(lintCut(withSentence('A tense silence sits over the table.')))).toContain('bare_feeling');
    expect(codes(lintCut(withSentence('Tom answers nervously and looks at the cup.')))).toContain('bare_feeling');
    const r = lintCut(withSentence('Tom feels very sad.'));
    expect(r.find((f) => f.code === 'bare_feeling').message).toMatch(/label on an anchor/);
  });

  it('allows the feeling as a label on an anchor (feeling word followed by a comma)', () => {
    const r = lintCut(withSentence('Embarrassed, the polite smile fades and he swallows.'));
    expect(codes(r)).not.toContain('bare_feeling');
    const copula = lintCut(withSentence('He is embarrassed, the polite smile fades and he swallows.'));
    expect(codes(copula)).not.toContain('bare_feeling');
  });
});

describe('lintCut — block shape', () => {
  it('flags brackets and timestamps', () => {
    expect(codes(lintCut(withSentence('[Medium two-shot, slow push in] Tom leans in over the table.')))).toContain('bracket');
    expect(codes(lintCut(withSentence('Tom leans in over the table for the first 8 seconds.')))).toContain('timestamp');
    expect(codes(lintCut(withSentence('Tom holds the look for 2 s and looks away.')))).toContain('timestamp');
    expect(codes(lintCut(withSentence('Tom leans in at 0:04 and looks away.')))).toContain('timestamp');
    // A decade is not a length.
    expect(codes(lintCut(withSentence('Tom leans on a boxy 1980s sedan beside an \'80s arcade cabinet from the 70s.')))).not.toContain('timestamp');
    expect(codes(lintCut(withSentence('Tom leans on a boxy 1980s sedan for 80s.')))).toContain('timestamp');
    // A lens length is not a timestamp.
    expect(codes(lintCut(withSentence('Tom leans in over the table, 50mm, and looks away.')))).not.toContain('timestamp');
  });

  it('flags empty evaluators and image-model tokens once per distinct hit', () => {
    const r = lintCut(withSentence('A cinematic, dramatic, cinematic push toward the table in 8K, photorealistic.'));
    expect(r.filter((f) => f.code === 'empty_evaluator').map((f) => f.message)).toEqual([
      expect.stringMatching(/"cinematic"/),
      expect.stringMatching(/"dramatic"/),
    ]);
    expect(r.filter((f) => f.code === 'image_model_token')).toHaveLength(2);
  });

  it('flags negation in the body but not the sanctioned phrases, the lock line or an exclusion', () => {
    const neg = lintCut(withSentence('Tom does not look at her and nothing on the table moves.'));
    const found = neg.filter((f) => f.code === 'negation_in_body');
    expect(found).toHaveLength(1);
    expect(found[0].message).toMatch(/Tom does not look at her/);

    // "no music during the line" is allowed.
    const allowed = lintCut(withSentence('Tom speaks quietly, every word clear, no music during the line.'));
    expect(codes(allowed)).not.toContain('negation_in_body');

    // An exclusion sentence present in exclusions[] is allowed.
    const exclusion = 'Do not show the door opening yet.';
    const excluded = lintCut({
      ...cleanCut({ exclusions: [exclusion] }),
      prompt: CLEAN_PROMPT.replace('End with', `${exclusion} End with`),
    });
    expect(codes(excluded)).not.toContain('negation_in_body');
    // …and the same sentence without the exclusions entry is flagged.
    const notExcluded = lintCut({ ...cleanCut(), prompt: CLEAN_PROMPT.replace('End with', `${exclusion} End with`) });
    expect(codes(notExcluded)).toContain('negation_in_body');
  });

  it('reports the same negated sentence only once', () => {
    const twice = 'Tom does not look at her.';
    const r = lintCut(withSentence(`${twice} ${twice}`));
    expect(r.filter((f) => f.code === 'negation_in_body')).toHaveLength(1);
  });
});

describe('lintCut — lock line', () => {
  it('flags a missing lock line and a lock line absent from the prompt', () => {
    expect(codes(lintCut(cleanCut({ lock_line: '' })))).toContain('lock_line_missing');
    const absent = lintCut(cleanCut({ prompt: CLEAN_PROMPT.replace(LOCK, 'She waits.') }));
    expect(codes(absent)).toContain('lock_line_missing');
    // Whitespace differences do not count as absence.
    const spaced = lintCut(cleanCut({ lock_line: LOCK.replace(/ /g, '  ') }));
    expect(codes(spaced)).not.toContain('lock_line_missing');
  });

  it('checks the lock line for light, each principal, facing and the camera side', () => {
    // "window" counts as a light word, so this lock line keeps to the booth and the door.
    const noLight = 'Sarah: seated in the booth, facing the door. Tom: seated opposite her, facing her. Camera on Tom\'s side.';
    const r = lintCut(cleanCut({ lock_line: noLight, prompt: CLEAN_PROMPT.replace(LOCK, noLight) }));
    expect(codes(r)).toContain('lock_line_light');
    expect(codes(r)).not.toContain('lock_line_principal');
    expect(codes(r)).not.toContain('lock_line_facing');
    expect(codes(r)).not.toContain('lock_line_camera_side');

    const missingTom = 'Same light: warm tubes overhead. Sarah: grey wool coat, seated in the window booth, facing the window. Camera on the counter side.';
    const r2 = lintCut(cleanCut({ lock_line: missingTom, prompt: CLEAN_PROMPT.replace(LOCK, missingTom) }));
    const principal = r2.filter((f) => f.code === 'lock_line_principal');
    expect(principal).toHaveLength(1);
    expect(principal[0].message).toMatch(/Tom/);

    const noFacingNoCamera = 'Same light: warm tubes overhead. Sarah: seated in the window booth. Tom: seated opposite her.';
    const r3 = lintCut(cleanCut({ lock_line: noFacingNoCamera, prompt: CLEAN_PROMPT.replace(LOCK, noFacingNoCamera) }));
    expect(codes(r3)).toContain('lock_line_facing');
    expect(codes(r3)).toContain('lock_line_camera_side');
  });

  it('matches principals by first name token, case-insensitively', () => {
    const inFrame = [{ character: '**Tom Baker**' }, { character: 'Sarah' }];
    const lock = 'Same light: warm tubes overhead. TOM: black raincoat, seated opposite her, facing her. Sarah: seated, facing the window. Camera on the counter side.';
    const r = lintCut(cleanCut({ in_frame: inFrame, lock_line: lock, prompt: CLEAN_PROMPT.replace(LOCK, lock) }));
    expect(codes(r)).not.toContain('lock_line_principal');
  });
});

describe('lintCut — ending', () => {
  it('flags a missing ending, a fade, and an involuntary endpoint', () => {
    const noEnd = lintCut(cleanCut({ prompt: CLEAN_PROMPT.replace('End with her hand flat on the table beside the cup.', 'She looks down at the cup.') }));
    expect(codes(noEnd)).toContain('ending_missing');
    expect(codes(lintCut(cleanCut({ prompt: `${CLEAN_PROMPT} Fade out.` })))).toContain('fade_out');
    const slip = lintCut(cleanCut({ prompt: CLEAN_PROMPT.replace('End with her hand flat on the table beside the cup.', 'End with her as she slips on the wet floor.') }));
    expect(codes(slip)).toContain('involuntary_endpoint');
    // An involuntary verb earlier in the block is not the endpoint.
    const earlier = lintCut(withSentence('Tom spills a little water from his sleeve onto the table.'));
    expect(codes(earlier)).not.toContain('involuntary_endpoint');
  });

  it('accepts an accident written in the accident form as the endpoint', () => {
    const accident = lintCut(cleanCut({ prompt: CLEAN_PROMPT.replace('End with her hand flat on the table beside the cup.', 'End with the cup on its side where it spills by accident.') }));
    expect(codes(accident)).not.toContain('involuntary_endpoint');
  });

  it('accepts every ending form', () => {
    for (const ending of ['Stop when her hand settles.', 'Hold on this frame as the door swings.', 'End on the empty seat.']) {
      const r = lintCut(cleanCut({ prompt: CLEAN_PROMPT.replace('End with her hand flat on the table beside the cup.', ending) }));
      expect(codes(r)).not.toContain('ending_missing');
    }
  });
});

describe('lintCut — dialogue words and length', () => {
  const line = { character: 'Tom', body: "It's my father's boat, Sarah." };

  it('flags a covered line whose words appear in the prompt, naming the speaker', () => {
    const r = lintCut(withSentence("Tom leans in and says it's my father's boat, Sarah, quiet and fast."), { coveredDialogs: [line] });
    const hit = r.filter((f) => f.code === 'dialogue_words');
    expect(hit).toHaveLength(1);
    expect(hit[0].message).toMatch(/^Tom's line/);
  });

  it('flags a five-word run of a longer line and ignores lines under four words', () => {
    const long = { character: 'Sarah', body: 'I waited for you in this booth for an hour and you never came.' };
    const r = lintCut(withSentence('Sarah says she waited for you in this booth and looks away.'), { coveredDialogs: [long] });
    expect(codes(r)).toContain('dialogue_words');
    const short = { character: 'Tom', body: 'Let it go.' };
    const r2 = lintCut(withSentence('Tom says let it go and looks at the cup.'), { coveredDialogs: [short] });
    expect(codes(r2)).not.toContain('dialogue_words');
    expect(codes(lintCut(cleanCut(), { coveredDialogs: [line] }))).not.toContain('dialogue_words');
  });

  it('flags blocks that are too long or too short', () => {
    const padding = Array.from({ length: 230 }, () => 'again').join(' ');
    expect(codes(lintCut(cleanCut({ prompt: `${CLEAN_PROMPT} ${padding}` })))).toContain('too_long');
    const tiny = 'Close shot of Sarah. End with her hand on the cup.';
    const r = lintCut(cleanCut({ prompt: tiny }));
    expect(codes(r)).toContain('too_short');
    expect(codes(r)).not.toContain('too_long');
  });
});

describe('summarizeLint', () => {
  it('counts findings by code', () => {
    const r = lintCut(withSentence('[Two-shot] Tom is furious; his face fell.'));
    const s = summarizeLint(r);
    expect(s.count).toBe(r.length);
    expect(s.codes.bracket).toBe(1);
    expect(s.codes.bare_feeling).toBe(1);
    expect(s.codes.trap_phrase).toBe(1);
    expect(summarizeLint([])).toEqual({ count: 0, codes: {} });
  });
});

describe('lintCut — a travelling camera', () => {
  const LOCK_PAN = 'Same light: warm amber sconces along the walls. Camera at the lobby doors.';
  const pan = (move, extra = {}) =>
    lintCut({
      prompt: `Wide shot from the lobby doors at eye level, 24mm, ${move} A dozen people cross the red carpet in ones and twos, coats over their arms, while an attendant behind the glass counter fills a paper bucket at the popper. Sound: the popper rattling, low talk. ${LOCK_PAN} End with the counter filling the right half of the frame.`,
      lock_line: LOCK_PAN,
      exclusions: [],
      in_frame: [],
      camera: { movement: 'pan', travel_widths: 0.5 },
      duration_seconds: 8,
      ...extra,
    });

  it('is clean when the move has one even speed and keeps travelling', () => {
    expect(codes(pan('the camera already panning right at one slow, even speed from the box office toward the counter:'))).toEqual([]);
  });

  it('flags a move that is told to settle, and one with no speed', () => {
    const braked = pan('the camera pans right from the box office and settles on the counter:');
    expect(codes(braked)).toEqual(expect.arrayContaining(['camera_settle', 'camera_speed_missing']));
    expect(codes(pan('the camera pans slowly right and comes to rest on the counter:'))).toEqual(['camera_settle']);
  });

  it('flags a sweep too fast for its length', () => {
    const fast = pan('the camera already panning right at one slow, even speed across the whole lobby:', { camera: { movement: 'pan', travel_widths: 3 }, duration_seconds: 4 });
    expect(codes(fast)).toEqual(['camera_fast', 'pan_no_overlap']);
    expect(fast[0].message).toMatch(/3 frame-widths in 4 s/);
  });

  it('flags a sliding move whose two stills would not overlap', () => {
    const wide = pan('the camera already panning right at one slow, even speed from the box office toward the counter:', { camera: { movement: 'pan', travel_widths: 1 } });
    expect(codes(wide)).toEqual(['pan_no_overlap']);
    const push = pan('the camera already pushing in at one slow, even speed toward the counter:', { camera: { movement: 'push_in', travel_widths: 1 } });
    expect(codes(push)).not.toContain('pan_no_overlap');
  });

  it('never applies to a held camera', () => {
    const held = pan('the camera holding as a hand settles on the counter:', { camera: { movement: 'static' } });
    expect(codes(held)).toEqual([]);
  });
});
