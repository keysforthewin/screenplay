// Eleven v3 audio tags, curated from ElevenLabs' v3 prompting guide
// (https://elevenlabs.io/docs/best-practices/prompting — "Audio tags").
// Single source of truth: served to the SPA tag palette via GET
// /api/eleven/info and embedded in the Enhance system prompt. Names are
// stored WITHOUT brackets; render as [tag] at the point of use.

export const AUDIO_TAGS = {
  Emotions: [
    'excited', 'sad', 'angry', 'annoyed', 'thoughtful', 'surprised',
    'sarcastic', 'curious', 'nervously', 'mischievously', 'warmly',
    'dramatically', 'deadpan', 'cheerfully', 'somberly',
  ],
  Delivery: [
    'whispers', 'shouting', 'quietly', 'loudly', 'slowly', 'rushed',
    'drawn out', 'pause', 'long pause', 'singing',
  ],
  Reactions: [
    'laughs', 'laughs harder', 'starts laughing', 'giggles', 'chuckles',
    'sighs', 'exhales', 'gasps', 'gulps', 'groans', 'clears throat',
    'snorts', 'crying', 'sobbing', 'yawns', 'coughs',
  ],
};

export function flattenAudioTags() {
  return [...new Set(Object.values(AUDIO_TAGS).flat())];
}
