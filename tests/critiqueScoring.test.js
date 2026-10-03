import { describe, it, expect } from 'vitest';
import {
  deriveFacetScore,
  deriveOverall,
  normalizeFacetResult,
  collectRankedIssues,
  clampScore,
  SCORING_RULES,
  explainFacetScore,
  scoreLevers,
} from '../src/web/critiqueScoring.js';
import { FACETS, getFacet } from '../src/web/critiqueFacets.js';

const facet = getFacet('format');
const crit = (key, score, extra = {}) => ({ key, applicable: true, score, evidence: [], rationale: '', ...extra });

describe('deriveFacetScore', () => {
  it('is the mean of applicable criteria, one decimal', () => {
    expect(deriveFacetScore([crit('sluglines', 9), crit('action_lines', 8), crit('geography', 7)], [], facet)).toBe(8);
    expect(deriveFacetScore([crit('sluglines', 9), crit('action_lines', 8), crit('geography', 5)], [], facet)).toBe(7.3);
  });

  it('ignores not-applicable criteria and returns null when none apply', () => {
    expect(deriveFacetScore([crit('sluglines', 9), crit('action_lines', 2, { applicable: false })], [], facet)).toBe(9);
    expect(deriveFacetScore([crit('sluglines', 9, { applicable: false })], [], facet)).toBeNull();
    expect(deriveFacetScore([], [], facet)).toBeNull();
  });

  it('honours criterion weights', () => {
    expect(deriveFacetScore([crit('sluglines', 10, { weight: 3 }), crit('action_lines', 2)], [], facet)).toBe(8);
  });

  it('caps a must_fix criterion at 6 and the facet at 7', () => {
    const issues = [{ severity: 'must_fix', criterion: 'geography' }];
    expect(deriveFacetScore([crit('sluglines', 10), crit('geography', 10)], issues, facet)).toBe(7);
    // the criterion cap alone: (10 + 6) / 2 = 8 → capped to 7
    expect(deriveFacetScore([crit('sluglines', 10), crit('geography', 9)], issues, facet)).toBe(7);
    expect(deriveFacetScore([crit('sluglines', 4), crit('geography', 9)], issues, facet)).toBe(5);
  });

  it('caps at 5 with two must_fix and at 8 with three should_fix', () => {
    const two = [{ severity: 'must_fix', criterion: 'geography' }, { severity: 'must_fix', criterion: 'sluglines' }];
    expect(deriveFacetScore([crit('sluglines', 10), crit('geography', 10)], two, facet)).toBe(5);
    const three = Array(3).fill({ severity: 'should_fix', criterion: 'geography' });
    expect(deriveFacetScore([crit('sluglines', 10), crit('geography', 10)], three, facet)).toBe(8);
    const twoShould = three.slice(0, 2);
    expect(deriveFacetScore([crit('sluglines', 10), crit('geography', 10)], twoShould, facet)).toBe(10);
  });
});

describe('deriveOverall', () => {
  it('weights required facets 1.5 and skips unfinished facets', () => {
    const facets = FACETS.map((f) => ({ key: f.key, status: 'done', score: f.key === 'format' ? 4 : 8 }));
    // (4*1.5 + 8*1.5 + 8*5) / (1.5*2 + 5) = 58 / 8 = 7.25 → 7.3
    expect(deriveOverall(facets, FACETS)).toBe(7.3);
    facets.find((f) => f.key === 'pacing').status = 'error';
    facets.find((f) => f.key === 'pacing').score = null;
    expect(deriveOverall(facets, FACETS)).toBe(7.1);
  });

  it('is null when nothing finished', () => {
    expect(deriveOverall([{ key: 'format', status: 'error', score: null }], FACETS)).toBeNull();
  });
});

describe('normalizeFacetResult', () => {
  it('maps the legacy {score, comments} shape', () => {
    const r = normalizeFacetResult({ score: 8, comments: 'fine' }, facet);
    expect(r).toMatchObject({ score: 8, summary: 'fine', comments: 'fine', criteria: [], issues: [], strengths: [] });
  });

  it('fills missing criteria as not applicable, clamps, truncates quotes, drops unknown severities', () => {
    const r = normalizeFacetResult(
      {
        criteria: [
          { key: 'sluglines', applicable: true, score: 11, evidence: [{ quote: 'x'.repeat(300), note: 'n' }], rationale: 'r' },
          { key: 'bogus', applicable: true, score: 5, evidence: [], rationale: '' },
          { key: 'dialogue_format', applicable: true, score: 'NaN', evidence: [], rationale: '' },
        ],
        issues: [
          { severity: 'nit', criterion: 'sluglines', quote: 'q', problem: 'p', fix: 'f' },
          { severity: 'must_fix', criterion: 'sluglines', quote: 'q2', problem: 'p2', fix: 'f2' },
          { severity: 'critical', criterion: 'sluglines', quote: 'q3', problem: 'p3', fix: 'f3' },
          { severity: 'should_fix', criterion: 'nope', quote: '', problem: 'p4', fix: 'f4' },
        ],
        strengths: ['s1', ''],
        summary: 'sum',
      },
      facet,
    );
    expect(r.criteria.map((c) => c.key)).toEqual(['sluglines', 'action_lines', 'dialogue_format', 'screen_text']);
    expect(r.criteria[0].score).toBe(10);
    expect(r.criteria[0].evidence[0].quote.length).toBeLessThanOrEqual(200);
    expect(r.criteria[1].applicable).toBe(false);
    expect(r.criteria[2].applicable).toBe(false); // unscorable → not applicable
    expect(r.issues.map((i) => i.severity)).toEqual(['must_fix', 'nit']);
    expect(r.strengths).toEqual(['s1']);
    expect(r.summary).toBe('sum');
    expect(r.comments).toBe('sum');
    // one must_fix on sluglines: criterion capped at 6 → facet 6
    expect(r.score).toBe(6);
  });

  it('returns a null score when nothing applies', () => {
    const r = normalizeFacetResult({ criteria: [{ key: 'sluglines', applicable: false, score: 1, evidence: [], rationale: '' }], issues: [], strengths: [], summary: '' }, facet);
    expect(r.score).toBeNull();
  });
});

describe('collectRankedIssues', () => {
  it('orders by severity then facet weight and labels each issue', () => {
    const critique = {
      facets: [
        { key: 'pacing', label: 'Pacing & momentum', status: 'done', issues: [{ severity: 'must_fix', criterion: 'entry', problem: 'a' }, { severity: 'nit', criterion: 'exit', problem: 'b' }] },
        { key: 'format', label: 'Screenplay format', status: 'done', issues: [{ severity: 'must_fix', criterion: 'geography', problem: 'c' }, { severity: 'should_fix', criterion: 'sluglines', problem: 'd' }] },
        { key: 'voice', label: 'Character voice', status: 'error', issues: [{ severity: 'must_fix', criterion: 'x', problem: 'ignored' }] },
      ],
    };
    const out = collectRankedIssues(critique, FACETS);
    expect(out.map((i) => `${i.severity}:${i.facet_key}`)).toEqual(['must_fix:format', 'must_fix:pacing', 'should_fix:format', 'nit:pacing']);
    expect(out[0].facet_label).toBe('Screenplay format');
  });
});

describe('misc', () => {
  it('clampScore keeps one decimal and clamps 1-10', () => {
    expect(clampScore(7.25)).toBe(7.3);
    expect(clampScore(0)).toBe(1);
    expect(clampScore(42)).toBe(10);
    expect(clampScore('x')).toBeNull();
  });

  it('SCORING_RULES names the must_fix caps the code enforces', () => {
    expect(SCORING_RULES).toMatch(/must_fix/);
    expect(SCORING_RULES).toMatch(/caps its criterion at 6/);
  });
});

describe('explainFacetScore / scoreLevers', () => {
  const stored = (key, scores, issues = []) => {
    const def = getFacet(key);
    const criteria = def.criteria.slice(0, scores.length).map((d, i) => ({ key: d.key, label: d.label, applicable: true, score: scores[i] }));
    return { key, label: def.label, status: 'done', criteria, issues, score: deriveFacetScore(criteria, issues, def) };
  };
  const issue = (severity, criterion) => ({ severity, criterion, quote: 'q', problem: 'p', fix: 'f' });

  it('names the binding cap and the score without it', () => {
    const two = stored('direction', [8, 8], [issue('must_fix', 'notes_honored'), issue('must_fix', 'notes_honored')]);
    expect(two.score).toBe(5);
    expect(explainFacetScore(two, getFacet('direction'))).toMatchObject({ score: 5, uncapped: 8, binding: 'two_must_fix', must_fix: 2 });
    const should = stored('pacing', [9, 9, 9, 9], [issue('should_fix', 'entry'), issue('should_fix', 'entry'), issue('should_fix', 'exit')]);
    expect(explainFacetScore(should, getFacet('pacing'))).toMatchObject({ score: 8, uncapped: 9, binding: 'three_should_fix' });
  });

  it('reports no cap when the cap does not lower the score', () => {
    const low = stored('pacing', [5, 6, 6, 6], [issue('should_fix', 'entry'), issue('should_fix', 'entry'), issue('should_fix', 'exit')]);
    const why = explainFacetScore(low, getFacet('pacing'));
    expect(why.binding).toBeNull();
    expect(why.lowest[0]).toMatchObject({ key: 'entry', score: 5 });
    expect(explainFacetScore({ key: 'pacing', status: 'done', score: 7, criteria: [] })).toBeNull();
  });

  it('ranks facets by what lifting the cap is worth to the overall', () => {
    const critique = {
      facets: [
        stored('pacing', [9, 9, 9, 9], [issue('should_fix', 'entry'), issue('should_fix', 'entry'), issue('should_fix', 'exit')]),
        stored('direction', [8, 8], [issue('must_fix', 'notes_honored'), issue('must_fix', 'notes_honored')]),
        stored('voice', [7, 7, 7]),
      ],
    };
    const levers = scoreLevers(critique, FACETS);
    expect(levers.map((l) => l.facet_key)).toEqual(['direction', 'pacing', 'voice']);
    // direction: +3 on a 1.5-weight facet out of 3.5 total weight.
    expect(levers[0].gain).toBe(1.29);
    expect(levers[1].gain).toBe(0.29);
    expect(levers[2]).toMatchObject({ gain: 0, binding: null });
  });
});
