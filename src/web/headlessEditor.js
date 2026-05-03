// Server-side headless Tiptap setup. Used by the gateway to:
//   - render a Y.XmlFragment to markdown after the bot or auto-save persists
//   - parse markdown into a Y.XmlFragment when the bot wholesale-replaces a field
//
// We install a minimal JSDOM global once on first use so Tiptap's prosemirror-view
// dependency can construct without throwing.

import { JSDOM } from 'jsdom';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import { Markdown } from 'tiptap-markdown';

let domInstalled = false;

function installDom() {
  if (domInstalled) return;
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { pretendToBeVisual: true });
  const w = dom.window;
  // Only define globals that aren't already set, so we don't clobber a host
  // environment that already provides them (tests, future browser SSR, etc.).
  for (const k of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Node',
    'Element',
    'getSelection',
    'DocumentFragment',
    'Range',
    'KeyboardEvent',
    'MouseEvent',
    'CompositionEvent',
    'MutationObserver',
    'ClipboardEvent',
    'DataTransfer',
    'DOMParser',
    'XMLSerializer',
  ]) {
    if (typeof globalThis[k] === 'undefined' && typeof w[k] !== 'undefined') {
      globalThis[k] = w[k];
    }
  }
  domInstalled = true;
}

const STARTER_KIT_OPTS = {
  // The Collaboration extension owns history.
  history: false,
  // We deliberately keep StarterKit's defaults otherwise so the schema matches
  // the client editor.
};

function makeEditor({ ydoc, field }) {
  installDom();
  return new Editor({
    extensions: [
      StarterKit.configure(STARTER_KIT_OPTS),
      Markdown.configure({
        // Treat any pasted/loaded text as markdown.
        transformPastedText: true,
        transformCopiedText: false,
        // Do not let the editor break a long line of trailing whitespace.
        breaks: false,
      }),
      Collaboration.configure({ document: ydoc, field }),
    ],
  });
}

// Render the current state of a Yjs XmlFragment (identified by `field` inside
// the given y-doc) to a markdown string.
export function fragmentToMarkdown(ydoc, field) {
  const editor = makeEditor({ ydoc, field });
  try {
    return editor.storage.markdown.getMarkdown();
  } finally {
    editor.destroy();
  }
}

// Replace the contents of a Yjs XmlFragment with `markdown`. The change is made
// transactionally so a single Yjs update broadcasts to subscribed clients.
export function setFragmentMarkdown(ydoc, field, markdown) {
  const editor = makeEditor({ ydoc, field });
  try {
    editor.commands.setContent(String(markdown ?? ''), false);
  } finally {
    editor.destroy();
  }
}

// Apply a list of {find, replace} edits to the markdown rendering of a fragment.
// Returns {applied, beforeLen, afterLen, snapshots}. If any find string is
// missing or ambiguous the function throws and no edits are applied.
export function editFragmentMarkdown(ydoc, field, edits) {
  let body = fragmentToMarkdown(ydoc, field);
  const beforeLen = body.length;
  const applied = [];
  for (let i = 0; i < edits.length; i++) {
    const { find, replace } = edits[i];
    if (typeof find !== 'string' || !find) {
      throw new Error(`edit ${i}: find must be a non-empty string.`);
    }
    if (typeof replace !== 'string') {
      throw new Error(`edit ${i}: replace must be a string.`);
    }
    const first = body.indexOf(find);
    if (first < 0) {
      throw new Error(`edit ${i}: find string not present in current markdown.`);
    }
    const second = body.indexOf(find, first + find.length);
    if (second >= 0) {
      throw new Error(`edit ${i}: find string is ambiguous (matches more than once).`);
    }
    body = body.slice(0, first) + replace + body.slice(first + find.length);
    applied.push({ find_chars: find.length, replace_chars: replace.length });
  }
  setFragmentMarkdown(ydoc, field, body);
  return { applied, beforeLen, afterLen: body.length, body };
}

// Append `content` to the markdown rendering of a fragment, separated by a
// blank line if the field already has content.
export function appendToFragmentMarkdown(ydoc, field, content) {
  const existing = fragmentToMarkdown(ydoc, field);
  const addition = String(content ?? '').trim();
  if (!addition) throw new Error('No content to append.');
  const sep = existing.trim() ? '\n\n' : '';
  const next = `${existing}${sep}${addition}`;
  setFragmentMarkdown(ydoc, field, next);
  return next;
}
