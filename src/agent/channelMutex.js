import { keyedMutex } from '../util/mutex.js';

// Single shared per-channel mutex. Discord message handling and web chat
// runs both serialize through this instance keyed by the Discord channel id —
// they share one message history, so two turns interleaving would corrupt
// transcript ordering and race the agent's read-then-write state.
export const channelMutex = keyedMutex();
