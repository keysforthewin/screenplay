// hocuspocus.js
//
// Wires the Hocuspocus collaboration server into the existing Node process.
//
// Responsibilities:
//   - Persist y-doc binary state in the `yjs_docs` Mongo collection.
//   - On first load of a room, seed each text fragment from its corresponding
//     Mongo entity field (markdown → editor doc).
//   - On every store tick, render each fragment back to markdown and write the
//     result into the entity row(s).
//   - Validate session tokens via the auth_sessions collection.
//
// One process-wide singleton. Started alongside Express in src/index.js.

import { config } from '../config.js';
import { logger } from '../log.js';
import { fetchYjsState, storeYjsState } from '../mongo/yjsDocs.js';
import { getSession, touchSession } from '../mongo/auth.js';
import { isManagedRoom, resolveRoom } from './roomRegistry.js';

let server;

async function makeServer() {
  const { Hocuspocus } = await import('@hocuspocus/server');
  const { Database } = await import('@hocuspocus/extension-database');
  const { fragmentToMarkdown, setFragmentMarkdown } = await import('./headlessEditor.js');
  return new Hocuspocus({
    port: config.web.hocuspocusPort,

    async onAuthenticate({ token, documentName }) {
      if (!isManagedRoom(documentName)) {
        throw new Error(`Unknown room: ${documentName}`);
      }
      const session = await getSession(token);
      if (!session) throw new Error('invalid session');
      // Refresh last_seen but don't await — auth check should be fast.
      touchSession(token).catch(() => {});
      return { user: { name: session.username, sessionId: session.session_id } };
    },

    extensions: [
      new Database({
        fetch: async ({ documentName }) => fetchYjsState(documentName),
        store: async ({ documentName, state }) => storeYjsState(documentName, state),
      }),
      {
        extensionName: 'EntitySync',
        priority: 50,

        // After Hocuspocus has loaded the y-doc binary state (or created an
        // empty doc), seed any fragments that are still empty from Mongo.
        // This makes the first connection to a fresh entity show the bot-
        // authored markdown immediately.
        async afterLoadDocument({ documentName, document }) {
          const desc = await resolveRoom(documentName).catch((e) => {
            logger.warn(`hocuspocus afterLoad resolve failed for ${documentName}: ${e.message}`);
            return null;
          });
          if (!desc) return;
          for (const field of desc.fields) {
            const fragment = document.getXmlFragment(field);
            // length === 0 → fresh fragment; safe to seed without trampling.
            if (fragment.length === 0 && desc.seed[field]) {
              try {
                setFragmentMarkdown(document, field, desc.seed[field]);
              } catch (e) {
                logger.warn(
                  `hocuspocus seed failed ${documentName}/${field}: ${e.message}`,
                );
              }
            }
          }
        },

        // On every store tick (Hocuspocus debounces writes), render every
        // fragment to markdown and persist any field whose text changed since
        // the last Mongo read.
        async onStoreDocument({ documentName, document }) {
          const desc = await resolveRoom(documentName).catch(() => null);
          if (!desc) return;
          const snapshot = {};
          for (const field of desc.fields) {
            try {
              snapshot[field] = fragmentToMarkdown(document, field);
            } catch (e) {
              logger.warn(
                `hocuspocus render failed ${documentName}/${field}: ${e.message}`,
              );
            }
          }
          try {
            const result = await desc.persistFields(snapshot);
            if (result.changed) {
              logger.info(
                `hocuspocus snapshot persisted ${documentName} fields=[${(result.fields || []).join(',')}]`,
              );
            }
          } catch (e) {
            logger.warn(`hocuspocus persist failed ${documentName}: ${e.message}`);
          }
        },
      },
    ],
  });
}

export async function startHocuspocus() {
  if (server) return server;
  server = await makeServer();
  await server.listen();
  logger.info(`Hocuspocus listening on port ${config.web.hocuspocusPort}`);
  return server;
}

export function getHocuspocus() {
  if (!server) throw new Error('Hocuspocus not started');
  return server;
}

export function isHocuspocusRunning() {
  return !!server;
}

// Look up the active Document for a room name. Returns null if no clients are
// currently connected (the doc is unloaded once the last client disconnects).
export function getRoomDocument(roomName) {
  if (!server) return null;
  return server.documents?.get(roomName) || null;
}

// Broadcast a stateless message to all connections in a room. No-op if the
// document has no live connections.
export function broadcastRoomStateless(roomName, payload) {
  const doc = getRoomDocument(roomName);
  if (!doc) return false;
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  doc.broadcastStateless(body);
  return true;
}

// Open a server-side connection to a room and run a transaction against its
// y-doc. The connection must be disconnected to flush the change to clients
// and persistence. Returns whatever the callback returned.
export async function withDirectDocument(roomName, contextOverrides, fn) {
  if (!server) throw new Error('Hocuspocus not started');
  const conn = await server.openDirectConnection(roomName, contextOverrides || {});
  try {
    let result;
    await conn.transact((document) => {
      result = fn(document);
    });
    return result;
  } finally {
    await conn.disconnect();
  }
}
