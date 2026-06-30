import { describe, it, expect } from 'vitest';

const { runAsEditor, currentEditor } = await import('../src/web/editAttribution.js');

describe('editAttribution', () => {
  it('currentEditor is null outside any scope', () => {
    expect(currentEditor()).toBe(null);
  });

  it('exposes the editor name inside runAsEditor', () => {
    const seen = runAsEditor('Steve', () => currentEditor());
    expect(seen).toBe('Steve');
    expect(currentEditor()).toBe(null); // scope ends after fn returns
  });

  it('trims the name and treats blank/falsy as no scope', () => {
    expect(runAsEditor('  Ada  ', () => currentEditor())).toBe('Ada');
    expect(runAsEditor('', () => currentEditor())).toBe(null);
    expect(runAsEditor(undefined, () => currentEditor())).toBe(null);
    expect(runAsEditor(null, () => currentEditor())).toBe(null);
  });

  it('propagates the scope across awaits and returns the promise value', async () => {
    const result = await runAsEditor('Grace', async () => {
      await Promise.resolve();
      return currentEditor();
    });
    expect(result).toBe('Grace');
  });

  it('nested scopes shadow the outer one', () => {
    const out = runAsEditor('Outer', () =>
      runAsEditor('Inner', () => currentEditor()));
    expect(out).toBe('Inner');
  });
});
