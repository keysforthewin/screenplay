// Derive the "what page am I on" descriptor for the AI chat from the SPA's
// current location. Pure function (no React) so it is unit-testable and can be
// imported from the node test runner. The chat sends { kind, ref } to the
// server, which re-resolves the live entity; `label` is the terse chip text.
//
// Routes live under /p/:projectTitle/* (see web/src/App.jsx); strip that prefix
// and match the remainder against the project-scoped route table. Per-beat
// storyboard/dialog regexes are checked before the bare index paths.

export function pageContextFromPath(pathname) {
  const remainder = String(pathname || '').replace(/^\/p\/[^/]+/, '') || '/';

  const beat = remainder.match(/^\/beat\/(.+)$/);
  if (beat) {
    const ref = decodeURIComponent(beat[1]);
    return { kind: 'beat', ref, label: `Beat ${ref}` };
  }
  const character = remainder.match(/^\/character\/(.+)$/);
  if (character) {
    const ref = decodeURIComponent(character[1]);
    return { kind: 'character', ref, label: `Character: ${ref}` };
  }
  const storyboardBeat = remainder.match(/^\/storyboard\/(.+)$/);
  if (storyboardBeat) {
    const ref = decodeURIComponent(storyboardBeat[1]);
    return { kind: 'storyboard', ref, label: `Storyboard · Beat ${ref}` };
  }
  const dialogBeat = remainder.match(/^\/dialog\/(.+)$/);
  if (dialogBeat) {
    const ref = decodeURIComponent(dialogBeat[1]);
    return { kind: 'dialog', ref, label: `Dialog · Beat ${ref}` };
  }
  if (remainder === '/storyboard') return { kind: 'storyboard-index', ref: null, label: 'Storyboards' };
  if (remainder === '/dialog') return { kind: 'dialog-index', ref: null, label: 'Dialogs' };
  if (remainder === '/notes') return { kind: 'notes', ref: null, label: 'Notes' };
  if (remainder === '/library') return { kind: 'library', ref: null, label: 'Library' };
  if (remainder === '/about') return { kind: 'about', ref: null, label: 'About' };

  return { kind: 'overview', ref: null, label: 'Overview' };
}
