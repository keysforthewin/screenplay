// Pure parser: the SPA's current path → the { kind, ref, label } descriptor
// the AI chat sends to the server. Lives in tests/ (node env) because the
// module under test has no React/JSX dependency.
import { describe, it, expect } from 'vitest';
import { pageContextFromPath } from '../web/src/project/pageContext.js';

describe('pageContextFromPath', () => {
  it('maps the project root to the overview', () => {
    expect(pageContextFromPath('/p/Heist/')).toEqual({ kind: 'overview', ref: null, label: 'Overview' });
    expect(pageContextFromPath('/p/Heist')).toEqual({ kind: 'overview', ref: null, label: 'Overview' });
  });

  it('maps a beat path to its order', () => {
    expect(pageContextFromPath('/p/Heist/beat/2')).toEqual({ kind: 'beat', ref: '2', label: 'Beat 2' });
  });

  it('maps a character path to its (decoded) name', () => {
    expect(pageContextFromPath('/p/Heist/character/Steve')).toEqual({
      kind: 'character', ref: 'Steve', label: 'Character: Steve',
    });
    expect(pageContextFromPath('/p/Heist/character/Steve%20Rogers')).toEqual({
      kind: 'character', ref: 'Steve Rogers', label: 'Character: Steve Rogers',
    });
  });

  it('distinguishes storyboard/dialog indexes from per-beat pages', () => {
    expect(pageContextFromPath('/p/Heist/storyboard')).toEqual({ kind: 'storyboard-index', ref: null, label: 'Storyboards' });
    expect(pageContextFromPath('/p/Heist/storyboard/3')).toEqual({ kind: 'storyboard', ref: '3', label: 'Storyboard · Beat 3' });
    expect(pageContextFromPath('/p/Heist/dialog')).toEqual({ kind: 'dialog-index', ref: null, label: 'Dialogs' });
    expect(pageContextFromPath('/p/Heist/dialog/3')).toEqual({ kind: 'dialog', ref: '3', label: 'Dialog · Beat 3' });
  });

  it('maps the singleton section pages', () => {
    expect(pageContextFromPath('/p/Heist/notes').kind).toBe('notes');
    expect(pageContextFromPath('/p/Heist/library').kind).toBe('library');
    expect(pageContextFromPath('/p/Heist/about').kind).toBe('about');
  });

  it('falls back to overview for unknown subpaths', () => {
    expect(pageContextFromPath('/p/Heist/something/weird').kind).toBe('overview');
  });
});
