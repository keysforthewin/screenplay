// CollabSurface
//
// Establishes the y-doc + Hocuspocus connection for an entity room and exposes
// it via context to descendant CollabField components. Also wires the
// stateless ping protocol — when the server broadcasts a {type:'fields_updated'}
// message, we call the parent-supplied onPing() so the page can refetch its
// REST data (image gallery, attachment list, plays_self toggle, etc.).

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { apiGet } from '../api.js';
import { usePresenceSetters } from './PresenceContext.jsx';
import { colorForUser } from './userColor.js';

const CollabContext = createContext(null);

export function useCollabRoom() {
  const ctx = useContext(CollabContext);
  if (!ctx) throw new Error('CollabField must be inside <CollabSurface>');
  return ctx;
}

export function CollabSurface({ room, session, onPing, children }) {
  const [provider, setProvider] = useState(null);
  const [ydoc, setYdoc] = useState(null);
  const [error, setError] = useState(null);
  const { setUsers, setSaveStatus } = usePresenceSetters();
  const onPingRef = useRef(onPing);
  onPingRef.current = onPing;

  useEffect(() => {
    if (!room || !session?.session_id) return;

    let cancelled = false;
    let nextProvider;
    let nextDoc;

    (async () => {
      let info;
      try {
        info = await apiGet('/info');
      } catch (e) {
        if (!cancelled) setError(`Could not fetch /api/info: ${e.message}`);
        return;
      }
      if (cancelled) return;

      const wsUrl = info.hocuspocus_url || `ws://${location.hostname}:3001`;
      nextDoc = new Y.Doc();
      nextProvider = new HocuspocusProvider({
        url: wsUrl,
        name: room,
        document: nextDoc,
        token: session.session_id,
        onAuthenticationFailed: ({ reason }) => {
          setError(`Auth failed: ${reason || 'unknown'}`);
        },
      });

      // Initial awareness — broadcasts our identity to other clients.
      nextProvider.setAwarenessField('user', {
        name: session.username,
        color: colorForUser(session.username),
      });

      // Track save status: every y-doc local update flips to 'saving' briefly,
      // then back to 'saved' after a debounce — the server-side persistence
      // tick runs ~2s after the last edit.
      let savedTimer;
      const onDocUpdate = (_update, origin) => {
        // 'origin' is null for local-typed edits, the provider for remote ones.
        // Only show "saving" for local edits — remote updates are already saved.
        if (origin === nextProvider) return;
        setSaveStatus({ state: 'saving', lastSaved: Date.now() });
        clearTimeout(savedTimer);
        savedTimer = setTimeout(() => {
          setSaveStatus({ state: 'saved', lastSaved: Date.now() });
        }, 2200);
      };
      nextDoc.on('update', onDocUpdate);
      nextProvider.on('synced', () => {
        setSaveStatus((s) => ({ state: 'saved', lastSaved: s.lastSaved || Date.now() }));
      });

      // Awareness → presence list for the header.
      nextProvider.on('awarenessUpdate', ({ states }) => {
        const list = (states || [])
          .map((s) => s.user)
          .filter(Boolean);
        setUsers(list);
      });

      // Stateless ping → parent refetches REST widgets.
      nextProvider.on('stateless', ({ payload }) => {
        try {
          const msg = typeof payload === 'string' ? JSON.parse(payload) : payload;
          if (msg?.type === 'fields_updated') {
            onPingRef.current?.(msg);
          }
        } catch {
          // ignore non-JSON messages
        }
      });

      if (cancelled) {
        nextProvider.destroy();
        nextDoc.destroy();
        return;
      }
      setProvider(nextProvider);
      setYdoc(nextDoc);
    })();

    return () => {
      cancelled = true;
      setUsers([]);
      setSaveStatus({ state: 'idle', lastSaved: null });
      try { nextProvider?.destroy(); } catch {}
      try { nextDoc?.destroy(); } catch {}
    };
  }, [room, session?.session_id, session?.username, setUsers, setSaveStatus]);

  if (error) {
    return <div className="error-banner">Collaboration error: {error}</div>;
  }
  if (!provider || !ydoc) {
    return <p style={{ color: 'var(--fg-muted)' }}>Connecting…</p>;
  }

  return (
    <CollabContext.Provider value={{ provider, ydoc, session }}>
      {children}
    </CollabContext.Provider>
  );
}
