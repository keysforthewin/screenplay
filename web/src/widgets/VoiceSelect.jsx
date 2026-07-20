// web/src/widgets/VoiceSelect.jsx
// Narration voice picker for the TTS Play buttons. Self-contained: reads and
// persists the choice in localStorage; PlayBeatButton/PlayAllButton read the
// saved voice at click time, so no prop threading is needed.
import { useState } from 'react';
import { VOICE_GROUPS, getSavedVoice, saveVoice } from '../tts/voices.js';

export function VoiceSelect() {
  const [voice, setVoice] = useState(getSavedVoice);
  return (
    <select
      value={voice}
      aria-label="Narration voice"
      title="Narration voice"
      onChange={(e) => {
        setVoice(e.target.value);
        saveVoice(e.target.value);
      }}
    >
      {VOICE_GROUPS.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.voices.map((v) => (
            <option key={v.id} value={v.id}>{v.label}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
