// Subscribe to a Hocuspocus room's stateless {type:'fields_updated'} pings
// WITHOUT rendering an editor. CollabSurface does this too, but it also mounts
// awareness/presence and expects CollabField children — this is the bare
// listen-only version, used by pages (e.g. the TOC) that just need to refetch
// REST data when the server signals a change.
import { useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { apiGet } from '../api.js';

export function useRoomBroadcast(room, session, onBroadcast) {
  const cbRef = useRef(onBroadcast);
  cbRef.current = onBroadcast;

  useEffect(() => {
    if (!room || !session?.session_id) return undefined;
    let cancelled = false;
    let provider;
    let doc;
    (async () => {
      let info;
      try {
        info = await apiGet('/info');
      } catch {
        return; // best-effort: no live updates if /info is unreachable
      }
      if (cancelled) return;
      const wsUrl = info.hocuspocus_url || `ws://${location.hostname}:3001`;
      doc = new Y.Doc();
      provider = new HocuspocusProvider({
        url: wsUrl,
        name: room,
        document: doc,
        token: session.session_id,
      });
      provider.on('stateless', ({ payload }) => {
        try {
          const msg = typeof payload === 'string' ? JSON.parse(payload) : payload;
          if (msg?.type === 'fields_updated') cbRef.current?.(msg);
        } catch {
          // ignore non-JSON messages
        }
      });
    })();
    return () => {
      cancelled = true;
      try { provider?.destroy(); } catch { /* noop */ }
      try { doc?.destroy(); } catch { /* noop */ }
    };
  }, [room, session?.session_id]);
}
