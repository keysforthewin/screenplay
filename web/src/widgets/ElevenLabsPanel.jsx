import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPostJson, attachmentUrl } from '../api.js';
import { AudioTagPalette } from './AudioTagPalette.jsx';
import { ElevenVoiceSection } from './ElevenVoiceSection.jsx';
import { ElevenAudioInput } from './ElevenAudioInput.jsx';

// ElevenLabs playground: TTS with v3 audio tags, voice changer, voice
// isolator, speech-to-text — plus the project's voice collection with
// library browse / clone / design. Endpoints are synchronous; `busy` gates
// the single in-flight request.

const VOICE_STORAGE_KEY = 'screenplay.playground.eleven_voice';

const TOOLS = [
  ['tts', 'Text to Speech'],
  ['changer', 'Voice Changer'],
  ['isolate', 'Voice Isolator'],
  ['stt', 'Speech to Text'],
];

const TTS_MODELS = [
  ['eleven_v3', 'Eleven v3 (audio tags)'],
  ['eleven_multilingual_v2', 'Multilingual v2'],
  ['eleven_turbo_v2_5', 'Turbo v2.5'],
  ['eleven_flash_v2_5', 'Flash v2.5'],
];

export function ElevenLabsPanel() {
  const [info, setInfo] = useState(null);
  const [infoError, setInfoError] = useState(null);
  const [tool, setTool] = useState('tts');
  const [voices, setVoices] = useState([]);
  const [activeVoiceId, setActiveVoiceId] = useState(() => {
    try { return localStorage.getItem(VOICE_STORAGE_KEY) || null; } catch { return null; }
  });
  const [text, setText] = useState('');
  const [preEnhanceText, setPreEnhanceText] = useState(null);
  const [modelId, setModelId] = useState('eleven_v3');
  const [audioRef, setAudioRef] = useState(null); // { file_id, filename }
  const [busy, setBusy] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [error, setError] = useState(null);
  const [results, setResults] = useState([]);
  const textareaRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiGet('/eleven/info');
        if (!cancelled) setInfo(r);
      } catch (e) {
        if (!cancelled) setInfoError(e.message);
      }
    })();
    refreshVoices();
    return () => { cancelled = true; };
  }, []);

  async function refreshVoices() {
    try {
      const r = await apiGet('/eleven/collection');
      setVoices(r.voices || []);
    } catch (e) {
      setError(e.message);
    }
  }

  function selectVoice(voiceId) {
    setActiveVoiceId(voiceId);
    try { localStorage.setItem(VOICE_STORAGE_KEY, voiceId || ''); } catch { /* ignore */ }
  }

  const activeVoice = voices.find((v) => v.voice_id === activeVoiceId) || null;
  const needsVoice = tool === 'tts' || tool === 'changer';
  const needsAudio = tool === 'changer' || tool === 'isolate' || tool === 'stt';

  function insertTag(tagText) {
    const ta = textareaRef.current;
    if (!ta) {
      setText((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${tagText} `);
      return;
    }
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? start;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const glueL = before && !/\s$/.test(before) ? ' ' : '';
    const glueR = after && !/^\s/.test(after) ? ' ' : '';
    const next = `${before}${glueL}${tagText}${glueR}${after}`;
    setText(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = (before + glueL + tagText + glueR).length;
      ta.setSelectionRange(pos, pos);
    });
  }

  async function enhance() {
    if (!text.trim() || enhancing) return;
    setError(null);
    setEnhancing(true);
    try {
      const r = await apiPostJson('/eleven/enhance', { text });
      setPreEnhanceText(text);
      setText(r.text);
    } catch (e) {
      setError(e.message);
    } finally {
      setEnhancing(false);
    }
  }

  function undoEnhance() {
    if (preEnhanceText != null) {
      setText(preEnhanceText);
      setPreEnhanceText(null);
    }
  }

  const ready = !busy && info?.configured
    && (!needsVoice || activeVoice)
    && (!needsAudio || audioRef)
    && (tool !== 'tts' || text.trim().length > 0);

  const missing = [];
  if (needsVoice && !activeVoice) missing.push('a voice from your collection');
  if (needsAudio && !audioRef) missing.push('an audio file or recording');
  if (tool === 'tts' && !text.trim()) missing.push('some text');

  async function generate() {
    if (!ready) return;
    setError(null);
    setBusy(true);
    try {
      let r;
      if (tool === 'tts') {
        r = await apiPostJson('/eleven/tts', { voice_id: activeVoiceId, text: text.trim(), model_id: modelId });
      } else if (tool === 'changer') {
        r = await apiPostJson('/eleven/voice-changer', { voice_id: activeVoiceId, ref: { file_id: audioRef.file_id } });
      } else if (tool === 'isolate') {
        r = await apiPostJson('/eleven/isolate', { ref: { file_id: audioRef.file_id } });
      } else {
        r = await apiPostJson('/eleven/stt', { ref: { file_id: audioRef.file_id } });
      }
      const toolLabel = TOOLS.find(([id]) => id === tool)?.[1] || tool;
      setResults((prev) => [
        ...(r.outputs || []).map((o) => ({
          ...o,
          tool: toolLabel,
          transcript: r.transcript || null,
          prompt: tool === 'tts' ? text.trim() : null,
          at: Date.now(),
        })),
        ...prev,
      ]);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="eleven-panel">
      {infoError && <div className="error-banner">{infoError}</div>}
      {info && !info.configured && (
        <div className="error-banner">
          ElevenLabs is not configured on the server (ELEVEN_LABS_KEY missing) — this tab is disabled.
        </div>
      )}
      {error && <div className="error-banner">{error}</div>}

      <div className="tab-nav eleven-tool-nav" role="tablist">
        {TOOLS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tool === id}
            className={`tab-button${tool === id ? ' is-active' : ''}`}
            onClick={() => setTool(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {(tool === 'tts' || tool === 'changer') && (
        <ElevenVoiceSection
          voices={voices}
          activeVoiceId={activeVoiceId}
          onSelect={selectVoice}
          onRefresh={refreshVoices}
        />
      )}

      {tool === 'tts' && (
        <div className="eleven-tts">
          <div className="eleven-tts-toolbar">
            <label className="field-label" htmlFor="eleven-text">Text</label>
            <select value={modelId} onChange={(e) => setModelId(e.target.value)}>
              {TTS_MODELS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
            <button type="button" disabled={!text.trim() || enhancing} onClick={enhance}>
              {enhancing ? 'Enhancing…' : '✨ Enhance'}
            </button>
            {preEnhanceText != null && (
              <button type="button" onClick={undoEnhance}>Undo enhance</button>
            )}
          </div>
          <textarea
            id="eleven-text"
            ref={textareaRef}
            rows={10}
            value={text}
            placeholder="Type or paste the text to speak. Click tags below (or ✨ Enhance) to add [laughs], [whispers], [sarcastic]…"
            onChange={(e) => { setText(e.target.value); setPreEnhanceText(null); }}
          />
          {modelId === 'eleven_v3' && <AudioTagPalette tags={info?.tags} onInsert={insertTag} />}
        </div>
      )}

      {needsAudio && (
        <>
          <label className="field-label">
            {tool === 'changer' ? 'Audio to convert' : tool === 'isolate' ? 'Audio to clean up' : 'Audio to transcribe'}
          </label>
          <ElevenAudioInput value={audioRef} onChange={setAudioRef} />
        </>
      )}

      <div className="playground-generate-row">
        <button
          type="button"
          className="primary"
          disabled={!ready}
          title={missing.length ? `Need: ${missing.join(', ')}` : ''}
          onClick={generate}
        >
          {busy ? 'Working…' : 'Generate'}
        </button>
      </div>

      {results.length > 0 && (
        <div className="playground-results">
          <h2>Results</h2>
          {results.map((r) => (
            <div key={`${r.file_id}-${r.at}`} className="playground-result">
              {r.kind === 'audio' && (
                <audio controls src={attachmentUrl(r.file_id)} preload="metadata" />
              )}
              {r.transcript && (
                <div className="eleven-transcript">
                  <p>{r.transcript}</p>
                  <button
                    type="button"
                    onClick={() => navigator.clipboard?.writeText(r.transcript)}
                  >
                    Copy transcript
                  </button>
                </div>
              )}
              <div className="playground-result-meta">
                <span className="playground-result-model">{r.tool}</span>
                {r.prompt && <span className="playground-result-prompt">{r.prompt}</span>}
                <a href={attachmentUrl(r.file_id)} download>Download</a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
