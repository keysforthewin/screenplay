// Thin worker shell around the shared Kokoro engine (kokoroEngine.js owns
// all synthesis logic and the kokoro-js import; ttsTransport.js decides
// whether the engine runs here or inline on the main thread).
//
// Protocol: see web/src/tts/kokoroEngine.js.

import { createKokoroEngine } from './kokoroEngine.js';

const engine = createKokoroEngine((msg, transfer) => postMessage(msg, transfer));

self.onmessage = (e) => engine.handle(e.data);
