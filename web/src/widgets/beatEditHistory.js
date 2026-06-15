// Pure, React-free undo/redo history for a single beat's text fields.
// A "snapshot" is { name, desc, body } (markdown strings). A "transaction" is
// { before, after } — the beat text immediately before and after one chatbot
// edit. History = { undo: Transaction[], redo: Transaction[] }.
//
// Undo applies a transaction's `before` and moves it to the redo stack; redo
// applies `after` and moves it back. The undo stack is capped at MAX_HISTORY
// (the "ten change window"); the oldest transaction is dropped past the cap.
// Kept free of React so it is unit-testable in the node test runner.

export const MAX_HISTORY = 10;

export function emptyHistory() {
  return { undo: [], redo: [] };
}

export function snapshotsEqual(a, b) {
  if (!a || !b) return false;
  return a.name === b.name && a.desc === b.desc && a.body === b.body;
}

function capped(stack) {
  const next = stack.slice();
  while (next.length > MAX_HISTORY) next.shift();
  return next;
}

// Record a completed edit. No-op edits (before === after) are ignored so the
// history only ever holds real changes. Recording clears the redo stack.
export function recordEdit(history, before, after) {
  if (snapshotsEqual(before, after)) return history;
  return {
    undo: capped([...history.undo, { before, after }]),
    redo: [],
  };
}

// Returns { history, snapshot }. `snapshot` is the text to apply (the `before`
// of the most recent transaction), or null if there is nothing to undo.
export function undo(history) {
  if (!history.undo.length) return { history, snapshot: null };
  const undoStack = history.undo.slice();
  const tx = undoStack.pop();
  return {
    history: { undo: undoStack, redo: [...history.redo, tx] },
    snapshot: tx.before,
  };
}

// Returns { history, snapshot }. `snapshot` is the text to re-apply (the
// `after` of the most recently undone transaction), or null if nothing to redo.
export function redo(history) {
  if (!history.redo.length) return { history, snapshot: null };
  const redoStack = history.redo.slice();
  const tx = redoStack.pop();
  return {
    history: { undo: capped([...history.undo, tx]), redo: redoStack },
    snapshot: tx.after,
  };
}

export function canUndo(history) {
  return history.undo.length > 0;
}

export function canRedo(history) {
  return history.redo.length > 0;
}
