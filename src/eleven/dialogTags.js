// Eleven v4 audio tags in screenplay dialogue. Pure: no I/O.
//
// A dialog line's `body` carries its performance inline as square-bracket
// audio tags — "[low, threatening] You should not have come. [long pause]
// [exhales] Sit." — when the speaker's character has an ElevenLabs voice
// assigned (characters.eleven_voice). The tags are what Eleven v4 reads as
// direction; the words outside them are what is spoken. A speaker with no
// voice gets plain lines: nothing would ever read the tags.
//
// Source: https://elevenlabs.io/docs/overview/capabilities/text-to-speech/eleven-v4
// and https://elevenlabs.io/blog/emotional-text-to-speech-with-eleven-v4.

import { stripMarkdown } from '../util/markdown.js';

export const DIALOG_TTS_MODEL = 'eleven_v4';
// eleven_v4's per-request limit (GET /v1/models, maximum_text_length_per_request).
export const DIALOG_TTS_MAX_CHARS = 10_000;

// A bracketed tag, written plainly or markdown-escaped (\[sighs\]) — but not
// the text of a markdown link ([text](url)).
const TAG_RE = /\\?\[[^\[\]\n]{1,80}?\\?\](?!\()/g;

export function hasAudioTags(text) {
  TAG_RE.lastIndex = 0;
  return TAG_RE.test(String(text || ''));
}

/** The line with every audio tag removed — what is actually spoken. */
export function stripAudioTags(text) {
  return String(text || '')
    .replace(TAG_RE, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.;:!?…])/g, '$1')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .trim();
}

/** What is sent to ElevenLabs for a stored (markdown) body: plain text, tags kept. */
export function dialogSpeechText(body) {
  return stripMarkdown(body || '').trim();
}

// The tag-writing rules every dialogue-writing prompt gets. Eleven v4 takes
// free-form directions, so this is a vocabulary to draw on, not a whitelist.
export const AUDIO_TAG_RULES = [
  'These lines are performed by ElevenLabs Eleven v4 voice actors. For the speakers listed as VOICED,',
  'write the performance INTO the line as audio tags: short directions in square brackets that the',
  'voice model acts on and never reads aloud. Everything outside the brackets is spoken exactly as',
  'written.',
  '',
  'What a tag can be (Eleven v4 takes free-form directions — these are examples, not a whitelist):',
  '- Emotion: [furious] [worried] [ecstatic] [annoyed] [sarcastic] [hesitant] [nervous] [terrified]',
  '  [deadpan] [wistful] [smug] [relieved] [ashamed] [tender]',
  '- Delivery: [whispering] [shouting] [quietly] [measured] [rushed] [slowly] [flat] [under her breath]',
  '  [through gritted teeth] [voice breaking] [mock-cheerful] [trailing off]',
  '- Compound directions in your own words: [low, threatening] [tense, cautious] [whispering, fearful]',
  '  [dry, quietly pleased] [quick, light, playful pace] [lower, thoughtful]',
  '- Non-verbal reactions the actor makes: [laughs] [chuckles] [scoffs] [sighs] [exhales] [gasps] [gulps]',
  '  [sniffs] [clears throat] [groans] [crying] [sobbing] [yawns] [evil laugh]',
  '- Timing: [pause] [long pause] [beat] [silence]',
  '',
  'How to direct with them:',
  '- Open every voiced line with a tag that sets how it is played — the model carries that tone across',
  '  the line. Derive it from the scene: the speaker\'s objective, the subtext, what just happened.',
  '- Put a new tag immediately BEFORE the exact clause where the delivery turns. A line that turns',
  '  should have a tag at the turn; a short line played one way needs only its opening tag.',
  '- One direction per clause. Do not stack contrasting emotions on the same words; a compound tag',
  '  like [low, threatening] is one direction.',
  '- Play the SUBTEXT, not the words: a character who says "I\'m fine" [voice breaking] is the point.',
  '  Prefer the specific, playable direction ([too casual], [stalling]) to the generic one ([sad]).',
  '- Use reactions and pauses where a person would actually make them — a breath before the hard',
  '  thing, a laugh that covers fear. Not as decoration on every line.',
  '- Shape pacing with punctuation as well: ellipses slow a line down… a dash cuts the speaker off —',
  '  and an exclamation mark adds intensity. CAPITALS stress a single word.',
  '- Tags are for the VOICE only. No physical action, blocking or camera ([crosses the room],',
  '  [looks away]) and no sound effects of the world ([door slams]) — those belong to the picture.',
  '- Tags are lower case, in square brackets, in English, never spoken, never quoted.',
  '',
  'Speakers NOT listed as voiced (no ElevenLabs voice assigned, or a non-character source such as a',
  'radio): write their lines with NO square-bracket tags at all — plain spoken words only.',
].join('\n');
