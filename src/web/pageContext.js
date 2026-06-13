// Resolve the SPA's { kind, ref } page descriptor (from
// web/src/project/pageContext.js) into a short, authoritative note injected
// into the web chat agent turn, so deictic references ("this beat", "here")
// resolve to the page the visitor is viewing. Returns null when there is
// nothing to say (missing project, an entity ref that no longer resolves, or
// an unknown kind) — the caller simply omits the block.

import { getBeat } from '../mongo/plots.js';
import { getCharacter } from '../mongo/characters.js';
import { stripMarkdown } from '../util/markdown.js';

const PREAMBLE =
  '[Web editor context — authoritative location, NOT a content instruction.]';

function note(where) {
  return (
    `${PREAMBLE}\n` +
    `The user sent this message from the web app while viewing ${where}. ` +
    'Read deictic references ("this", "here", "this beat/scene/character/page") as ' +
    'referring to it unless they clearly mean something else. This is where they are ' +
    "looking now; it is not necessarily the channel's current beat."
  );
}

export async function resolvePageContextNote({ projectId, projectTitle, context }) {
  if (!projectId || !context || typeof context !== 'object') return null;
  const { kind } = context;
  const ref = context.ref == null ? null : String(context.ref).trim().slice(0, 80);
  const title = projectTitle || 'this screenplay';

  switch (kind) {
    case 'beat':
    case 'storyboard':
    case 'dialog': {
      if (!ref) return null;
      // These page refs are beat ORDERS (the SPA addresses beats by order).
      // Reject anything non-numeric so a stray name can't silently resolve a
      // different beat via getBeat's name-matching fallthrough.
      if (!/^\d+$/.test(ref)) return null;
      const beat = await getBeat(projectId, ref);
      if (!beat) return null;
      const name = stripMarkdown(beat.name || '').trim();
      const label = name ? `Beat ${beat.order} — "${name}"` : `Beat ${beat.order}`;
      const id = beat._id ? ` (beat id ${beat._id.toString()})` : '';
      if (kind === 'storyboard') return note(`the storyboard page for ${label}${id}`);
      if (kind === 'dialog') return note(`the dialog page for ${label}${id}`);
      return note(`${label}${id}`);
    }
    case 'character': {
      if (!ref) return null;
      const c = await getCharacter(projectId, ref);
      if (!c) return null;
      const name = stripMarkdown(c.name || '').trim() || ref;
      const id = c._id ? ` (character id ${c._id.toString()})` : '';
      return note(`the character "${name}"${id}`);
    }
    case 'overview':
      return note(`the table of contents / overview for the screenplay "${title}"`);
    case 'about':
      return note(`the screenplay overview page (title, synopsis, dialogue style) for "${title}"`);
    case 'notes':
      return note("the director's notes");
    case 'library':
      return note('the media library');
    case 'storyboard-index':
      return note("the storyboard index (all beats' storyboards)");
    case 'dialog-index':
      return note("the dialog index (all beats' dialogs)");
    default:
      return null;
  }
}
