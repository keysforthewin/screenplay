// web/src/tts/nowPlaying.js
// What the shared TTS controller is reading, kept at module level so playback
// belongs to the tab, not to a page: the Play buttons start it here, navigating
// anywhere in the app leaves it running, and the always-mounted mini player
// (widgets/TtsMiniPlayer.jsx) is where it is paused, skipped or stopped.
//   current = null | { kind: 'beat' | 'all', order, name }

import { getSharedController } from './controller.js';
import { getSavedVoice } from './voices.js';
import { startPlayAll } from './playAll.js';

let current = null;
let run = null; // the play-all run in flight, if any
const listeners = new Set();

function set(next) {
  current = next;
  for (const fn of listeners) fn(current);
}

export function getNowPlaying() { return current; }

export function subscribeNowPlaying(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Stop whatever is playing (a single beat or the whole read-through).
export function stopPlayback() {
  const r = run;
  run = null;
  if (r) r.stop();
  else getSharedController().stop();
  set(null);
}

// Read one beat aloud; replaces anything already playing.
export function playBeat({ order, name, text }) {
  stopPlayback();
  const mine = { kind: 'beat', order, name: name || '' };
  set(mine);
  getSharedController()
    .play(text, getSavedVoice())
    .finally(() => { if (current === mine) set(null); });
}

// Read every item in order (see playAll.js); replaces anything already playing.
export function playAllBeats({ items, fetchBody, toText }) {
  stopPlayback();
  const byOrder = new Map(items.map((i) => [i.order, i]));
  const mine = startPlayAll({
    items,
    fetchBody,
    controller: getSharedController(),
    voice: getSavedVoice(),
    toText,
    onBeat: (order) => {
      if (run !== mine || order == null) return;
      set({ kind: 'all', order, name: byOrder.get(order)?.name || '' });
    },
  });
  run = mine;
  set({ kind: 'all', order: null, name: '' });
  mine.promise.finally(() => {
    if (run !== mine) return;
    run = null;
    set(null);
  });
}

// Play-all only: jump to the next beat.
export function skipBeat() { run?.skip(); }
