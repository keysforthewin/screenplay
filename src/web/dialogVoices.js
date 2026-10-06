// Which speakers of a project have an ElevenLabs voice (characters.eleven_voice),
// and what that means for the dialogue text: a voiced speaker's lines carry
// Eleven v4 audio tags, everyone else's are plain (src/eleven/dialogTags.js).
// A line can also carry its own voice (dialogs.eleven_voice), which outranks
// the character's and voices a line whose speaker is no character at all.
//
// Shared by every pass that writes a dialog body (generate, per-line
// regenerate, the batch edit) and by the voice batch that renders them
// (dialogVoiceGenerate.js).

import { listCharacters } from '../mongo/characters.js';
import { stripMarkdown } from '../util/markdown.js';
import { AUDIO_TAG_RULES, stripAudioTags } from '../eleven/dialogTags.js';

function speakerKey(name) {
  return stripMarkdown(name || '').trim().toLowerCase();
}

// Map of lower-cased stripped character name → { character_id, name, voice_id, voice_name }.
export async function loadVoiceCast(projectId) {
  const cast = new Map();
  const characters = await listCharacters(projectId).catch(() => []);
  for (const c of characters || []) {
    const voiceId = c?.eleven_voice?.voice_id;
    const key = speakerKey(c?.name);
    if (!voiceId || !key) continue;
    cast.set(key, {
      character_id: String(c._id),
      name: stripMarkdown(c.name || '').trim(),
      voice_id: String(voiceId),
      voice_name: c.eleven_voice.name || '',
      preview_url: c.eleven_voice.preview_url || null,
    });
  }
  return cast;
}

export function voiceForSpeaker(cast, speaker) {
  return cast?.get(speakerKey(speaker)) || null;
}

// The voice a stored line is spoken with: its own, else its speaker's.
export function voiceForDialog(cast, dialog) {
  const own = dialog?.eleven_voice;
  if (own?.voice_id) {
    return {
      character_id: null,
      name: stripMarkdown(dialog.character || '').trim(),
      voice_id: String(own.voice_id),
      voice_name: own.name || '',
      preview_url: own.preview_url || null,
      line_voice: true,
    };
  }
  return voiceForSpeaker(cast, dialog?.character);
}

// What a line with its own voice is marked with in a prompt's line list when
// its speaker is not one of the voiced characters.
export const VOICED_LINE_MARK = '(VOICED LINE)';

export function hasOwnVoiceOutsideCast(cast, dialog) {
  return Boolean(dialog?.eleven_voice?.voice_id) && !voiceForSpeaker(cast, dialog.character);
}

// The prompt block that turns audio tags on for the voiced speakers. Empty
// when nobody has a voice — the writers then keep their plain-line rules.
// `voicedLines`: the prompt's line list marks lines that have their own voice.
export function audioTagPromptSection(cast, { voicedLines = false } = {}) {
  if (!cast?.size && !voicedLines) return '';
  const names = [...(cast?.values() || [])].map((v) => v.name);
  return [
    '# Voice performance — ElevenLabs audio tags',
    AUDIO_TAG_RULES,
    '',
    ...(names.length ? [`VOICED speakers (write audio tags into their lines): ${names.join(', ')}`] : []),
    ...(voicedLines
      ? [`A line marked ${VOICED_LINE_MARK} has a voice of its own: write audio tags into it, whoever speaks it. Never write the mark itself.`]
      : []),
    names.length ? 'Every other speaker: no tags.' : 'Every other line: no tags.',
  ].join('\n');
}

// The rule in code: a line whose speaker has no voice never keeps a tag.
// `dialog` is the stored line the body is for, when there is one — its own
// voice counts.
export function applyVoiceTagPolicy(cast, speaker, body, dialog = null) {
  if (dialog?.eleven_voice?.voice_id || voiceForSpeaker(cast, speaker)) return body;
  return stripAudioTags(body);
}

// What GET /dialogs hands the page: one row per voiced character.
export function voiceCastView(cast) {
  return [...(cast?.values() || [])].map((v) => ({
    character: v.name,
    voice_id: v.voice_id,
    voice_name: v.voice_name,
    preview_url: v.preview_url || null,
  }));
}
