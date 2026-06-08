import { describe, it, expect, afterEach } from 'vitest';
import {
  buildShotCritiqueContext,
  critiquePanel,
  _setLensJudgeForTests,
} from '../src/web/storyboardCritique.js';

afterEach(() => _setLensJudgeForTests(null));

describe('buildShotCritiqueContext', () => {
  it('includes the bible block, director notes, the shot prompts, and neighbors', () => {
    const text = buildShotCritiqueContext({
      sceneBible: { location: 'Diner', mood: 'tense' },
      directorNotes: [{ text: 'Keep it cold and quiet.' }],
      shot: { order: 2, summary: 'Sarah looks up', text_prompt: 'She lifts her gaze. Camera holds.', startFramePrompt: 'Sarah at the counter, medium shot.', shot_type: 'close_up' },
      prevShot: { order: 1, summary: 'Wide of the diner', startFramePrompt: 'Empty diner, establishing.' },
      nextShot: null,
    });
    expect(text).toContain('Diner');
    expect(text).toContain('Keep it cold and quiet.');
    expect(text).toContain('She lifts her gaze');
    expect(text).toContain('Sarah at the counter');
    expect(text).toContain('Empty diner');
  });
});

describe('critiquePanel', () => {
  it('runs all four lenses and aggregates (strict cap)', async () => {
    _setLensJudgeForTests(async ({ lens }) => {
      const score = lens.key === 'bible' ? 2 : 9;
      return { score, comments: `${lens.key} says ${score}` };
    });
    const result = await critiquePanel({
      target: 'prompt',
      sceneBible: { location: 'Diner' },
      directorNotes: [],
      shot: { order: 1, summary: 's', text_prompt: 'tp', startFramePrompt: 'sf' },
      prevShot: null,
      nextShot: null,
    });
    expect(result.lenses).toHaveLength(4);
    expect(result.lenses.map((l) => l.lens).sort()).toEqual(
      ['bible', 'cinematic', 'continuity', 'director_notes'],
    );
    expect(result.overall).toBe(2);
    expect(result.lowest_lens).toBe('bible');
    expect(typeof result.model).toBe('string');
    expect(result.created_at).toBeInstanceOf(Date);
    _setLensJudgeForTests(null);
  });

  it('passes the image buffer to the judge on the image tier', async () => {
    let sawImage = false;
    _setLensJudgeForTests(async ({ imageInput }) => {
      if (imageInput && imageInput.buffer) sawImage = true;
      return { score: 6, comments: 'ok' };
    });
    await critiquePanel({
      target: 'image',
      sceneBible: {},
      directorNotes: [],
      shot: { order: 1, summary: 's', text_prompt: 'tp', startFramePrompt: 'sf' },
      prevShot: null,
      nextShot: null,
      imageInput: { buffer: Buffer.from('x'), contentType: 'image/png' },
    });
    expect(sawImage).toBe(true);
    _setLensJudgeForTests(null);
  });

  it('excludes an errored lens from the aggregate (no false critical)', async () => {
    _setLensJudgeForTests(async ({ lens }) => {
      if (lens.key === 'bible') return { score: 1, comments: 'boom', error: true };
      return { score: 8, comments: 'fine' };
    });
    const result = await critiquePanel({
      target: 'prompt',
      sceneBible: {},
      directorNotes: [],
      shot: { order: 1, summary: 's', text_prompt: 'tp', startFramePrompt: 'sf' },
      prevShot: null,
      nextShot: null,
    });
    // all four lenses still listed; the errored one carries error:true
    expect(result.lenses).toHaveLength(4);
    const bible = result.lenses.find((l) => l.lens === 'bible');
    expect(bible.error).toBe(true);
    // overall reflects ONLY the three successful 8s — NOT capped to 1
    expect(result.overall).toBe(8);
    expect(result.lowest_lens).not.toBe('bible');
    _setLensJudgeForTests(null);
  });
});
