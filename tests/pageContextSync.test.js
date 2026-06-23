// pageContextSync.js holds the BroadcastChannel messaging primitives for
// live-syncing the editor's page context to the chat popup window. Tested with
// a fake channel (plain object) so no real BroadcastChannel/global is needed.
import { describe, it, expect, vi } from 'vitest';
import {
  OVERVIEW_CONTEXT,
  pagectxChannelName,
  createPageContextBroadcaster,
  createPageContextReceiver,
} from '../web/src/project/pageContextSync.js';

// Minimal stand-in for a BroadcastChannel: records posts and lets the test
// deliver a message to all registered 'message' listeners.
function makeFakeChannel() {
  const listeners = new Set();
  return {
    posted: [],
    postMessage(msg) { this.posted.push(msg); },
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
    deliver(data) { for (const fn of listeners) fn({ data }); },
  };
}

describe('pageContextSync', () => {
  it('builds a project-scoped channel name', () => {
    expect(pagectxChannelName('abc123')).toBe('screenplay-pagectx:abc123');
  });

  it('OVERVIEW_CONTEXT is the default page descriptor', () => {
    expect(OVERVIEW_CONTEXT).toEqual({ kind: 'overview', ref: null, label: 'Overview' });
  });

  it('broadcaster.post() sends the current context', () => {
    const ch = makeFakeChannel();
    const ctx = { kind: 'beat', ref: '3', label: 'Beat 3' };
    const b = createPageContextBroadcaster(ch, () => ctx);
    b.post();
    expect(ch.posted).toEqual([{ type: 'pagectx', ctx }]);
    b.stop();
  });

  it('broadcaster replies to a request with the current context', () => {
    const ch = makeFakeChannel();
    let ctx = { kind: 'overview', ref: null, label: 'Overview' };
    const b = createPageContextBroadcaster(ch, () => ctx);
    ctx = { kind: 'character', ref: 'Steve', label: 'Character: Steve' };
    ch.deliver({ type: 'request' });
    expect(ch.posted).toEqual([{ type: 'pagectx', ctx }]);
    b.stop();
  });

  it('broadcaster.stop() removes the request listener', () => {
    const ch = makeFakeChannel();
    const b = createPageContextBroadcaster(ch, () => OVERVIEW_CONTEXT);
    b.stop();
    ch.deliver({ type: 'request' });
    expect(ch.posted).toEqual([]);
  });

  it('receiver requests on start and forwards pagectx updates', () => {
    const ch = makeFakeChannel();
    const onCtx = vi.fn();
    const stop = createPageContextReceiver(ch, onCtx);
    expect(ch.posted).toEqual([{ type: 'request' }]);
    const ctx = { kind: 'beat', ref: '5', label: 'Beat 5' };
    ch.deliver({ type: 'pagectx', ctx });
    expect(onCtx).toHaveBeenCalledWith(ctx);
    stop();
    ch.deliver({ type: 'pagectx', ctx: { kind: 'notes', ref: null, label: 'Notes' } });
    expect(onCtx).toHaveBeenCalledTimes(1);
  });

  it('receiver ignores its own request echoes and malformed messages', () => {
    const ch = makeFakeChannel();
    const onCtx = vi.fn();
    createPageContextReceiver(ch, onCtx);
    ch.deliver({ type: 'request' });
    ch.deliver({ type: 'pagectx' }); // no ctx
    ch.deliver(null);
    expect(onCtx).not.toHaveBeenCalled();
  });
});
