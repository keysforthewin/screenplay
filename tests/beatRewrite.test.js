import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// beatRewrite → gateway pulls in the announce helpers; stub them (same as the
// route tests) so importing the gateway tree is side-effect-free.
vi.mock('../src/web/announceHelpers.js', () => ({
  announceBeatMedia: vi.fn(), announceCharacterMedia: vi.fn(), announceNoteMedia: vi.fn(),
  announceStoryboardMedia: vi.fn(), announceLibraryMedia: vi.fn(), announceBatchSummary: vi.fn(),
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const C = await import('../src/mongo/critiques.js');
const { _setAnthropicClientForTests } = await import('../src/anthropic/client.js');
const R = await import('../src/web/beatRewrite.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('P'))._id.toString();
  // Stub Anthropic: analyzeText returns the text content.
  _setAnthropicClientForTests({
    messages: { create: async () => ({ content: [{ type: 'text', text: 'REWRITTEN' }] }) },
  });
});
afterEach(() => { _setAnthropicClientForTests(null); });

describe('normalizeBeat', () => {
  it('stashes the old body and writes the rewrite', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'prose body' });
    const res = await R.normalizeBeat(projectId, beat._id.toString());
    expect(res.body).toBe('REWRITTEN');
    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.body).toBe('REWRITTEN');
    expect(await C.getPreviousBody(projectId, beat._id.toString())).toBe('prose body');
  });
});

describe('regenerateBeat', () => {
  it('rejects with 409 when there is no critique', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    await expect(R.regenerateBeat(projectId, beat._id.toString())).rejects.toMatchObject({ status: 409 });
  });

  it('rewrites from an existing critique and stashes the old body', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'old body' });
    await C.setCritiquePending(projectId, beat._id.toString(), {
      model: 'm',
      facets: [{ key: 'pacing', label: 'Pacing', scope: 'focused', score: 4, comments: 'slow', status: 'done', error_message: null }],
    });
    await C.finalizeCritique(projectId, beat._id.toString(), { status: 'done', overall: 4 });
    const res = await R.regenerateBeat(projectId, beat._id.toString());
    expect(res.body).toBe('REWRITTEN');
    expect(await C.getPreviousBody(projectId, beat._id.toString())).toBe('old body');
  });

  it('synthesizes a strategy first, persists it, and returns it alongside the body', async () => {
    // Call-counting stub: 1st call (synthesis) -> STRATEGY, 2nd (rewrite) -> REWRITTEN.
    let n = 0;
    _setAnthropicClientForTests({
      messages: { create: async () => ({ content: [{ type: 'text', text: ++n === 1 ? 'STRATEGY' : 'REWRITTEN' }] }) },
    });
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'old body' });
    await C.setCritiquePending(projectId, beat._id.toString(), {
      model: 'm',
      facets: [{ key: 'pacing', label: 'Pacing', scope: 'focused', score: 4, comments: 'slow', status: 'done', error_message: null }],
    });
    await C.finalizeCritique(projectId, beat._id.toString(), { status: 'done', overall: 4 });
    const res = await R.regenerateBeat(projectId, beat._id.toString());
    expect(res.strategy).toBe('STRATEGY'); // first call = synthesis pass
    expect(res.body).toBe('REWRITTEN'); // second call = rewrite from the strategy
    const c = await C.getBeatCritique(projectId, beat._id.toString());
    expect(c.strategy).toBe('STRATEGY'); // persisted on the critique for the UI
    expect(await C.getPreviousBody(projectId, beat._id.toString())).toBe('old body');
  });
});

describe('formatCritiqueForRewrite', () => {
  it('renders ranked issues most severe first, then facet summaries with criterion scores', () => {
    const text = R.formatCritiqueForRewrite({
      facets: [
        {
          key: 'pacing', label: 'Pacing & momentum', status: 'done', score: 5.5, summary: 'Slack middle.',
          criteria: [{ key: 'entry', label: 'Entry', applicable: true, score: 7 }, { key: 'proportion', label: 'Length vs. weight', applicable: false, score: null }],
          issues: [{ severity: 'should_fix', criterion: 'escalation', quote: 'They talk.', problem: 'Flat.', fix: 'Cut the second exchange.' }],
        },
        {
          key: 'format', label: 'Screenplay format', status: 'done', score: 6, summary: 'No slug.', criteria: [],
          issues: [{ severity: 'must_fix', criterion: 'geography', quote: 'in the minivan', problem: 'Which seat?', fix: 'Add BACK SEAT.' }],
        },
        { key: 'voice', label: 'Character voice', status: 'error', issues: [{ severity: 'must_fix', criterion: 'x', quote: '', problem: 'ignored', fix: '' }] },
      ],
    });
    expect(text.indexOf('## MUST FIX')).toBeLessThan(text.indexOf('## SHOULD FIX'));
    expect(text).toContain('[Screenplay format / geography] "in the minivan" — Which seat? → FIX: Add BACK SEAT.');
    expect(text).toContain('Cut the second exchange.');
    expect(text).not.toContain('ignored');
    expect(text).toContain('## Pacing & momentum (score 5.5/10)');
    expect(text).toContain('- Entry: 7/10');
    expect(text).toContain('- Length vs. weight: n/a');
    expect(text).toContain('Slack middle.');
  });

  it('falls back to the legacy score + comments rendering when no facet has issues', () => {
    const text = R.formatCritiqueForRewrite({
      facets: [{ key: 'pacing', label: 'Pacing', status: 'done', score: 4, comments: 'slow' }],
    });
    expect(text).toBe('## Pacing (score 4/10)\nslow');
  });

  it('sends the ranked issues to the strategist', async () => {
    const prompts = [];
    _setAnthropicClientForTests({
      messages: { create: async (req) => { prompts.push(req.messages[0].content); return { content: [{ type: 'text', text: 'X' }] }; } },
    });
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'old body' });
    await C.setCritiquePending(projectId, beat._id.toString(), {
      model: 'm',
      facets: [{ key: 'format', label: 'Screenplay format', scope: 'focused', score: 5, comments: 'c', status: 'done', error_message: null,
        criteria: [], issues: [{ severity: 'must_fix', criterion: 'geography', quote: 'LINE-Q', problem: 'PROB', fix: 'FIX-IT' }] }],
    });
    await C.finalizeCritique(projectId, beat._id.toString(), { status: 'done', overall: 5 });
    await R.regenerateBeat(projectId, beat._id.toString());
    const synth = typeof prompts[0] === 'string' ? prompts[0] : JSON.stringify(prompts[0]);
    expect(synth).toContain('MUST FIX');
    expect(synth).toContain('LINE-Q');
    expect(synth).toContain('FIX-IT');
  });
});

describe('restoreBeatBody', () => {
  it('restores the stashed body and clears the slot', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'orig' });
    await R.normalizeBeat(projectId, beat._id.toString()); // body -> REWRITTEN, prev -> orig
    const res = await R.restoreBeatBody(projectId, beat._id.toString());
    expect(res).toMatchObject({ restored: true, body: 'orig' });
    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.body).toBe('orig');
    expect(await C.getPreviousBody(projectId, beat._id.toString())).toBeNull();
  });

  it('is a safe no-op when nothing is stashed', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    const res = await R.restoreBeatBody(projectId, beat._id.toString());
    expect(res).toEqual({ restored: false });
  });
});

// A v2 critique with one capped facet, one strength and one criterion at 9.
function richCritique() {
  return {
    status: 'done',
    overall: 6,
    facets: [
      {
        key: 'direction', label: "Director's notes", status: 'done', score: 5, summary: 'Two anchors broken.', strengths: [],
        criteria: [
          { key: 'notes_honored', label: 'Project notes honored', applicable: true, score: 8, evidence: [] },
          { key: 'scene_bible', label: 'Scene bible fidelity', applicable: true, score: 5, evidence: [] },
        ],
        issues: [
          { severity: 'must_fix', criterion: 'scene_bible', quote: 'KEYS (12)', problem: 'The bible makes him 10.', fix: 'KEYS (10)' },
          { severity: 'must_fix', criterion: 'scene_bible', quote: 'a short-sleeved tee', problem: 'Breaks the wardrobe anchor.', fix: 'a striped long-sleeve under a windbreaker' },
        ],
      },
      {
        key: 'pacing', label: 'Pacing & momentum', status: 'done', score: 9, summary: '', strengths: ['Cuts on the button.'],
        criteria: [{ key: 'exit', label: 'Exit', applicable: true, score: 9, evidence: [{ quote: 'The doors swing shut.', note: 'the button' }] }],
        issues: [],
      },
    ],
  };
}

const CTX = {
  beat: { desc: 'A boy of ten goes to the movies.', dialog_notes: '' },
  sceneBible: 'Young Keys is 10. Striped long-sleeve under a zip-up windbreaker.',
  directorNotes: [{ text: 'Let drifts linger on empty space.' }],
  directorialVoice: 'Patient, observational.',
  plot: { dialogue_style: 'Clipped.' },
  characters: [],
  sets: [],
  spine: [{ order: 1, name: 'Sky', desc: 'Stars' }],
  prevBeat: { order: 1, name: 'Sky', body: 'A tilt down from the stars.' },
  nextBeat: null,
};

describe('rewrite prompts', () => {
  let calls;
  beforeEach(() => {
    calls = [];
    _setAnthropicClientForTests({
      messages: { create: async (req) => { calls.push(req); return { content: [{ type: 'text', text: 'OUT' }] }; } },
    });
  });
  const beat = { body: 'KEYS (12) wears a short-sleeved tee. The doors swing shut.' };

  it('the context block carries what the critics score against and skips what is absent', () => {
    const text = R.formatRewriteContext(CTX).join('\n');
    expect(text).toContain('What this beat must agree with');
    expect(text).toContain('Young Keys is 10');
    expect(text).toContain('Let drifts linger');
    expect(text).toContain('A tilt down from the stars.');
    expect(text).toContain('A boy of ten');
    expect(text).not.toContain('Characters in this beat');
    expect(text).not.toContain('The beat after this one');
    expect(R.formatRewriteContext(null)).toEqual([]);
  });

  it('the strategist sees the context, the levers, the targets and the keep list', async () => {
    await R.synthesizeRewriteStrategy({ beat, critique: richCritique(), ctx: CTX });
    const user = calls[0].messages[0].content;
    expect(user).toContain('Young Keys is 10');
    expect(user).toMatch(/Director's notes: 5\/10 now, capped at 5 by two or more must-fix issues/);
    expect(user).toContain('Scene bible fidelity (now 5): a 9 is');
    expect(user).toContain('Cuts on the button.');
    expect(user).toContain('"The doors swing shut."');
    expect(calls[0].system).toContain('caps the facet at 7');
  });

  it('the writer sees the issues themselves, not only the plan', async () => {
    await R.regenerateBeatBody({ beat, strategy: 'THE PLAN', critique: richCritique(), ctx: CTX });
    const user = calls[0].messages[0].content;
    expect(user).toContain('THE PLAN');
    expect(user).toContain('"KEYS (12)" — The bible makes him 10. → FIX: KEYS (10)');
    expect(user).toContain('Young Keys is 10');
    expect(user).toContain('Keep (the critics praised these');
    expect(calls[0].system).not.toContain('ticks each note off');
    expect(calls[0].max_tokens).toBeGreaterThan(4000);
  });

  it('a rewrite cut off at the length limit fails instead of being used', async () => {
    _setAnthropicClientForTests({ messages: { create: async () => ({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'HALF A BE' }] }) } });
    await expect(R.regenerateBeatBody({ beat, strategy: 'p' })).rejects.toThrow(/cut off/);
  });

  it('history shows what the critics faulted in a discarded attempt', async () => {
    const issues = R.summarizeIssuesForHistory(richCritique());
    expect(issues[0]).toBe('[Director\'s notes, must fix] "KEYS (12)" — The bible makes him 10.');
    await R.synthesizeRewriteStrategy({ beat, critique: richCritique(), history: [{ n: 2, score: 7.3, mode: 'edit', facets: { Pacing: 7 }, strategy: 'OLD PLAN', issues }] });
    const user = calls[0].messages[0].content;
    expect(user).toContain('Attempt 2 (targeted edits): overall 7.3/10 (Pacing 7)');
    expect(user).toContain('What the critics then faulted:');
    expect(user).toContain('The bible makes him 10.');
  });

  it('planBeatEdits parses the edit list and asks again on a non-JSON answer', async () => {
    const answers = ['not json', JSON.stringify({ plan: 'P', edits: [{ find: 'KEYS (12)', replace: 'KEYS (10)', issue: 'age' }, { find: 3 }] })];
    _setAnthropicClientForTests({ messages: { create: async (req) => { calls.push(req); return { content: [{ type: 'text', text: answers.shift() }] }; } } });
    const out = await R.planBeatEdits({ beat, critique: richCritique(), ctx: CTX });
    expect(out).toEqual({ plan: 'P', edits: [{ find: 'KEYS (12)', replace: 'KEYS (10)', issue: 'age' }] });
    expect(calls).toHaveLength(2);
    expect(calls[0].output_config.format.type).toBe('json_schema');
  });
});

describe('applyBeatEdits', () => {
  const body = 'KEYS (12) runs.\n\nHe runs again. KEYS stops.';
  it('applies edits in order and leaves the rest of the body untouched', () => {
    const out = R.applyBeatEdits(body, [
      { find: 'KEYS (12)', replace: 'KEYS (10)', issue: 'age' },
      { find: 'He runs again. ', replace: '', issue: 'repeat' },
    ]);
    expect(out.body).toBe('KEYS (10) runs.\n\nKEYS stops.');
    expect(out.applied).toHaveLength(2);
    expect(out.skipped).toEqual([]);
  });

  it('skips an edit whose passage is missing, ambiguous, empty or unchanged', () => {
    const out = R.applyBeatEdits(body, [
      { find: 'not there', replace: 'x', issue: 'a' },
      { find: 'runs', replace: 'walks', issue: 'b' },
      { find: '  ', replace: 'x', issue: 'c' },
      { find: 'stops', replace: 'stops', issue: 'd' },
      { find: 'stops', replace: 'halts', issue: 'e' },
    ]);
    expect(out.skipped.map((e) => e.reason)).toEqual(['not_found', 'ambiguous', 'empty', 'no_change']);
    expect(out.applied.map((e) => e.issue)).toEqual(['e']);
    expect(out.body).toBe('KEYS (12) runs.\n\nHe runs again. KEYS halts.');
    expect(R.describeEditPlan({ plan: 'P', ...out })).toMatch(/^Targeted edits \(1 applied, 4 could not be placed\)/);
  });
});

describe('screenplay lines survive the trip to storage and back', () => {
  const page = 'INT. LOBBY — NIGHT\n\nKEYS\n(flat)\nCompliance.\n\nHe turns.';
  const stored = 'INT. LOBBY — NIGHT\n\nKEYS\\\n(flat)\\\nCompliance.\n\nHe turns.';

  it('toStoredBody turns the lines of a dialogue block into hard breaks, and pageOf undoes it', () => {
    expect(R.toStoredBody(page)).toBe(stored);
    expect(R.toStoredBody(stored)).toBe(stored);
    expect(R.pageOf(stored)).toBe(page);
  });

  it('leaves markdown structure alone', () => {
    const md = '> crawl one\n>\n> crawl two\n\n- a\n- b\n\n# Heading\ntext';
    expect(R.toStoredBody(md)).toBe(md);
  });

  it('a rewrite is saved with its cue, parenthetical and speech on separate lines', async () => {
    _setAnthropicClientForTests({ messages: { create: async () => ({ content: [{ type: 'text', text: page }] }) } });
    const out = await R.regenerateBeatBody({ beat: { body: 'old' }, strategy: 'p' });
    expect(out).toBe(stored);
  });

  it('the writer is shown the page without hard-break marks, and the rubric it is scored on', async () => {
    const calls = [];
    _setAnthropicClientForTests({ messages: { create: async (req) => { calls.push(req); return { content: [{ type: 'text', text: 'x' }] }; } } });
    await R.regenerateBeatBody({ beat: { body: stored }, strategy: 'p' });
    expect(calls[0].messages[0].content).toContain('KEYS\n(flat)\nCompliance.');
    expect(calls[0].messages[0].content).not.toContain('\\\n');
    expect(calls[0].system).toContain('What the critics score');
    expect(calls[0].system).toContain('Dialogue layout: CAPS cue on its own line');
    expect(calls[0].system).toContain('Staging within a scene:');
    expect(calls[0].system).toContain('character cue in CAPS on its own line');
  });

  it('edits are applied on the page and the result is stored with its lines', () => {
    const out = R.applyBeatEdits(stored, [{ find: 'KEYS\n(flat)', replace: 'KEYS (O.S.)\n(flat)', issue: 'cue' }]);
    expect(out.applied).toHaveLength(1);
    expect(out.body).toBe('INT. LOBBY — NIGHT\n\nKEYS (O.S.)\\\n(flat)\\\nCompliance.\n\nHe turns.');
  });
});
