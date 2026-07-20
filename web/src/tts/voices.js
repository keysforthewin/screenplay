// Kokoro-82M v1.0 English voice catalog. Groups are US/UK female/male; voices
// are ordered best-graded first within each group (grades from the Kokoro
// model card). The letter grade is shown in the picker so users can tell the
// good ones from the filler.

export const VOICE_GROUPS = [
  {
    label: 'American female',
    voices: [
      { id: 'af_heart', label: 'Heart (A)' },
      { id: 'af_bella', label: 'Bella (A-)' },
      { id: 'af_nicole', label: 'Nicole (B-)' },
      { id: 'af_aoede', label: 'Aoede (C+)' },
      { id: 'af_kore', label: 'Kore (C+)' },
      { id: 'af_sarah', label: 'Sarah (C+)' },
      { id: 'af_alloy', label: 'Alloy (C)' },
      { id: 'af_nova', label: 'Nova (C)' },
      { id: 'af_sky', label: 'Sky (C-)' },
      { id: 'af_jessica', label: 'Jessica (D)' },
      { id: 'af_river', label: 'River (D)' },
    ],
  },
  {
    label: 'American male',
    voices: [
      { id: 'am_fenrir', label: 'Fenrir (C+)' },
      { id: 'am_michael', label: 'Michael (C+)' },
      { id: 'am_puck', label: 'Puck (C+)' },
      { id: 'am_echo', label: 'Echo (D)' },
      { id: 'am_eric', label: 'Eric (D)' },
      { id: 'am_liam', label: 'Liam (D)' },
      { id: 'am_onyx', label: 'Onyx (D)' },
      { id: 'am_santa', label: 'Santa (D-)' },
      { id: 'am_adam', label: 'Adam (F+)' },
    ],
  },
  {
    label: 'British female',
    voices: [
      { id: 'bf_emma', label: 'Emma (B-)' },
      { id: 'bf_isabella', label: 'Isabella (C)' },
      { id: 'bf_alice', label: 'Alice (D)' },
      { id: 'bf_lily', label: 'Lily (D)' },
    ],
  },
  {
    label: 'British male',
    voices: [
      { id: 'bm_fable', label: 'Fable (C)' },
      { id: 'bm_george', label: 'George (C)' },
      { id: 'bm_lewis', label: 'Lewis (D+)' },
      { id: 'bm_daniel', label: 'Daniel (D)' },
    ],
  },
];

export const DEFAULT_VOICE = 'af_heart';

const STORAGE_KEY = 'screenplay_tts_voice_v1';

export function isKnownVoice(id) {
  return VOICE_GROUPS.some((g) => g.voices.some((v) => v.id === id));
}

export function getSavedVoice() {
  try {
    const v = window.localStorage?.getItem(STORAGE_KEY);
    return isKnownVoice(v) ? v : DEFAULT_VOICE;
  } catch {
    return DEFAULT_VOICE;
  }
}

export function saveVoice(id) {
  if (!isKnownVoice(id)) return;
  try {
    window.localStorage?.setItem(STORAGE_KEY, id);
  } catch {
    // storage unavailable — selection just won't persist
  }
}
