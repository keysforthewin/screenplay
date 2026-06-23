// React glue over pageContextSync.js. The editor window uses
// useBroadcastPageContext to publish its current route; the chat popup uses
// useReceivedPageContext to follow it. Both no-op gracefully where
// BroadcastChannel is unavailable (the chat window then shows Overview).
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { pageContextFromPath } from './pageContext.js';
import {
  OVERVIEW_CONTEXT,
  pagectxChannelName,
  createPageContextBroadcaster,
  createPageContextReceiver,
} from './pageContextSync.js';

export function useBroadcastPageContext(projectId) {
  const location = useLocation();
  const ctx = pageContextFromPath(location.pathname);
  // Keep the latest ctx in a ref so the broadcaster's request-reply always
  // reads the current value without re-subscribing the channel each nav.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const apiRef = useRef(null);

  useEffect(() => {
    if (!projectId || typeof BroadcastChannel === 'undefined') return undefined;
    const channel = new BroadcastChannel(pagectxChannelName(projectId));
    const api = createPageContextBroadcaster(channel, () => ctxRef.current);
    apiRef.current = api;
    api.post(); // announce current page to any already-open chat window
    return () => {
      api.stop();
      channel.close();
      apiRef.current = null;
    };
  }, [projectId]);

  // Re-broadcast whenever the page identity changes.
  useEffect(() => {
    apiRef.current?.post();
  }, [ctx.kind, ctx.ref]);
}

export function useReceivedPageContext(projectId) {
  const [ctx, setCtx] = useState(OVERVIEW_CONTEXT);
  useEffect(() => {
    if (!projectId || typeof BroadcastChannel === 'undefined') return undefined;
    const channel = new BroadcastChannel(pagectxChannelName(projectId));
    const stop = createPageContextReceiver(channel, setCtx);
    return () => {
      stop();
      channel.close();
    };
  }, [projectId]);
  return ctx;
}
