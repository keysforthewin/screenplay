import { describe, it, expect } from 'vitest';
import {
  MAX_HISTORY,
  emptyHistory,
  snapshotsEqual,
  recordEdit,
  undo,
  redo,
  canUndo,
  canRedo,
} from '../web/src/widgets/beatEditHistory.js';

const snap = (name, desc, body) => ({ name, desc, body });

describe('beatEditHistory', () => {
  it('emptyHistory has empty stacks and no undo/redo', () => {
    const h = emptyHistory();
    expect(h.undo).toEqual([]);
    expect(h.redo).toEqual([]);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  it('snapshotsEqual compares all three fields', () => {
    expect(snapshotsEqual(snap('a', 'b', 'c'), snap('a', 'b', 'c'))).toBe(true);
    expect(snapshotsEqual(snap('a', 'b', 'c'), snap('a', 'b', 'X'))).toBe(false);
  });

  it('recordEdit pushes a transaction and clears redo', () => {
    let h = emptyHistory();
    h = recordEdit(h, snap('a', '', ''), snap('b', '', ''));
    expect(h.undo).toHaveLength(1);
    expect(h.undo[0]).toEqual({ before: snap('a', '', ''), after: snap('b', '', '') });
    expect(h.redo).toEqual([]);
    expect(canUndo(h)).toBe(true);
  });

  it('recordEdit ignores no-op edits (before === after)', () => {
    let h = emptyHistory();
    h = recordEdit(h, snap('a', '', ''), snap('a', '', ''));
    expect(h.undo).toHaveLength(0);
  });

  it('recordEdit caps the undo stack at MAX_HISTORY, dropping the oldest', () => {
    let h = emptyHistory();
    for (let i = 0; i < MAX_HISTORY + 3; i++) {
      h = recordEdit(h, snap(`v${i}`, '', ''), snap(`v${i + 1}`, '', ''));
    }
    expect(h.undo).toHaveLength(MAX_HISTORY);
    expect(h.undo[0].before).toEqual(snap('v3', '', ''));
  });

  it('undo returns the before-snapshot and moves the txn to redo', () => {
    let h = recordEdit(emptyHistory(), snap('a', '', ''), snap('b', '', ''));
    const r = undo(h);
    expect(r.snapshot).toEqual(snap('a', '', ''));
    expect(r.history.undo).toHaveLength(0);
    expect(r.history.redo).toHaveLength(1);
    expect(canRedo(r.history)).toBe(true);
  });

  it('undo on empty history returns null snapshot and unchanged history', () => {
    const h = emptyHistory();
    const r = undo(h);
    expect(r.snapshot).toBe(null);
    expect(r.history).toBe(h);
  });

  it('redo returns the after-snapshot and moves the txn back to undo', () => {
    let h = recordEdit(emptyHistory(), snap('a', '', ''), snap('b', '', ''));
    const afterUndo = undo(h).history;
    const r = redo(afterUndo);
    expect(r.snapshot).toEqual(snap('b', '', ''));
    expect(r.history.redo).toHaveLength(0);
    expect(r.history.undo).toHaveLength(1);
  });

  it('redo on empty redo stack returns null snapshot', () => {
    const h = recordEdit(emptyHistory(), snap('a', '', ''), snap('b', '', ''));
    const r = redo(h);
    expect(r.snapshot).toBe(null);
    expect(r.history).toBe(h);
  });

  it('back-and-forth across several edits stays consistent', () => {
    let h = emptyHistory();
    h = recordEdit(h, snap('a', '', ''), snap('b', '', ''));
    h = recordEdit(h, snap('b', '', ''), snap('c', '', ''));
    const u1 = undo(h);
    expect(u1.snapshot).toEqual(snap('b', '', ''));
    const u2 = undo(u1.history);
    expect(u2.snapshot).toEqual(snap('a', '', ''));
    const r1 = redo(u2.history);
    expect(r1.snapshot).toEqual(snap('b', '', ''));
    const r2 = redo(r1.history);
    expect(r2.snapshot).toEqual(snap('c', '', ''));
  });
});
