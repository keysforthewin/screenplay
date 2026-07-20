// web/src/tts/playAll.js
// TOC full read-through: play each beat in sequence — spoken chapter
// announcement, then body — prefetching the next beat's markdown while the
// current one plays so transitions are gapless. The item list is a snapshot:
// reordering beats mid-listen never reshuffles an in-flight run.

export function startPlayAll({ items, fetchBody, controller, voice, toText, onBeat }) {
  let stopped = false;
  const bodies = new Map(); // order → Promise<markdown|null>

  const fetchFor = (item) => {
    if (!bodies.has(item.order)) {
      bodies.set(
        item.order,
        Promise.resolve()
          .then(() => fetchBody(item.order))
          .catch((e) => {
            console.warn(`TTS read-through: failed to fetch beat #${item.order}`, e);
            return null;
          }),
      );
    }
    return bodies.get(item.order);
  };

  const promise = (async () => {
    for (let i = 0; i < items.length; i += 1) {
      if (stopped) break;
      const item = items[i];
      const bodyMd = await fetchFor(item);
      if (stopped) break;
      if (items[i + 1]) fetchFor(items[i + 1]); // prefetch during playback
      if (bodyMd == null) continue; // fetch failed — skip this beat
      const bodyText = toText(bodyMd);
      if (!bodyText) continue; // nothing to read — no announcement either
      onBeat?.(item.order);
      // play() resolves false on skip/stop; the loop just advances (skip) or
      // exits via the stopped flag (stop).
      await controller.play(`Beat ${item.order}: ${item.name || 'Untitled'}.\n\n${bodyText}`, voice);
    }
    onBeat?.(null);
  })();

  return {
    promise,
    skip() { controller.stop(); },                    // current play resolves; loop advances
    stop() { stopped = true; controller.stop(); },    // loop exits at the next check
  };
}
