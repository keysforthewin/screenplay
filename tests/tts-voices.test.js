import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  VOICE_GROUPS, DEFAULT_VOICE, isKnownVoice, getSavedVoice, saveVoice,
} from '../web/src/tts/voices.js';

function stubStorage() {
  const store = new Map();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
  });
  return store;
}

describe('tts voices', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists 28 known English voices across 4 groups, default first', () => {
    expect(VOICE_GROUPS).toHaveLength(4);
    const all = VOICE_GROUPS.flatMap((g) => g.voices.map((v) => v.id));
    expect(all).toHaveLength(28);
    expect(new Set(all).size).toBe(28);
    expect(all[0]).toBe(DEFAULT_VOICE);
    expect(isKnownVoice('af_heart')).toBe(true);
    expect(isKnownVoice('nope')).toBe(false);
  });

  it('round-trips a saved voice through localStorage', () => {
    const store = stubStorage();
    saveVoice('bf_emma');
    expect(store.get('screenplay_tts_voice_v1')).toBe('bf_emma');
    expect(getSavedVoice()).toBe('bf_emma');
  });

  it('falls back to the default on unknown/missing/broken storage', () => {
    const store = stubStorage();
    expect(getSavedVoice()).toBe(DEFAULT_VOICE);      // missing
    store.set('screenplay_tts_voice_v1', 'garbage');
    expect(getSavedVoice()).toBe(DEFAULT_VOICE);      // unknown id
    saveVoice('garbage');                              // rejected write
    expect(store.get('screenplay_tts_voice_v1')).toBe('garbage'); // unchanged
    vi.unstubAllGlobals();                             // no window at all (node)
    expect(getSavedVoice()).toBe(DEFAULT_VOICE);
    expect(() => saveVoice('af_bella')).not.toThrow();
  });
});
