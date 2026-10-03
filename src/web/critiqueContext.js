// Assemble the shared context a critique run feeds to every facet.
// Cheap: reuses plot synopsis + the ordered beat spine (name/desc already on the
// plot doc) rather than re-summarizing every body. Steering documents
// (director's notes, directorial voice, scene bible, dialogue style, sets)
// are loaded best-effort: a failure returns an empty value, never a crash.

import { getPlot, listBeats } from '../mongo/plots.js';
import { getDirectorNotes } from '../mongo/directorNotes.js';
import { getCharacter } from '../mongo/characters.js';
import { renderSceneBibleBlock } from '../mongo/sceneBible.js';
import { stripMarkdown } from '../util/markdown.js';
import { SCREENPLAY_STYLE_GUIDE } from '../agent/screenplayStyle.js';
import { findSetsInBeat, loadDirectorialVoice } from './beatPlanShared.js';

async function loadDirectorNotes(projectId) {
  try {
    const doc = await getDirectorNotes(projectId);
    return Array.isArray(doc?.notes) ? doc.notes : [];
  } catch {
    return []; // notes are guidance, not load-bearing
  }
}

async function charactersInBeat(projectId, beat) {
  const out = [];
  for (const raw of beat?.characters || []) {
    const name = stripMarkdown(raw || '').trim();
    if (!name) continue;
    try {
      const c = await getCharacter(projectId, name);
      if (c) out.push(c);
    } catch {
      // skip unresolved names
    }
  }
  return out;
}

async function setsInBeat(projectId, beat) {
  try {
    return await findSetsInBeat(projectId, beat);
  } catch {
    return [];
  }
}

function sceneBibleText(beat) {
  try {
    return renderSceneBibleBlock(beat?.scene_bible) || null;
  } catch {
    return null;
  }
}

export async function buildCritiqueContext(projectId, beat) {
  const plot = await getPlot(projectId);
  const beats = await listBeats(projectId); // already sorted by order
  const idx = beats.findIndex((b) => b._id && beat._id && b._id.equals(beat._id));
  if (idx === -1) {
    throw new Error(`buildCritiqueContext: beat ${beat?._id} not found in project ${projectId}`);
  }
  const prevBeat = idx > 0 ? beats[idx - 1] : null;
  const nextBeat = idx >= 0 && idx < beats.length - 1 ? beats[idx + 1] : null;
  const spine = beats.map((b) => ({ order: b.order, name: b.name, desc: b.desc }));
  const directorNotes = await loadDirectorNotes(projectId);
  const characters = await charactersInBeat(projectId, beat);
  const sets = await setsInBeat(projectId, beat);
  const directorialVoice = await loadDirectorialVoice(projectId);
  return {
    beat,
    prevBeat,
    nextBeat,
    plot: {
      title: plot.title || '',
      synopsis: plot.synopsis || '',
      dialogue_style: typeof plot.dialogue_style === 'string' ? plot.dialogue_style : '',
    },
    spine,
    directorNotes,
    directorialVoice,
    sceneBible: sceneBibleText(beat),
    characters,
    sets,
    styleGuide: SCREENPLAY_STYLE_GUIDE,
  };
}
