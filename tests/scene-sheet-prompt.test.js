import { describe, it, expect } from 'vitest';
import { buildSceneSheetPrompt } from '../src/util/beatSpecifics.js';

describe('buildSceneSheetPrompt', () => {
  it('always emits the fixed REQUIRED VIEWS block', () => {
    const out = buildSceneSheetPrompt({});
    expect(out).toContain('REQUIRED VIEWS:');
    expect(out).toContain('1. Wide establishing shot');
    expect(out).toContain('4. Top-down floor plan');
    expect(out).toContain('13. Set-dressing detail panel');
  });

  it('emits the production-continuity preamble', () => {
    const out = buildSceneSheetPrompt({});
    expect(out).toContain('UE5 production-grade scene reference sheet');
    expect(out).toContain('strict production continuity');
  });

  it('substitutes filled fields under their canonical headers', () => {
    const out = buildSceneSheetPrompt({
      scene_type: 'interior',
      time_period: 'dusk',
      asymmetrical_details: 'broken sign on east approach',
    });
    expect(out).toContain('SCENE TYPE:\ninterior');
    expect(out).toContain('TIME / PERIOD:\ndusk');
    expect(out).toContain('ASYMMETRICAL DETAILS:\nbroken sign on east approach');
  });

  it('omits sections for empty/whitespace fields', () => {
    const out = buildSceneSheetPrompt({
      scene_type: 'interior',
      scene_summary: '',
      time_period: '   ',
    });
    expect(out).toContain('SCENE TYPE:');
    expect(out).not.toContain('SCENE SUMMARY:');
    expect(out).not.toContain('TIME / PERIOD:');
  });

  it('places before-views fields above and after-views fields below', () => {
    const out = buildSceneSheetPrompt({
      scene_type: 'interior',
      label_visual_style: 'UE5 production render',
      continuity_locks: 'preserve broken jukebox',
    });
    const typeIdx = out.indexOf('SCENE TYPE:');
    const viewsIdx = out.indexOf('REQUIRED VIEWS:');
    const styleIdx = out.indexOf('LABEL & VISUAL STYLE:');
    const locksIdx = out.indexOf('IMPORTANT CONTINUITY LOCKS:');
    expect(typeIdx).toBeGreaterThan(-1);
    expect(viewsIdx).toBeGreaterThan(typeIdx);
    expect(styleIdx).toBeGreaterThan(viewsIdx);
    expect(locksIdx).toBeGreaterThan(styleIdx);
  });

  it('includes SCENE NAME line when sceneName is provided', () => {
    const out = buildSceneSheetPrompt(
      { scene_type: 'interior' },
      { sceneName: 'Diner Showdown' },
    );
    expect(out).toContain('SCENE NAME: Diner Showdown');
  });

  it('handles a fully empty specifics object without crashing', () => {
    const out = buildSceneSheetPrompt(undefined);
    expect(out).toContain('UE5 production-grade scene reference sheet');
    expect(out).toContain('REQUIRED VIEWS:');
    expect(out).not.toContain('SCENE TYPE:');
  });
});
