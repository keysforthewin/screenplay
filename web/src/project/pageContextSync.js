// Same-origin BroadcastChannel primitives that live-sync the editor window's
// "what page am I on" descriptor to the AI chat popup window. Pure (no React,
// no DOM globals): callers pass in the channel, so this is unit-testable in node
// and the React hooks in usePageContextSync.js are thin glue over it.
//
// Protocol on channel `screenplay-pagectx:<projectId>`:
//   editor  -> { type: 'pagectx', ctx }   (on navigation, on mount, and as a
//                                           reply to a 'request')
//   chat    -> { type: 'request' }         (on mount, to pull current state)
// The ctx shape matches pageContextFromPath: { kind, ref, label }.

export const OVERVIEW_CONTEXT = { kind: 'overview', ref: null, label: 'Overview' };

export function pagectxChannelName(projectId) {
  return `screenplay-pagectx:${projectId}`;
}

// Editor side. `getCtx` returns the current page context at call time.
export function createPageContextBroadcaster(channel, getCtx) {
  const post = () => channel.postMessage({ type: 'pagectx', ctx: getCtx() });
  const onMessage = (ev) => {
    if (ev?.data?.type === 'request') post();
  };
  channel.addEventListener('message', onMessage);
  return {
    post,
    stop: () => channel.removeEventListener('message', onMessage),
  };
}

// Chat side. Calls `onCtx` for every received context; returns a stop function.
export function createPageContextReceiver(channel, onCtx) {
  const onMessage = (ev) => {
    if (ev?.data?.type === 'pagectx' && ev.data.ctx) onCtx(ev.data.ctx);
  };
  channel.addEventListener('message', onMessage);
  channel.postMessage({ type: 'request' });
  return () => channel.removeEventListener('message', onMessage);
}
